import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { semanticRuntimeFixture, type SemanticRuntimeFixture } from "./maintenance-runtime-fixture";
import type { CheckRun, ControllerPolicy, ReleasePin, WorkerObservation, WorkerStartReceipt } from "../scripts/maintenance/contracts";
import { Controller, type ControllerContext } from "../scripts/maintenance/controller";
import type { GithubPort, PrObservation, ReleaseState } from "../scripts/maintenance/github";
import { GitHub } from "../scripts/maintenance/github";
import { Journal } from "../scripts/maintenance/journal";
import { Orca, type OrcaPort, type TaskSpecRequest, type WorkerRow, type WorkerStatus, type WorkerDelivery } from "../scripts/maintenance/orca";
import { type ReportRequest } from "../scripts/maintenance/report";
import { committedPaths, evidenceSet } from "../scripts/maintenance/tree";
import { changedEntries } from "../scripts/maintenance/tree";
import { catalogFromSource } from "../scripts/maintenance/semantic";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";
import { buildMarketplaceCatalog, sha256Bytes, validateMarketplaceCatalog } from "../scripts/marketplace-catalog";

/**
 * Сквозной прогон машины стадий контроллера на настоящих границах ввода-вывода.
 *
 * Репозиторий, `origin` (локальный bare), журнал и рабочие деревья — реальные файлы и реальный git. Подменены
 * только удалённые сервисы: GitHub и Orca представлены локальными службами-фикстурами, которые ведут
 * собственное состояние и отвергают операцию при расхождении репозитория, базы или головы, — это службы, а не
 * «эхо» ответов. Каждая мутация записывается, поэтому число фактических побочных эффектов проверяемо.
 *
 * Сети здесь нет: `origin` — каталог в temp, `registryLatest` — подставленная функция.
 */

const policy: ControllerPolicy = validatePolicy(rawPolicy);
/** Кандидат обязан быть версией из `baseline/supported-hosts.json`: иначе реальный `check-coverage.ts` не найдёт пару. */
const CANDIDATE = "18.8.7";
const PINNED = "18.8.4";

function git(cwd: string, args: readonly string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

interface PrRow {
  readonly number: number;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  draft: boolean;
  readonly state: string;
  merged: boolean;
  mergeSha?: string;
}

/** Локальная служба GitHub: состояние PR, ветвей, тегов и выпуска; отвергает несовпадение репозитория/базы/головы. */
class FixtureGithub implements GithubPort {
  readonly mutations: string[] = [];
  readonly remoteHeads = new Map<string, string>();
  readonly prs = new Map<number, PrRow>();
  readonly tags = new Map<string, string>();
  checkRuns: readonly CheckRun[] = [];
  /** Версии для автогенерации обязательных проверок по правилам политики (пусто — брать из `checkRuns`). */
  autoCheckVersions: readonly string[] = [];
  release: ReleaseState | undefined;
  workflowRunId: string | undefined;
  releaseProofDirectory: string | undefined;
  private nextNumber = 1;
  private readonly checkLogic = new GitHub(policy);

  constructor(private readonly origin: string, private readonly repository: string) {}

  async assertIdentity(): Promise<{ login: string; type: string }> {
    return { login: policy.controllerLogin, type: policy.controllerType };
  }

  private view(pr: PrRow): PrObservation {
    return {
      repository: this.repository, number: pr.number, branch: pr.branch, baseBranch: policy.baseBranch,
      baseSha: pr.merged ? git(this.origin, ["rev-parse", "refs/heads/main"]) : pr.baseSha,
      headSha: pr.headSha, author: policy.controllerLogin, authorType: policy.controllerType,
      draft: pr.draft, state: pr.state, merged: pr.merged, mergeSha: pr.mergeSha, changedPaths: [],
    };
  }

  async observePr(number: number): Promise<PrObservation> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error("unknown-pull-request");
    return this.view(pr);
  }

  async openPullRequests(): Promise<readonly PrObservation[]> {
    return [...this.prs.values()].filter(pr => pr.state === "open").map(pr => this.view(pr));
  }

  async remoteBranchHead(branch: string): Promise<string | undefined> {
    return this.remoteHeads.get(branch);
  }

  /** Отправка действительно доходит до локального `origin`; голова читается из него, а не выдумывается. */
  async pushRef(worktree: string, branch: string, headSha: string): Promise<void> {
    git(worktree, ["push", "-q", "origin", `${headSha}:refs/heads/${branch}`]);
    const remote = git(worktree, ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s+/)[0] ?? "";
    if (remote !== headSha) throw new Error("push-refused");
    this.remoteHeads.set(branch, remote);
    this.mutations.push(`push:${branch}:${remote}`);
  }

  async createDraft(branch: string, baseSha: string, headSha: string, _version: string): Promise<number> {
    if (this.remoteHeads.get(branch) !== headSha) throw new Error("head-not-pushed");
    if (git(this.origin, ["rev-parse", "refs/heads/main"]) !== baseSha) throw new Error("base-advanced");
    const number = this.nextNumber++;
    this.prs.set(number, { number, branch, baseSha, headSha, draft: true, state: "open", merged: false });
    this.mutations.push(`draft:${number}`);
    return number;
  }

  async markReady(number: number, expectedHead: string): Promise<void> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error("unknown-pull-request");
    if (pr.headSha !== expectedHead) throw new Error("stale-head");
    pr.draft = false;
    this.mutations.push(`ready:${number}`);
  }

  async checksFor(headSha: string): Promise<readonly CheckRun[]> {
    // Имена обязательных проверок строятся из правил политики: фикстура не выписывает их списком.
    if (this.autoCheckVersions.length === 0) return this.checkRuns.filter(run => run.headSha === headSha);
    const names = [
      ...this.autoCheckVersions.flatMap(version => policy.requiredCheckPlatforms.map(pair =>
        policy.requiredCheckTemplate.replaceAll("{os}", pair.os).replaceAll("{version}", version))),
      ...policy.additionalRequiredChecks,
    ];
    return names.map((name, index) => ({
      id: index + 1, name, headSha, status: "completed", conclusion: "success",
      workflowPath: ".github/workflows/check.yml", event: "push",
    }));
  }

  /** Обязательные проверки — настоящая логика репозитория, а не копия в фикстуре. */
  requiredChecksPassed(runs: readonly CheckRun[], headSha: string, versions: readonly string[]) {
    return this.checkLogic.requiredChecksPassed(runs, headSha, versions);
  }

  /** Слияние — настоящий merge-коммит в локальном bare-`origin`, поэтому `mergeSha` существует как объект. */
  async merge(number: number, headSha: string): Promise<{ mergeSha: string }> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error("unknown-pull-request");
    if (pr.headSha !== headSha) throw new Error("stale-head");
    if (pr.draft) throw new Error("pull-request-is-draft");
    if (this.remoteHeads.get(pr.branch) !== headSha) throw new Error("remote-head-mismatch");
    const tree = git(this.origin, ["rev-parse", `${headSha}^{tree}`]);
    const main = git(this.origin, ["rev-parse", "refs/heads/main"]);
    const mergeSha = git(this.origin, ["commit-tree", tree, "-p", main, "-p", headSha, "-m", `Merge ${headSha}`]);
    git(this.origin, ["update-ref", "refs/heads/main", mergeSha]);
    pr.merged = true;
    pr.mergeSha = mergeSha;
    this.mutations.push(`merge:${number}:${mergeSha}`);
    return { mergeSha };
  }

  async deleteBranch(branch: string): Promise<void> {
    this.remoteHeads.delete(branch);
    git(this.origin,["update-ref","-d",`refs/heads/${branch}`]);
    this.mutations.push(`delete-branch:${branch}`);
  }

  async tag(tag: string, sha: string): Promise<void> {
    git(this.origin,["update-ref",`refs/tags/${tag}`,sha]);
    this.tags.set(tag, sha);
    this.mutations.push(`tag:${tag}:${sha}`);
    if (this.releaseProofDirectory) {
      const version = tag.slice(1);
      const archive = join(this.releaseProofDirectory,`omp-settings-ru-${version}.tgz`);
      git(this.origin,["archive","--format=tar.gz","-o",archive,sha]);
      const digest = sha256Bytes(readFileSync(archive));
      writeFileSync(join(this.releaseProofDirectory,"SHA256SUMS"),`${digest}  omp-settings-ru-${version}.tgz\n`);
      writeFileSync(join(this.releaseProofDirectory,"marketplace.json"),JSON.stringify(buildMarketplaceCatalog({version,commitSha:sha,repository:this.repository,description:"Локальный выпуск"})));
      this.workflowRunId = `local-check-${sha}`;
    }
  }

  async tagTarget(tag: string): Promise<string | undefined> {
    const target = Bun.spawnSync(["git","rev-parse",`refs/tags/${tag}`],{cwd:this.origin,stdout:"pipe",stderr:"pipe"});
    return target.exitCode === 0 ? target.stdout.toString().trim() : undefined;
  }

  async releaseState(tag: string): Promise<ReleaseState | undefined> {
    return this.release?.tag === tag ? this.release : undefined;
  }

  async releasePin(): Promise<ReleasePin | undefined> {
    return undefined;
  }
  async checkWorkflowRun(sha: string): Promise<{ kind: "found"; runId: string } | { kind: "absent" } | { kind: "unknown" }> {
    return this.workflowRunId === `local-check-${sha}` ? {kind:"found",runId:this.workflowRunId} : {kind:"absent"};
  }

  async mainSha(): Promise<string> {
    return git(this.origin, ["rev-parse", "refs/heads/main"]);
  }
  async verifyPublishedRelease(tag: string, runId: string, mergeSha: string): Promise<{ kind: "found" } | { kind: "pending" } | { kind: "blocked"; reason: string }> {
    if (!this.releaseProofDirectory) return {kind:"pending"};
    const version = tag.slice(1);
    const archiveName = `omp-settings-ru-${version}.tgz`;
    const archiveSha256 = sha256Bytes(readFileSync(join(this.releaseProofDirectory,archiveName)));
    const sumsBytes = readFileSync(join(this.releaseProofDirectory,"SHA256SUMS"));
    const sumsSha256 = sha256Bytes(sumsBytes);
    const catalog = JSON.parse(readFileSync(join(this.releaseProofDirectory,"marketplace.json"),"utf8"));
    const errors = validateMarketplaceCatalog(catalog,{
      tag,version,targetCommitSha:git(this.origin,["rev-parse",`refs/tags/${tag}`]),draft:false,prerelease:false,published:true,
      checksPassed:runId===`local-check-${mergeSha}`,checksHeadSha:mergeSha,archiveSha256,sumsSha256,
      sumsArchiveSha256:sumsBytes.toString().trim() === `${archiveSha256}  ${archiveName}` ? archiveSha256 : "",
      assets:[{name:archiveName,digest:`sha256:${archiveSha256}`,browserDownloadUrl:"local://archive"},{name:"SHA256SUMS",digest:`sha256:${sumsSha256}`,browserDownloadUrl:"local://sums"}],
    },this.repository);
    return errors.length ? {kind:"blocked",reason:errors.join(",")} : {kind:"found"};
  }
}

interface WorkerRowState {
  readonly runId: string;
  readonly taskId: string;
  state: "running" | "succeeded" | "failed";
  readonly worktreeId: string;
  released?: boolean;
}

/** Локальная служба Orca: Run по цели, воркеры по dispatch id; повторный запуск виден как тот же воркер. */
class FixtureOrca extends Orca implements OrcaPort {
  readonly runs = new Map<string, string>();
  readonly workers = new Map<string, WorkerRowState>();
  constructor() { super(policy); }
  readonly reportRequests = new Map<string, ReportRequest>();
  private readonly reports = new Map<string, Record<string, unknown>>();
  private pendingRequest: ReportRequest | undefined;
  createRunCalls = 0;
  startCalls = 0;
  verdict = "";
  readonly lifecycle: string[] = [];
  readonly acknowledged = new Set<string>();
  /** Немедленное завершение: воркер уже выполнил работу к моменту первого наблюдения. */
  instant = false;
  /** Вердикт ревьюера, вычисляемый из фактического дерева проверяемого коммита. */
  verdictProvider: (() => Promise<string>) | undefined;
  worktreeFor: (role: "executor" | "reviewer") => string = () => "";
  /** Материализация реального рабочего дерева роли: дерево создаётся на вызов `start`, как у Orca. */
  worktreeFactory: (role: "executor" | "reviewer", baseRef: string, name: string) => string = () => "";
  private nextRun = 1;
  private nextDispatch = 1;

  async createRun(objective: string): Promise<string> {
    this.createRunCalls++;
    const runId = `run-${this.nextRun++}`;
    this.runs.set(objective, runId);
    return runId;
  }

  async findRunByObjective(objective: string) {
    const runId = this.runs.get(objective);
    return runId ? { kind: "found" as const, runId } : { kind: "absent" as const };
  }

  taskSpec(request: TaskSpecRequest): string {
    this.pendingRequest = request.reportRequest;
    return `spec:${request.role}:${request.upstreamVersion}:${request.releaseVersion}:${request.baseSha}:${request.headSha}`;
  }

  async start(spec: string, role: "executor" | "reviewer", runId: string, name: string, baseRef: string): Promise<WorkerStartReceipt> {
    this.startCalls++;
    const dispatchId = `dispatch-${this.nextDispatch++}`;
    const taskId = `task-${dispatchId}`;
    void spec;
    if (this.pendingRequest) this.reportRequests.set(dispatchId, this.pendingRequest);
    const worktreeId = this.worktreeFactory(role, baseRef, name) || `${name}::${this.worktreeFor(role)}`;
    this.workers.set(dispatchId, { runId, taskId, state: this.instant ? "succeeded" : "running", worktreeId });
    return { kind: "started", runId, taskId, dispatchId, worktreeId };
  }

  async observe(dispatchId: string): Promise<WorkerStatus> {
    const worker = this.workers.get(dispatchId);
    if (!worker) throw new Error("unknown-dispatch");
    return { dispatchId, runId: worker.runId, taskId: worker.taskId,
      outcome: worker.state === "running" ? undefined : worker.state,
      completedAt: worker.state === "running" ? undefined : "2026-10-11T00:00:00Z", worktreeId: worker.worktreeId,
      resource: { ownerDispatchId: dispatchId, state: worker.released ? "released" : "owned", releaseState: worker.released ? "released" : "not_requested" } };
  }


  async delivery(runId: string): Promise<WorkerDelivery | undefined> {
    const messages: Record<string, unknown>[] = [];
    for (const [dispatchId, worker] of this.workers) {
      if (worker.runId !== runId || worker.state === "running") continue;
      const request = this.reportRequests.get(dispatchId);
      let report = this.reports.get(dispatchId);
      if (request && !report && worker.state === "succeeded") {
        const source = this.verdictProvider ? await this.verdictProvider() : this.verdict;
        let verdict: Record<string, unknown>;
        try { verdict = JSON.parse(source); } catch { verdict = {}; }
        const bytes = JSON.stringify({ schemaVersion: 1, nonce: request.nonce, role: request.role, ...verdict });
        await writeFile(request.reportPath, bytes);
        report = { nonce: request.nonce, role: request.role, headSha: request.headSha, baseSha: request.baseSha,
          reportPath: request.reportPath, reportSha256: createHash("sha256").update(bytes).digest("hex") };
        this.reports.set(dispatchId, report);
      }
      messages.push({ id: `message-${dispatchId}`, run_id: runId, type: "worker_done", body: "clipped",
        payload: JSON.stringify({ dispatchId, taskId: worker.taskId, outcome: worker.state, ...report }) });
    }
    const deliveryId = `delivery-${runId}`;
    return messages.length && !this.acknowledged.has(deliveryId) ? { runId, deliveryId, messages } : undefined;
  }

  async acknowledge(runId: string, deliveryId: string): Promise<WorkerDelivery | undefined> {
    const batch = await this.delivery(runId);
    if (batch?.deliveryId !== deliveryId) throw new Error("unknown-delivery");
    if (batch.messages.some(message => !this.workers.get(JSON.parse(String(message.payload)).dispatchId)?.released)) throw new Error("ack-before-disposition");
    this.acknowledged.add(deliveryId);
    this.lifecycle.push(`ack:${deliveryId}`);
    return undefined;
  }

  async release(dispatchId: string): Promise<void> {
    const worker = this.workers.get(dispatchId);
    if (!worker || worker.state === "running" || worker.released) throw new Error("release-unproven");
    worker.released = true;
    this.lifecycle.push(`release:${dispatchId}`);
  }

  async workerList(runId: string): Promise<readonly WorkerRow[]> {
    return [...this.workers.entries()]
      .filter(([, worker]) => worker.runId === runId)
      .map(([dispatchId, worker]) => ({
        dispatchId, taskId: worker.taskId, runId, state: worker.state, worktreeId: worker.worktreeId,
      }));
  }

  complete(dispatchId: string, state: "succeeded" | "failed"): void {
    const worker = this.workers.get(dispatchId);
    if (!worker) throw new Error("unknown-dispatch");
    worker.state = state;
  }
}

interface Fixture {
  readonly root: string;
  readonly origin: string;
  readonly checkout: string;
  readonly stateDirectory: string;
  readonly github: FixtureGithub;
  readonly orca: FixtureOrca;
  readonly controller: Controller;
}

/**
 * Реестр версий хоста подставляется через шов `ControllerContext.registryLatest`: это обычная инъекция
 * зависимости, поэтому тест не выходит в сеть и не подменяет глобальный `fetch`.
 */
const fixtureRegistry = async (): Promise<string> => CANDIDATE;

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "maint-flow-"));
  const owner = join(root, policy.repository.split("/")[0]!);
  const origin = join(owner, "omp-settings-ru.git");
  const checkout = join(root, "checkout");
  await mkdir(owner, { recursive: true });
  await mkdir(origin, { recursive: true });
  await mkdir(checkout, { recursive: true });
  git(origin, ["init", "-q", "--bare", "-b", "main"]);
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "controller@example.invalid"]);
  git(checkout, ["config", "user.name", "Controller"]);
  git(checkout, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(checkout, "src/translations"), { recursive: true });
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "omp-settings-ru", version: "0.6.0" }));
  await writeFile(join(checkout, "src/translations/ru-part-1.ts"), "export const ru = [];\n");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "base"]);
  // Локальный `origin` как `file://`-URL: `assertOrigin` сверяет репозиторий, а push идёт в temp-каталог.
  git(checkout, ["remote", "add", "origin", `file:///${origin.replaceAll("\\", "/")}`]);
  git(checkout, ["push", "-q", "origin", "main"]);

  const stateDirectory = join(root, "state");
  const journal = await Journal.open(stateDirectory);
  const github = new FixtureGithub(origin, policy.repository);
  const orca = new FixtureOrca();
  const context: ControllerContext = {
    checkout, stateDirectory, policy, journal, github, orca,
    supportedVersions: [PINNED], pinnedVersion: PINNED, registryLatest: fixtureRegistry,
  };
  return { root, origin, checkout, stateDirectory, github, orca, controller: new Controller(context) };
}

describe("сквозной прогон стадий контроллера: реальный git, службы-фикстуры", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("приёмка признаёт кандидата годным и не создаёт никаких внешних эффектов", async () => {
    const decision = await fixture.controller.precheck();

    expect(decision).toEqual({ kind: "eligible", candidate: CANDIDATE, branch: `upgrade/omp-${CANDIDATE}`, resume: false });
    expect(fixture.github.mutations).toEqual([]);
    expect(fixture.orca.createRunCalls).toBe(0);
    expect(fixture.orca.startCalls).toBe(0);
  });

  test("стадия locked заводит исполнителя ровно один раз и удерживает dispatch в состоянии", async () => {
    const outcome = await fixture.controller.run();

    expect(outcome.stage).toBe("working");
    expect(fixture.orca.createRunCalls).toBe(1);
    expect(fixture.orca.startCalls).toBe(1);
    // Внешних мутаций GitHub нет: до коммита и push контроллер ничего не публикует.
    expect(fixture.github.mutations).toEqual([]);

    const persisted = await fixture.controller.pending();
    expect(persisted?.stage).toBe("working");
    const executor = persisted?.effects.find(effect => effect.key === "executor");
    expect(executor?.receipt?.dispatchId).toBe("dispatch-1");
    expect(executor?.receipt?.worktreeId).toBe(`maint-exec-${CANDIDATE}::`);
  });

  test("повторный запуск после сбоя продолжает ту же генерацию и не заводит второго исполнителя", async () => {
    await fixture.controller.run();
    // Процесс «упал» и запущен снова против того же корня состояния.
    const second = new Controller({
      checkout: fixture.checkout, stateDirectory: fixture.stateDirectory, policy,
      journal: await Journal.open(fixture.stateDirectory), github: fixture.github, orca: fixture.orca,
      supportedVersions: [PINNED], pinnedVersion: PINNED, registryLatest: fixtureRegistry,
    });

    const outcome = await second.run();

    expect(outcome.stage).toBe("working");
    // Ровно один Run и один воркер за обе попытки: повтор не создаёт дубля.
    expect(fixture.orca.createRunCalls).toBe(1);
    expect(fixture.orca.startCalls).toBe(1);
    expect([...fixture.orca.workers.keys()]).toEqual(["dispatch-1"]);
    expect(fixture.github.mutations).toEqual([]);
  });

  test("чужой origin на корневом чекауте отсекается до любого диспатча", async () => {
    // Чекаут принадлежит другому репозиторию: `run` обязан отказать, не создавая Run и воркеров.
    git(fixture.checkout, ["remote", "set-url", "origin", "https://example.invalid/other/repo.git"]);

    await expect(fixture.controller.run()).rejects.toThrow("origin-mismatch");
    expect(fixture.orca.createRunCalls).toBe(0);
    expect(fixture.orca.startCalls).toBe(0);
    expect(fixture.github.mutations).toEqual([]);
  });

  test("failed owned worker preserves its delivery and releases before acknowledgement", async () => {
    await fixture.controller.run();
    fixture.orca.complete("dispatch-1", "failed");
    const outcome = await fixture.controller.run();
    expect(outcome.refusal).toBe("executor-failed");
    expect(fixture.orca.lifecycle).toEqual(["release:dispatch-1", "ack:delivery-run-1"]);
    const saved = await (await Journal.open(fixture.stateDirectory)).load(outcome.key);
    expect(saved?.effects.find(effect => effect.key === "worker-message:message-dispatch-1")?.receipt?.outcome).toBe("failed");
  });

  test.each(["release", "ack"] as const)("interrupted %s is reconciled without duplicate resource effects", async boundary => {
    await fixture.controller.run();
    fixture.orca.complete("dispatch-1", "failed");
    let interrupted = false;
    if (boundary === "release") {
      const original = fixture.orca.release.bind(fixture.orca);
      fixture.orca.release = async id => { await original(id); if (!interrupted) { interrupted = true; throw new Error("release-interrupted"); } };
    } else {
      const original = fixture.orca.acknowledge.bind(fixture.orca);
      fixture.orca.acknowledge = async (run, delivery) => { const next = await original(run, delivery); if (!interrupted) { interrupted = true; throw new Error("ack-interrupted"); } return next; };
    }
    const first = await fixture.controller.run();
    expect(first.stage).toBe("blocked");
    const second = await fixture.controller.run();
    expect(second.key).toBe(first.key);
    expect(fixture.orca.lifecycle).toEqual(["release:dispatch-1", "ack:delivery-run-1"]);
  });

  test("a mixed sibling delivery is not acknowledged or partially released", async () => {
    await fixture.controller.run();
    fixture.orca.complete("dispatch-1", "failed");
    const original = fixture.orca.delivery.bind(fixture.orca);
    fixture.orca.delivery = async run => {
      const batch = await original(run);
      return batch ? { ...batch, messages: [...batch.messages, { id: "sibling", run_id: run, type: "worker_done", payload: JSON.stringify({ dispatchId: "foreign", taskId: "foreign", outcome: "succeeded" }) }] } : batch;
    };
    expect((await fixture.controller.run()).refusal).toBe("worker-delivery-not-owned");
    expect(fixture.orca.lifecycle).toEqual([]);
  });

  test("heartbeat acknowledgement recovers without authorizing a live worker release", async () => {
    await fixture.controller.run();
    let delivered = false;
    let interrupt = true;
    fixture.orca.delivery = async runId => delivered ? undefined : { runId, deliveryId: "heartbeat-delivery", messages: [{ id: "heartbeat", run_id: runId,
      type: "heartbeat", payload: JSON.stringify({ dispatchId: "dispatch-1", taskId: "task-dispatch-1" }) }] };
    fixture.orca.acknowledge = async (_runId, deliveryId) => {
      delivered = true;
      fixture.orca.lifecycle.push(`ack:${deliveryId}`);
      if (interrupt) { interrupt = false; throw new Error("ack-interrupted"); }
      return undefined;
    };
    const first = await fixture.controller.run();
    expect(first.refusal).toBe("ack-interrupted");
    await fixture.controller.run();
    const saved = await (await Journal.open(fixture.stateDirectory)).load(first.key);
    expect(saved?.effects.find(effect => effect.key === "worker-ack:heartbeat-delivery")?.receipt).toEqual({ acknowledged: "heartbeat-delivery" });
    expect(fixture.orca.lifecycle).toEqual(["ack:heartbeat-delivery"]);
    expect(fixture.orca.workers.get("dispatch-1")?.released).toBeUndefined();
  });

  test("same owned dispatch heartbeat and done are both preserved before whole-batch ack", async () => {
    await fixture.controller.run();
    fixture.orca.complete("dispatch-1", "failed");
    const original = fixture.orca.delivery.bind(fixture.orca);
    fixture.orca.delivery = async runId => {
      const batch = await original(runId);
      return batch ? { ...batch, messages: [{ id: "heartbeat", run_id: runId, type: "heartbeat", payload: JSON.stringify({ dispatchId: "dispatch-1", taskId: "task-dispatch-1" }) }, ...batch.messages] } : undefined;
    };
    const outcome = await fixture.controller.run();
    expect(outcome.refusal).toBe("executor-failed");
    const saved = await (await Journal.open(fixture.stateDirectory)).load(outcome.key);
    expect(saved?.effects.filter(effect => effect.key.startsWith("worker-message:")).map(effect => effect.key)).toEqual(["worker-message:heartbeat", "worker-message:message-dispatch-1"]);
    expect(fixture.orca.lifecycle).toEqual(["release:dispatch-1", "ack:delivery-run-1"]);
  });
});
const RELEASE_VERSION = "0.6.0";
const CANDIDATE_ONLY_SETTINGS = ["terminal.programStatus", "tts.localSpeed", "speech.speed", "bash.gitGuard", "worktree.onStart", "worktree.onExit"] as const;

async function makeRealFixture(): Promise<Fixture & { readonly base: string; readonly worktrees: readonly string[]; readonly runtime: SemanticRuntimeFixture }> {
  const runtime = await semanticRuntimeFixture([PINNED],CANDIDATE);
  const {root,checkout,base} = runtime;
  const owner = join(root,policy.repository.split("/")[0]!);
  const origin = join(owner,"omp-settings-ru.git");
  await mkdir(origin,{recursive:true});
  git(origin,["init","-q","--bare","-b","main"]);
  git(checkout, ["init", "-q", "-b", "main"]);
  git(checkout, ["config", "user.email", "controller@example.invalid"]);
  git(checkout, ["config", "user.name", "Controller"]);
  git(origin,["config","user.email","controller@example.invalid"]);
  git(origin,["config","user.name","Controller"]);
  git(checkout, ["remote", "add", "origin", `file:///${origin.replaceAll("\\", "/")}`]);
  git(checkout, ["push", "-q", "origin", "main"]);

  const stateDirectory = join(root, "state");
  const journal = await Journal.open(stateDirectory);
  const github = new FixtureGithub(origin, policy.repository);
  github.releaseProofDirectory = root;
  const orca = new FixtureOrca();
  const worktrees: string[] = [];
  let reviewerWorktree = "";
  // Исполнитель получает реальное дерево на принятой базе и готовит метаданные выпуска; ревьюер — дерево
  // точно на закоммиченной голове, чистое, в другом каталоге.
  orca.worktreeFactory = (role, baseRef, name) => {
    const path = join(root, `${role}-${name}`);
    git(checkout, ["worktree", "add", "--detach", path, baseRef]);
    git(path,["config","commit.gpgsign","false"]);
    worktrees.push(path);
    if (role === "executor") {
      runtime.applyCandidate(path);
      writeFileSync(join(path, "CHANGELOG.md"), `# изменения\n\n## [${RELEASE_VERSION}] — 2026-10-11\n\n- поддержка ${CANDIDATE}.\n`);
    } else {
      reviewerWorktree = path;
    }
    return `${name}::${path}`;
  };
  // Воркер уже выполнил свою работу (файлы исполнителя записаны фабрикой), поэтому наблюдение — succeeded.
  orca.instant = true;
  // Обязательные проверки — настоящая логика репозитория по правилам политики: имена строятся из
  // `requiredCheckTemplate` и `requiredCheckPlatforms`, а не выписаны в фикстуре списком.
  github.autoCheckVersions = [PINNED, CANDIDATE];
  const context: ControllerContext = {
    checkout, stateDirectory, policy, journal, github, orca,
    supportedVersions: [PINNED], pinnedVersion: PINNED, registryLatest: fixtureRegistry,
    measurementEnvironment: {registry:runtime.registry,deadlineMs:30_000},
  };
  const controller = new Controller(context);
  // Ревьюер доказывает вердикт фактическим набором отпечатков проверяемого коммита в своём дереве и
  // строками ревью по фактическим вариантам изменённых файлов каталога (платформы — из принятых снимков).
  orca.verdictProvider = async () => {
    const head = git(reviewerWorktree, ["rev-parse", "HEAD"]);
    const changed = committedPaths(reviewerWorktree, base, head);
    // Независимые строки: платформа известна из платформенного источника фикстуры, не вычислена
    // проверяемой changedCatalogRequirements. Отпечатки взяты из настоящего каталога reviewer HEAD.
    const reviewRows = [];
    for (const [file,platform] of [["ru-part-1.ts","win32"],["ru-part-2.ts","linux"],["ru-part-3.ts","darwin"]] as const) {
      const path = `src/translations/${file}`;
      if (!changed.includes(path)) continue;
      for (const entry of catalogFromSource(readFileSync(join(reviewerWorktree,path),"utf8"))) {
        reviewRows.push({path:entry.path,sourceHash:entry.sourceHash,translationHash:entry.translationHash,reviewedAtVersion:CANDIDATE,platforms:[platform]});
      }
    }
    return JSON.stringify({
      verdict: "approved",
      headSha: head,
      baseSha: base,
      evidenceHashes: await evidenceSet(reviewerWorktree, head, changed),
      reviewRows,
    });
  };
  return { root, origin, checkout, stateDirectory, github, orca, controller, base, worktrees, runtime };
}

describe("прогон на фактическом дереве и каталоге", () => {
  let fixture: Fixture & { readonly base: string; readonly worktrees: readonly string[]; readonly runtime: SemanticRuntimeFixture };

  beforeEach(async () => {
    fixture = await makeRealFixture();
  });

  afterEach(async () => {
    await fixture.runtime.close();
  });

  async function resumeAt(key: string, stage: "prepared" | "verifying"): Promise<void> {
    const journal = await Journal.open(fixture.stateDirectory);
    const state = (await journal.load(key))!;
    const lock = await journal.acquire(key);
    try { await journal.save({ ...state, stage, refusal: undefined, deadline: Date.now() + 90_000 }, state.revision, lock); }
    finally { await journal.release(lock); }
  }

  function controllerWith(journal: Journal): Controller {
    return new Controller({ checkout: fixture.checkout, stateDirectory: fixture.stateDirectory, policy, journal,
      github: fixture.github, orca: fixture.orca, supportedVersions: [PINNED], pinnedVersion: PINNED,
      registryLatest: fixtureRegistry, measurementEnvironment: { registry: fixture.runtime.registry, deadlineMs: 30_000 } });
  }

  test("reviewer finishing during settlement preserves proof for the next cycle", async () => {
    const observe = fixture.orca.observe.bind(fixture.orca);
    let reviewerReads = 0;
    fixture.orca.observe = async dispatchId => {
      const observed = await observe(dispatchId);
      if (dispatchId === "dispatch-2" && ++reviewerReads === 2) {
        return { ...observed, outcome: undefined, completedAt: undefined };
      }
      return observed;
    };
    const first = await fixture.controller.run();
    if (first.stage !== "reviewing") throw new Error(`unexpected-stage:${first.stage}:${first.refusal}`);
    expect(first.stage).toBe("reviewing");
    const journal = await Journal.open(fixture.stateDirectory);
    const saved = await journal.load(first.key);
    expect(saved?.effects.find(effect => effect.key === "review-report-proof")?.receipt?.proof).toBeDefined();
    expect(fixture.orca.lifecycle).toEqual(["release:dispatch-1", "ack:delivery-run-1", "release:dispatch-2", "ack:delivery-run-2"]);
    expect((await fixture.controller.run()).stage).toBe("done");
    expect(fixture.orca.lifecycle).toEqual(["release:dispatch-1", "ack:delivery-run-1", "release:dispatch-2", "ack:delivery-run-2"]);
  }, 90_000);


  test.each(["commit", "merge"] as const)("recovers %s applied before durable receipt without duplicate effects", async effectKey => {
    const journal = await Journal.open(fixture.stateDirectory);
    const original = journal.effect.bind(journal);
    let interrupted = false;
    journal.effect = async (state, lock, key, intent, observe, apply) => original(state, lock, key, intent, observe, async () => {
      const receipt = await apply();
      if (key === effectKey && !interrupted) { interrupted = true; throw new Error("simulated-interruption"); }
      return receipt;
    });
    const stopped = await controllerWith(journal).run();
    expect(stopped.stage).toBe("blocked");
    expect(stopped.refusal).toBe("simulated-interruption");
    expect(changedEntries(fixture.worktrees[0]!)).toEqual([]);
    const head = git(fixture.worktrees[0]!, ["rev-parse", "HEAD"]);
    await resumeAt(stopped.key, effectKey === "commit" ? "prepared" : "verifying");
    const resumed = await fixture.controller.run();
    expect(resumed.stage).toBe("done");
    expect(git(fixture.worktrees[0]!, ["rev-parse", "HEAD"])).toBe(head);
    expect(fixture.github.mutations.filter(value => value.startsWith("merge:"))).toHaveLength(1);
    expect(fixture.github.mutations.filter(value => value.startsWith("tag:"))).toHaveLength(1);
  }, 90_000);

  test("unconfirmed prior merge intent blocks a second merge attempt", async () => {
    const journal = await Journal.open(fixture.stateDirectory);
    const original = journal.effect.bind(journal);
    let interrupted = false;
    journal.effect = async (state, lock, key, intent, observe, apply) => original(state, lock, key, intent, observe, async () => {
      if (key === "merge" && !interrupted) {
        interrupted = true;
        throw new Error("simulated-merge-uncertainty");
      }
      return apply();
    });
    const stopped = await controllerWith(journal).run();
    expect(stopped.refusal).toBe("simulated-merge-uncertainty");
    expect(fixture.github.mutations.filter(value => value.startsWith("merge:"))).toEqual([]);
    await resumeAt(stopped.key, "verifying");
    const resumed = await fixture.controller.run();
    expect(resumed.stage).toBe("blocked");
    expect(resumed.refusal).toBe("merge-intent-unverifiable");
    expect(fixture.github.mutations.filter(value => value.startsWith("merge:") || value.startsWith("tag:"))).toEqual([]);
    const saved = await journal.load(stopped.key);
    expect(saved?.stage).toBe("blocked");
    expect(saved?.refusal).toBe("merge-intent-unverifiable");
  }, 90_000);

  test("branch deletion failure resumes owned merge despite advanced main", async () => {
    const original = fixture.github.deleteBranch.bind(fixture.github);
    let fail = true;
    fixture.github.deleteBranch = async branch => { if (fail) { fail = false; throw new Error("branch-delete-failed"); } await original(branch); };
    const stopped = await fixture.controller.run();
    expect(stopped.refusal).toBe("branch-delete-failed");
    await resumeAt(stopped.key, "verifying");
    expect((await fixture.controller.run()).stage).toBe("done");
    expect(fixture.github.mutations.filter(value => value.startsWith("merge:"))).toHaveLength(1);
    expect(fixture.github.mutations.filter(value => value.startsWith("delete-branch:"))).toHaveLength(1);
  }, 90_000);

  test("настоящая дельта каталога доходит до done через все стадии и сливается в origin", async () => {
    const outcome = await fixture.controller.run();

    if (outcome.stage !== "done") {
      const pending = await fixture.controller.pending();
      throw new Error(`стадия ${outcome.stage}; отказ: ${outcome.refusal ?? pending?.refusal}`);
    }
    // Фактические эффекты: коммит, push в локальный origin, черновик, готовность, слияние, тег, выпуск.
    expect(fixture.github.mutations.some(mutation => mutation.startsWith("push:"))).toBe(true);
    expect(fixture.github.mutations.some(mutation => mutation.startsWith("draft:"))).toBe(true);
    expect(fixture.github.mutations.some(mutation => mutation.startsWith("merge:"))).toBe(true);
    expect(fixture.github.mutations.some(mutation => mutation.startsWith("tag:"))).toBe(true);
    // Слияние — настоящий коммит в bare-origin: объект существует и его содержимое — каталог кандидата.
    const mergeSha = outcome.mergeSha!;
    const merged = git(fixture.origin, ["show", `${mergeSha}:src/translations/ru-part-1.ts`]);
    for (const setting of CANDIDATE_ONLY_SETTINGS) {
      expect(merged.includes(`${setting}"`)).toBe(true);
    }
    // Тег указывает на тот же коммит, а выпуск подтверждён фактической проверкой.
    expect(fixture.github.tags.get(`v${RELEASE_VERSION}`)).toBe(mergeSha);
    expect(git(fixture.origin,["rev-parse",`refs/tags/v${RELEASE_VERSION}`])).toBe(mergeSha);
    expect(outcome.refusal).toBeUndefined();
    const completed = await (await Journal.open(fixture.stateDirectory)).load(outcome.key);
    expect(completed?.releaseProof).toEqual({tag:`v${RELEASE_VERSION}`,mergeSha,checkRun:`local-check-${mergeSha}`});
    expect(await fixture.controller.pending()).toBeUndefined();
    expect(fixture.orca.lifecycle).toEqual(["release:dispatch-1", "ack:delivery-run-1", "release:dispatch-2", "ack:delivery-run-2"]);
    expect(completed?.effects.filter(effect => effect.key.startsWith("worker-message:")).length).toBe(2);
    expect(completed?.effects.filter(effect => effect.key.startsWith("worker-release:")).length).toBe(2);
    expect(git(fixture.origin,["rev-parse","refs/heads/main"])).toBe(mergeSha);
    expect(git(fixture.origin,["branch","--list",`upgrade/omp-${CANDIDATE}`])).toBe("");
  },90_000);

  test("повреждённые байты выпуска не позволяют завершить цепочку", async () => {
    const original = fixture.github.tag.bind(fixture.github);
    fixture.github.tag = async (tag,sha) => {
      await original(tag,sha);
      writeFileSync(join(fixture.root,`omp-settings-ru-${tag.slice(1)}.tgz`),"tampered archive");
    };
    const outcome = await fixture.controller.run();
    expect(outcome.stage).toBe("blocked");
    expect(outcome.refusal).toContain("marketplace-release-archive-integrity-failed");
    expect((await fixture.controller.pending())?.releaseProof).toBeUndefined();
  },90_000);

  test("каталог выпуска с чужим точным SHA отклоняется после реального слияния и тега", async () => {
    const original = fixture.github.tag.bind(fixture.github);
    fixture.github.tag = async (tag,sha) => {
      await original(tag,sha);
      const file = join(fixture.root,"marketplace.json");
      const catalog = JSON.parse(readFileSync(file,"utf8"));
      catalog.plugins[0].source.sha = fixture.base;
      writeFileSync(file,JSON.stringify(catalog));
    };
    const outcome = await fixture.controller.run();
    expect(outcome.stage).toBe("blocked");
    expect(outcome.refusal).toContain("marketplace-release-sha-mismatch");
    expect((await fixture.controller.pending())?.releaseProof).toBeUndefined();
  },90_000);
  test("tampered completion hash denies ready merge tag release and acknowledgement", async () => {
    const delivery = fixture.orca.delivery.bind(fixture.orca);
    fixture.orca.delivery = async runId => {
      const batch = await delivery(runId);
      if (runId === "run-2" && batch) {
        const message = batch.messages[0]!;
        message.payload = JSON.stringify({ ...JSON.parse(String(message.payload)), reportSha256: "f".repeat(64) });
      }
      return batch;
    };
    const outcome = await fixture.controller.run();
    expect(outcome.stage).toBe("blocked");
    expect(outcome.refusal).toBe("worker-report-hash-mismatch");
    expect(fixture.github.mutations.filter(value => /^(ready|merge|tag|release):/.test(value))).toEqual([]);
    expect(fixture.orca.lifecycle).not.toContain("release:dispatch-2");
    expect(fixture.orca.lifecycle).not.toContain("ack:delivery-run-2");
  }, 90_000);


  test("строка ревью с чужим отпечатком перевода блокирует готовность, слияние и выпуск", async () => {
    const original = fixture.orca.verdictProvider!;
    fixture.orca.verdictProvider = async () => {
      const verdict = JSON.parse(await original()) as { reviewRows: { translationHash: string }[] };
      verdict.reviewRows[0]!.translationHash = "e".repeat(64);
      return JSON.stringify(verdict);
    };

    const outcome = await fixture.controller.run();

    expect(outcome.stage).toBe("blocked");
    expect(outcome.refusal ?? "").toMatch(/^review-(translation-mismatch|row-missing|platform-mismatch)/);
    expect(fixture.github.mutations.map(mutation=>mutation.split(":")[0])).toEqual(["push","draft"]);
    expect([...fixture.github.prs.values()].every(pr=>pr.draft&&!pr.merged)).toBe(true);
  },90_000);

  test("пропущенная строка ревью по новому варианту каталога блокирует стадию", async () => {
    const original = fixture.orca.verdictProvider!;
    fixture.orca.verdictProvider = async () => {
      const verdict = JSON.parse(await original()) as { reviewRows: unknown[] };
      verdict.reviewRows = verdict.reviewRows.slice(1);
      return JSON.stringify(verdict);
    };

    const outcome = await fixture.controller.run();

    expect(outcome.stage).toBe("blocked");
    expect(outcome.refusal ?? "").toMatch(/^review-row-missing:/);
    expect(fixture.github.mutations.map(mutation=>mutation.split(":")[0])).toEqual(["push","draft"]);
    expect([...fixture.github.prs.values()].every(pr=>pr.draft&&!pr.merged)).toBe(true);
  },90_000);

  test("исполнитель, тронувший измерительный код, блокируется до запуска измерения", async () => {
    const original = fixture.orca.worktreeFactory!;
    fixture.orca.worktreeFactory = (role, baseRef, name) => {
      const id = original(role, baseRef, name);
      const path = id.split("::")[1]!;
      if (role === "executor") writeFileSync(join(path, "scripts/check-coverage.ts"), "// подменённое измерение\n");
      return id;
    };

    const outcome = await fixture.controller.run();

    expect(outcome.stage).toBe("blocked");
    expect(outcome.refusal).toBe("measurement-code-changed:scripts/check-coverage.ts");
    expect(fixture.github.mutations).toEqual([]);
  },90_000);

  test("обрезанный базовый снимок кандидата не проходит фактическое измерение", async () => {
    // Базовый снимок кандидата урезан: покрытие и дрейф считаются настоящими скриптами и обязаны отказать.
    const original = fixture.orca.worktreeFactory!;
    fixture.orca.worktreeFactory = (role, baseRef, name) => {
      const id = original(role, baseRef, name);
      const path = id.split("::")[1]!;
      if (role === "executor") {
        for (const platform of ["win32", "linux", "darwin"]) {
          const file = join(path, `baseline/${CANDIDATE}-${platform}.json`);
          const snapshot = JSON.parse(readFileSync(file, "utf8")) as { settings: Record<string, unknown> };
          snapshot.settings = Object.fromEntries(Object.entries(snapshot.settings).slice(0, 5));
          writeFileSync(file, JSON.stringify(snapshot));
        }
      }
      return id;
    };

    const outcome = await fixture.controller.run();

    expect(outcome.stage).toBe("blocked");
    expect(outcome.refusal ?? "").toMatch(/^(coverage-incomplete|coverage-missing|drift-nonzero|drift-missing|drift-run-failed)/);
    expect(fixture.github.mutations).toEqual([]);
  },90_000);
});

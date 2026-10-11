import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCEPTANCE_SCENARIOS, acceptanceErrors, controllerTreeHash, mintAcceptance, pinnedVersionAt, recheckAcceptance,
  type AcceptanceContext, type AcceptancePorts, type AcceptanceReceipt,
} from "../scripts/maintenance-controller";
import type { CheckRun, ControllerPolicy, WorkerObservation } from "../scripts/maintenance/contracts";
import { GitHub } from "../scripts/maintenance/github";
import { Orca, type WorkerRow, type WorkerStatus, type WorkerDelivery } from "../scripts/maintenance/orca";
import { bindReportRequest, createReportRequest, type ReportRequest } from "../scripts/maintenance/report";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";

/**
 * Приёмка активации: наблюдение, а не форма записи.
 *
 * Сети, GitHub и Orca здесь нет: подставляются локальные порты, а рабочие деревья воркеров — настоящие
 * git-репозитории в temp. Проверяется то, чего нельзя доказать формой JSON: что доказательство продюсера
 * выведено из фактов прогона и что подделанные, сокращённые, устаревшие или отозванные доказательства
 * приёмку не выдают и не продлевают.
 *
 * Гейт проверок не переписывается: `FixtureGithub` наследует настоящий `requiredChecksPassed` и подменяет
 * только чтение, уходящее в сеть.
 */

const policy: ControllerPolicy = validatePolicy(rawPolicy);
const VERSION = "18.8.4";
const HOST_RUN = `check (windows-2025, ${VERSION})`;
const REPOSITORY_URL = `https://github.com/${policy.repository}.git`;

function git(cwd: string, args: readonly string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

interface World {
  readonly root: string;
  readonly repo: string;
  readonly execWorktree: string;
  readonly reviewWorktree: string;
  readonly baseSha: string;
  readonly digest: string;
  readonly evidencePath: string;
  readonly checks: readonly CheckRun[];
  readonly verdict: string;
  readonly treeHash: string;
  readonly request: ReportRequest;
  readonly requestPath: string;
}

/** Принятая база в реальном git, два независимых дерева воркеров на ней и отчёт продюсера на диске. */
async function makeWorld(options: { reviewHeadMoves?: boolean; sameWorktree?: boolean } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "maint-acceptance-"));
  const repo = join(root, "repo");
  const execWorktree = join(root, "worktree-exec");
  const reviewWorktree = options.sameWorktree ? execWorktree : join(root, "worktree-review");
  await mkdir(join(repo, "baseline"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "controller@example.invalid"]);
  git(repo, ["config", "user.name", "Controller"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "baseline/supported-hosts.json"), JSON.stringify({ schemaVersion: 1, versions: [{ version: VERSION }] }));
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "omp-settings-ru", version: "0.5.0" }));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  for (const worktree of new Set([execWorktree, reviewWorktree])) {
    await mkdir(worktree, { recursive: true });
    git(worktree, ["init", "-q", "-b", "worker"]);
    git(worktree, ["config", "user.email", "controller@example.invalid"]);
    git(worktree, ["config", "user.name", "Controller"]);
    git(worktree, ["config", "commit.gpgsign", "false"]);
    git(worktree, ["remote", "add", "origin", repo]);
    git(worktree, ["fetch", "-q", "origin", baseSha]);
    git(worktree, ["checkout", "-q", baseSha]);
    // Origin переводится на адрес репозитория политики: `assertOrigin` сверяет именно URL, не путь.
    git(worktree, ["remote", "set-url", "origin", REPOSITORY_URL]);
  }
  if (options.reviewHeadMoves) {
    await writeFile(join(reviewWorktree, "extra.txt"), "reviewer moved the head\n");
    git(reviewWorktree, ["add", "extra.txt"]);
    git(reviewWorktree, ["commit", "-q", "-m", "reviewer moved the head"]);
  }

  const checks: readonly CheckRun[] = [
    ...["windows-2025", "ubuntu-24.04", "macos-15"].map((os, index) => ({
      id: 101 + index,
      name: `check (${os}, ${VERSION})`,
      headSha: baseSha,
      status: "completed",
      conclusion: "success",
      workflowPath: ".github/workflows/check.yml",
      event: "push",
    })),
    { id: 110, name: "hygiene", headSha: baseSha, status: "completed", conclusion: "success", workflowPath: ".github/workflows/check.yml", event: "push" },
    // Прогон `pull_request` привязан к синтетическому merge-коммиту и доказательством быть не может.
    { id: 111, name: HOST_RUN, headSha: "f".repeat(40), status: "completed", conclusion: "success", workflowPath: ".github/workflows/check.yml", event: "pull_request" },
  ];
  const treeHash = await controllerTreeHash(repo);
  const request = await createReportRequest(join(root, "state"), repo, baseSha, baseSha);
  await bindReportRequest(join(root, "state", "reports", `${request.nonce}.request.json`), join(root, "state"), { runId: "run-2", taskId: "task-2", dispatchId: "dispatch-review" });
  const verdict = JSON.stringify({
    schemaVersion: 1, nonce: request.nonce, role: "reviewer",
    verdict: "approved",
    headSha: baseSha,
    baseSha,
    evidenceHashes: [treeHash],
    reviewRows: [],
  });
  return {
    root, repo, execWorktree, reviewWorktree, baseSha, digest: sha256("accepted-policy"),
    request, requestPath: join(root, "state", "reports", `${request.nonce}.request.json`),
    evidencePath: join(root, "e2e-report.json"), checks, verdict, treeHash,
  };
}

interface Observation {
  checks: readonly CheckRun[];
  verdict: string;
  dispatchState: "succeeded" | "failed";
  readonly observed: string[];
}

/** Форма доказательства продюсера: факты прогона плюс ссылки; тесты их варьируют. */
function evidenceFor(world: World, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "acceptance-evidence",
    passed: true,
    exitCode: 0,
    command: `bun test ${ACCEPTANCE_SCENARIOS.map(scenario => scenario.file).join(" ")}`,
    scenarios: ACCEPTANCE_SCENARIOS.map(scenario => ({ name: scenario.name, file: scenario.file, testsExecuted: 3, passed: true })),
    treeBefore: world.treeHash,
    treeAfter: world.treeHash,
    treeHash: world.treeHash,
    policyDigest: world.digest,
    acceptedBaseSha: world.baseSha,
    dispatch: { runId: "run-1", dispatchId: "dispatch-exec" },
    review: { runId: "run-2", dispatchId: "dispatch-review", requestPath: world.requestPath },
    producedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

/** Чтение GitHub подменяется; гейт `requiredChecksPassed` наследуется настоящий. */
class FixtureGithub extends GitHub {
  constructor(private readonly observation: Observation) {
    super(policy);
  }

  override async checksFor(): Promise<readonly CheckRun[]> {
    return this.observation.checks;
  }

  override async checkWorkflowRun(): Promise<{ kind: "found"; runId: string }> {
    return { kind: "found", runId: "777" };
  }
}

class FixtureOrca extends Orca {
  constructor(
    private readonly observation: Observation,
    private readonly execWorktree: string,
    private readonly reviewWorktree: string,
    private readonly request: ReportRequest,
  ) {
    super(policy, execWorktree);
  }

  override async workerList(runId: string): Promise<readonly WorkerRow[]> {
    this.observation.observed.push(`workerList:${runId}`);
    if (runId === "run-2") {
      return [{ dispatchId: "dispatch-review", taskId: "task-2", runId, state: "succeeded", worktreeId: `maint-review::${this.reviewWorktree}` }];
    }
    return [{ dispatchId: "dispatch-exec", taskId: "task-1", runId, state: "succeeded", worktreeId: `maint-exec::${this.execWorktree}` }];
  }

  override async observe(dispatchId: string): Promise<WorkerStatus> {
    this.observation.observed.push(`observe:${dispatchId}`);
    const reviewer = dispatchId === "dispatch-review";
    return {
      dispatchId,
      runId: reviewer ? "run-2" : "run-1", taskId: reviewer ? "task-2" : "task-1",
      completedAt: "2026-10-11T00:00:00Z",
      resource: { ownerDispatchId: dispatchId, state: "owned", releaseState: "not_requested" },
      outcome: this.observation.dispatchState === "succeeded" ? "succeeded" : "failed",
      worktreeId: `${reviewer ? "maint-review" : "maint-exec"}::${reviewer ? this.reviewWorktree : this.execWorktree}`,
    };
  }

  override async delivery(runId: string): Promise<WorkerDelivery> {
    this.observation.observed.push("read:dispatch-review");
    await writeFile(this.request.reportPath, this.observation.verdict);
    return { runId, deliveryId: "review-delivery", messages: [{ id: "review-completion", run_id: runId, type: "worker_done", body: "clipped", payload: JSON.stringify({
      dispatchId: "dispatch-review", taskId: "task-2", outcome: "succeeded", nonce: this.request.nonce, role: this.request.role,
      headSha: this.request.headSha, baseSha: this.request.baseSha, reportPath: this.request.reportPath, reportSha256: sha256(this.observation.verdict),
    }) }] };
  }
}

function portsFor(world: World, observation: Observation): AcceptancePorts {
  return { github: new FixtureGithub(observation), orca: new FixtureOrca(observation, world.execWorktree, world.reviewWorktree, world.request) };
}

function contextFor(world: World, ports: AcceptancePorts, baseSha = world.baseSha): AcceptanceContext {
  return { checkout: world.repo, stateDirectory: join(world.root, "state"), policy, digest: world.digest, baseSha, ports };
}

async function writeEvidence(world: World, overrides: Readonly<Record<string, unknown>> = {}): Promise<void> {
  await writeFile(world.evidencePath, JSON.stringify(evidenceFor(world, overrides)));
}

describe("приёмка активации: наблюдение вместо формы", () => {
  let world: World;
  let observation: Observation;

  beforeEach(async () => {
    world = await makeWorld();
    observation = { checks: world.checks, verdict: world.verdict, dispatchState: "succeeded", observed: [] };
    await writeEvidence(world);
  });

  afterEach(async () => {
    await rm(world.root, { recursive: true, force: true });
  });

  test("приёмка выдаётся по фактическому наблюдению и записывает то, что увидел верификатор", async () => {
    const ports = portsFor(world, observation);
    const receipt = await mintAcceptance(contextFor(world, ports), world.evidencePath);

    // Идентификатор проверки взят у GitHub, а не из какого-либо поля отчёта.
    expect(receipt.check.checkRunId).toBe("101");
    expect(receipt.check.event).toBe("push");
    expect(receipt.check.headSha).toBe(world.baseSha);
    expect(receipt.check.workflowRunId).toBe("777");
    expect(receipt.dispatch).toEqual({ dispatchId: "dispatch-exec", runId: "run-1", worktreeId: `maint-exec::${world.execWorktree}` });
    expect(receipt.review.dispatchId).toBe("dispatch-review");
    expect(receipt.review.runId).toBe("run-2");
    expect(acceptanceErrors(receipt)).toEqual([]);
    // Наблюдение действительно выполнялось, а не было сымитировано формой отчёта.
    expect(observation.observed).toContain("workerList:run-1");
    expect(observation.observed).toContain("workerList:run-2");
    expect(observation.observed).toContain("read:dispatch-review");
  });

  test("доказательство с чужим отпечатком дерева не превращается в приёмку", async () => {
    await writeEvidence(world, { treeBefore: sha256("other"), treeAfter: sha256("other"), treeHash: sha256("other") });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:tree-mismatch");
  });

  test("дерево, изменённое прогоном, отменяет доказательство", async () => {
    await writeEvidence(world, { treeAfter: sha256("after-run") });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:tree-changed-by-run");
  });

  test("ненулевой код выхода и passed:false доказательством не считаются", async () => {
    await writeEvidence(world, { exitCode: 1 });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:exit-code");
    await writeEvidence(world, { passed: false });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:not-passed");
  });

  test("сокращённый набор сценариев не является приёмкой", async () => {
    const reduced = ACCEPTANCE_SCENARIOS.slice(1).map(scenario => ({ name: scenario.name, file: scenario.file, testsExecuted: 3, passed: true }));
    await writeEvidence(world, { scenarios: reduced });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow(`acceptance-evidence-invalid:scenario-missing:${ACCEPTANCE_SCENARIOS[0]!.file}`);
  });

  test("сценарий без выполненных тестов не проходит", async () => {
    const scenarios = ACCEPTANCE_SCENARIOS.map((scenario, index) => ({
      name: scenario.name, file: scenario.file, testsExecuted: index === 0 ? 0 : 3, passed: index !== 0,
    }));
    await writeEvidence(world, { scenarios });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow(`acceptance-evidence-invalid:scenario-not-passed:${ACCEPTANCE_SCENARIOS[0]!.file}`);
  });

  test("доказательство без сценариев не проходит", async () => {
    await writeEvidence(world, { scenarios: undefined });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:scenarios");
  });

  test("доказательство без ссылок на Run и ревью не проходит", async () => {
    await writeEvidence(world, { dispatch: undefined });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:dispatch");
  });

  test("проверка на другом коммите или провалившаяся не открывает приёмку", async () => {
    observation.checks = world.checks.map(run => ({ ...run, headSha: "e".repeat(40) }));
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow(/acceptance-check-gate-failed:check-other-sha/);
    observation.checks = world.checks.map(run => run.id === 101 ? { ...run, conclusion: "failure" } : run);
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow(/acceptance-check-gate-failed:check-failed/);
  });

  test("dispatch, которого нет в своём Run, приёмку не даёт", async () => {
    await writeEvidence(world, { dispatch: { runId: "run-1", dispatchId: "dispatch-other" } });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-dispatch-not-owned");
  });

  test("незавершённый исполнитель приёмку не даёт", async () => {
    observation.dispatchState = "failed";
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-dispatch-not-settled");
  });

  test("исполнитель, чьё дерево ушло с принятой базы, приёмку не даёт", async () => {
    const moved = await makeWorld({ reviewHeadMoves: true });
    try {
      const movedObservation: Observation = { checks: moved.checks, verdict: moved.verdict, dispatchState: "succeeded", observed: [] };
      await writeEvidence(moved);
      await expect(mintAcceptance(contextFor(moved, portsFor(moved, movedObservation)), moved.evidencePath))
        .rejects.toThrow("acceptance-review-head-mismatch");
    } finally {
      await rm(moved.root, { recursive: true, force: true });
    }
  });

  test("ревьюер, не состоящий в своём Run, приёмку не даёт", async () => {
    await writeEvidence(world, { review: { runId: "run-1", dispatchId: "dispatch-review" } });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-review-not-owned");
  });

  test("ревьюер в дереве исполнителя не является независимым", async () => {
    const shared = await makeWorld({ sameWorktree: true });
    try {
      const sharedObservation: Observation = { checks: shared.checks, verdict: shared.verdict, dispatchState: "succeeded", observed: [] };
      await writeEvidence(shared);
      await expect(mintAcceptance(contextFor(shared, portsFor(shared, sharedObservation)), shared.evidencePath))
        .rejects.toThrow("acceptance-review-worktree-not-independent");
    } finally {
      await rm(shared.root, { recursive: true, force: true });
    }
  });

  test("вердикт ревьюера, не относящийся к принятой базе, приёмку не даёт", async () => {
    observation.verdict = JSON.stringify({
      schemaVersion: 1, nonce: world.request.nonce, role: "reviewer",
      verdict: "approved",
      headSha: "d".repeat(40),
      baseSha: world.baseSha,
      evidenceHashes: [world.treeHash],
      reviewRows: [],
    });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("worker-report-verdict-unverifiable");
  });

  test("вердикт без отпечатка фактического проверяемого дерева приёмку не даёт", async () => {
    observation.verdict = JSON.stringify({
      schemaVersion: 1, nonce: world.request.nonce, role: "reviewer",
      verdict: "approved",
      headSha: world.baseSha,
      baseSha: world.baseSha,
      evidenceHashes: [sha256("some other tree")],
      reviewRows: [],
    });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-review-attestation-mismatch");
  });

  test("ревьюер, совпавший с исполнителем, приёмку не даёт", async () => {
    await writeEvidence(world, { review: { runId: "run-2", dispatchId: "dispatch-exec" } });
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:review-same-dispatch");
  });

  test("файл сценария приёмки — часть отпечатка проверяемого дерева", async () => {
    const scenario = join(world.repo, ACCEPTANCE_SCENARIOS[0]!.file);
    await mkdir(join(world.repo, "test"), { recursive: true });
    await writeFile(scenario, "// подменённый сценарий приёмки\n");

    // Файл сценария обязан менять отпечаток: доказательство состоит именно из факта его прогона.
    expect(await controllerTreeHash(world.repo)).not.toBe(world.treeHash);
    await expect(mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath))
      .rejects.toThrow("acceptance-evidence-invalid:tree-mismatch");
  });

  test("манифест поддержанных хостов в рабочем дереве не подменяет принятую базу", async () => {
    // Незакоммиченная правка манифеста: рабочее дерево объявляет лишнюю поддержанную версию.
    await writeFile(join(world.repo, "baseline/supported-hosts.json"),
      JSON.stringify({ schemaVersion: 1, versions: [{ version: VERSION }, { version: "18.9.0" }] }));
    expect(await Bun.file(join(world.repo, "baseline/supported-hosts.json")).json())
      .toMatchObject({ versions: [{ version: VERSION }, { version: "18.9.0" }] });

    // Обязательные проверки считаются по принятому коммиту: лишняя версия из рабочего дерева не требует
    // несуществующей проверки — и наоборот, не открывает себе проверок, которых база не требовала.
    const receipt = await mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath);
    expect(receipt.check.checkRunId).toBe("101");
    expect(receipt.acceptedBaseSha).toBe(world.baseSha);
  });
});

describe("приёмка не переживает расхождений между снимком и запуском", () => {
  let world: World;
  let observation: Observation;
  let receipt: AcceptanceReceipt;

  beforeEach(async () => {
    world = await makeWorld();
    observation = { checks: world.checks, verdict: world.verdict, dispatchState: "succeeded", observed: [] };
    await writeEvidence(world);
    receipt = await mintAcceptance(contextFor(world, portsFor(world, observation)), world.evidencePath);
  });

  afterEach(async () => {
    await rm(world.root, { recursive: true, force: true });
  });

  test("действующая приёмка проходит повторную сверку", async () => {
    await recheckAcceptance(receipt, contextFor(world, portsFor(world, observation)));
  });

  test("подменённые байты доказательства отзывают приёмку", async () => {
    await writeFile(world.evidencePath, JSON.stringify({ schemaVersion: 1, passed: false }));
    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-evidence-changed");
  });

  test("исчезнувшее доказательство отзывает приёмку", async () => {
    await rm(world.evidencePath, { force: true });
    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-evidence-missing");
  });

  test("уехавшая принятая база отзывает приёмку", async () => {
    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation), "c".repeat(40))))
      .rejects.toThrow("local-acceptance-stale-base");
  });

  test("провалившаяся проверка отзывает приёмку", async () => {
    observation.checks = world.checks.map(run => run.id === 101 ? { ...run, conclusion: "failure" } : run);
    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-check-revoked");
  });

  test("переставший быть успешным dispatch отзывает приёмку", async () => {
    observation.dispatchState = "failed";
    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-dispatch-revoked");
  });

  test("изменённый вердикт ревьюера отзывает приёмку", async () => {
    observation.verdict = JSON.stringify({ ...JSON.parse(world.verdict), verdict: "rejected" });
    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-review-revoked");
  });

  test("отозванный отпечаток проверяемого дерева отзывает приёмку", async () => {
    observation.verdict = JSON.stringify({ ...JSON.parse(world.verdict), evidenceHashes: [sha256("drifted")] });
    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-review-revoked");
  });

  test("правка файла сценария приёмки после снимка отзывает приёмку", async () => {
    await mkdir(join(world.repo, "test"), { recursive: true });
    await writeFile(join(world.repo, ACCEPTANCE_SCENARIOS[1]!.file), "// сценарий подменён после снимка\n");

    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-stale-tree");
  });

  test("правка доверенного измерительного модуля отзывает приёмку", async () => {
    await mkdir(join(world.repo, "scripts/maintenance"), { recursive: true });
    await writeFile(join(world.repo, "scripts/maintenance/measurement-environment.ts"), "export const changed = true;\n");

    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-stale-tree");
  });

  test("правка политики после снимка отзывает приёмку", async () => {
    await writeFile(join(world.repo, "maintenance.config.json"), JSON.stringify(rawPolicy));

    await expect(recheckAcceptance(receipt, contextFor(world, portsFor(world, observation))))
      .rejects.toThrow("local-acceptance-stale-tree");
  });
});

describe("пин хоста связан с принятым коммитом, а не с рабочим деревом", () => {
  test("пин читается из принятого коммита и не меняется незакоммиченной правкой", async () => {
    const root = await mkdtemp(join(tmpdir(), "maint-pin-"));
    const manifest = (version: string) => JSON.stringify({ devDependencies: { "@oh-my-pi/pi-coding-agent": version } });
    try {
      git(root, ["init", "-q", "-b", "main"]);
      git(root, ["config", "user.email", "controller@example.invalid"]);
      git(root, ["config", "user.name", "Controller"]);
      git(root, ["config", "commit.gpgsign", "false"]);
      await writeFile(join(root, "package.json"), manifest("18.8.4"));
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "accepted pin"]);
      const baseSha = git(root, ["rev-parse", "HEAD"]);
      expect(pinnedVersionAt(root, baseSha)).toBe("18.8.4");

      // Незакоммиченная правка не объявляет версию реестра уже поддержанной: решение о кандидате
      // остаётся привязанным к принятому коммиту.
      await writeFile(join(root, "package.json"), manifest("18.8.9"));
      expect(pinnedVersionAt(root, baseSha)).toBe("18.8.4");

      // Не-semver пин и отсутствующий коммит — отказ, а не пустая строка для сравнения с реестром.
      await writeFile(join(root, "package.json"), manifest("latest"));
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "non-semver pin"]);
      const nonSemver = git(root, ["rev-parse", "HEAD"]);
      expect(() => pinnedVersionAt(root, nonSemver)).toThrow("pinned-version-unavailable");
      expect(() => pinnedVersionAt(root, "f".repeat(40))).toThrow("pinned-version-unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CLI контроллера: машинный отказ вместо стека", () => {
  const cli = join(import.meta.dir, "..", "scripts", "maintenance-controller.ts");
  const producer = join(import.meta.dir, "..", "scripts", "maintenance-acceptance-smoke.ts");

  async function run(script: string, args: readonly string[], cwd: string) {
    const child = Bun.spawnSync(["bun", script, ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  /** Принятая база с политикой контроллера — общая заготовка для CLI-проверок. */
  async function acceptedCheckout(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "maint-cli-"));
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "controller@example.invalid"]);
    git(root, ["config", "user.name", "Controller"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(root, "maintenance.config.json"), JSON.stringify(rawPolicy));
    await mkdir(join(root, "baseline"), { recursive: true });
    await writeFile(join(root, "baseline/supported-hosts.json"), JSON.stringify({ schemaVersion: 1, versions: [{ version: VERSION }] }));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.5.0", devDependencies: { "@oh-my-pi/pi-coding-agent": VERSION } }));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "accepted base with controller policy"]);
    git(root, ["update-ref", "refs/remotes/origin/main", git(root, ["rev-parse", "HEAD"])]);
    return root;
  }

  test("нет принятой базы: причина одной строкой и код 11", async () => {
    const root = await mkdtemp(join(tmpdir(), "maint-cli-"));
    try {
      git(root, ["init", "-q", "-b", "main"]);
      const result = await run(cli, ["--preflight", "--checkout", root], root);
      expect(result.code).toBe(11);
      expect(JSON.parse(result.stdout)).toEqual({ kind: "blocked", reason: "accepted-base-unavailable" });
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).not.toContain("at ");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("origin/main без блока controller: policy-invalid, код 11, без стека", async () => {
    const root = await mkdtemp(join(tmpdir(), "maint-cli-"));
    try {
      git(root, ["init", "-q", "-b", "main"]);
      git(root, ["config", "user.email", "controller@example.invalid"]);
      git(root, ["config", "user.name", "Controller"]);
      git(root, ["config", "commit.gpgsign", "false"]);
      await writeFile(join(root, "maintenance.config.json"), JSON.stringify({
        schemaVersion: 1,
        repository: policy.repository,
        requiredCheckPlatforms: [{ os: "ubuntu-24.04", platform: "linux" }],
      }));
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "accepted base without controller policy"]);
      git(root, ["update-ref", "refs/remotes/origin/main", git(root, ["rev-parse", "HEAD"])]);

      const result = await run(cli, ["--preflight", "--checkout", root], root);
      expect(result.code).toBe(11);
      expect(JSON.parse(result.stdout)).toEqual({ kind: "blocked", reason: "policy-invalid:controller-missing" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run без приёмки отказывает до первого эффекта", async () => {
    const root = await acceptedCheckout();
    try {
      const stateDirectory = join(root, "state");
      const result = await run(cli, ["run", "--checkout", root, "--state-dir", stateDirectory], root);
      expect(result.code).toBe(11);
      expect(JSON.parse(result.stdout)).toEqual({ kind: "blocked", reason: "local-acceptance-missing" });
      // Отказ до первого эффекта: каталог состояния даже не заведён.
      expect(await Bun.file(join(stateDirectory, "acceptance.json")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accept с несуществующим доказательством: причина и код 11", async () => {
    const root = await acceptedCheckout();
    try {
      const result = await run(cli, ["accept", "--checkout", root, "--state-dir", join(root, "state"), "--evidence", join(root, "missing.json")], root);
      expect(result.code).toBe(11);
      expect(JSON.parse(result.stdout)).toEqual({ kind: "blocked", reason: "acceptance-evidence-unreadable" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("продюсер без ссылок на dispatch-и доказательство не выдаёт (подготовительный режим)", async () => {
    const root = await mkdtemp(join(tmpdir(), "maint-producer-"));
    try {
      git(root, ["init", "-q", "-b", "main"]);
      git(root, ["config", "user.email", "controller@example.invalid"]);
      git(root, ["config", "user.name", "Controller"]);
      git(root, ["config", "commit.gpgsign", "false"]);
      await writeFile(join(root, "maintenance.config.json"), JSON.stringify(rawPolicy));
      await mkdir(join(root, "baseline"), { recursive: true });
      await writeFile(join(root, "baseline/supported-hosts.json"), JSON.stringify({ schemaVersion: 1, versions: [{ version: VERSION }] }));
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "base"]);
      git(root, ["update-ref", "refs/remotes/origin/main", git(root, ["rev-parse", "HEAD"])]);

      const output = join(root, "evidence.json");
      // Диагностический набор из одного сценария: продюсер его прогоняет, но приёмку это не откроет.
      const result = await run(producer, ["--checkout", root, "--output", output, "--scenarios", "precheck-decision"], root);
      expect(result.code).toBe(11);
      const summary = JSON.parse(result.stdout) as { ok: boolean; blockers: readonly string[]; treeUnchanged: boolean };
      expect(summary.ok).toBe(false);
      expect(summary.treeUnchanged).toBe(true);
      // Ссылок нет — доказательство честно помечено как неполное, а не как пройденное.
      expect(summary.blockers).toContain("dispatches-pending");

      const evidence = JSON.parse(await Bun.file(output).text()) as Record<string, unknown>;
      expect(evidence.passed).toBe(false);
      expect(evidence.treeBefore).toBe(evidence.treeAfter);

      // Сокращённый набор не принимается и верификатором: приёмка по нему не выдаётся.
      const accepted = await run(cli, ["accept", "--checkout", root, "--state-dir", join(root, "state"), "--evidence", output], root);
      expect(accepted.code).toBe(11);
      expect(JSON.parse(accepted.stdout)).toMatchObject({ kind: "blocked" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

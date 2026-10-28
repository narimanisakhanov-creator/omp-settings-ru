import type { CheckRun, CheckWorkflowProof, ControllerPolicy, ReleasePin } from "./contracts";
import { asRecord, readBoolean, readNumber, readPath, readRecords, readString } from "./json";
import { CATALOG_ASSET, downloadReleaseAsset, loadVerifiedCatalog } from "../marketplace-catalog";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Порт GitHub контроллера.
 *
 * Две инварианты, которые нельзя обойти:
 * 1. **Личность.** Перед любой мутацией фактический `gh api user` сверяется с политикой. Расхождение или
 *    недоступность — отказ, а не «продолжим как раньше». Токен не печатается.
 * 2. **Привязка проверок.** Принимаются только прогоны `check.yml` с событием `push` на точном head-SHA
 *    запроса; прогон `pull_request` привязан к синтетическому merge-коммиту и receipt-ом не считается.
 */

export interface PrObservation {
  readonly repository: string;
  readonly number: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly author: string;
  readonly authorType: string;
  readonly draft: boolean;
  readonly state: string;
  readonly merged: boolean;
  readonly mergeSha?: string;
  readonly changedPaths: readonly string[];
}

export interface ReleaseState {
  readonly tag: string;
  readonly draft: boolean;
  readonly targetSha: string;
  readonly assets: readonly { name: string; id: number; sha256: string }[];
}

export interface ControllerIdentity {
  readonly login: string;
  readonly type: string;
}

/**
 * Граница GitHub, которой пользуется контроллер.
 *
 * Интерфейс объявлен отдельно от реализации: тесты подставляют локальный порт вместо сети, а продакшн-класс
 * `GitHub` ему соответствует. Ни одна реализация не обязана обходить проверку личности.
 */
export interface GithubPort {
  assertIdentity(): Promise<ControllerIdentity>;
  observePr(number: number): Promise<PrObservation>;
  openPullRequests(): Promise<readonly PrObservation[]>;
  remoteBranchHead(branch: string): Promise<string | undefined>;
  pushRef(worktree: string, branch: string, headSha: string): Promise<void>;
  createDraft(branch: string, baseSha: string, headSha: string, version: string): Promise<number>;
  markReady(number: number, expectedHead: string): Promise<void>;
  checksFor(headSha: string): Promise<readonly CheckRun[]>;
  requiredChecksPassed(runs: readonly CheckRun[], headSha: string, versions: readonly string[], selected?: CheckWorkflowProof): { ok: true } | { ok: false; reason: string };
  merge(number: number, headSha: string): Promise<{ mergeSha: string }>;
  deleteBranch(branch: string): Promise<void>;
  tag(tag: string, sha: string): Promise<void>;
  tagTarget(tag: string): Promise<string | undefined>;
  releaseState(tag: string): Promise<ReleaseState | undefined>;
  releasePin(tag: string, sha: string, version: string): Promise<ReleasePin | undefined>;
  /** Прогон `check.yml` на точном коммите; `unknown` — ответ нечитаем или недоступен. */
  checkWorkflowRun(sha: string): Promise<{ kind: "found"; runId: string } | { kind: "absent" } | { kind: "unknown" }>;
  mainSha(): Promise<string>;
  /** Подтверждение опубликованного выпуска: скачивание, перехеширование и сверка каталога. */
  verifyPublishedRelease(tag: string, runId: string, mergeSha: string): Promise<{ kind: "found" } | { kind: "pending" } | { kind: "blocked"; reason: string }>;
}

async function gh(args: readonly string[], timeoutMs: number, token?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL/i.test(key)) delete env[key];
  if (token) env.GH_TOKEN = token;
  const child = Bun.spawn(["gh", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export class GitHub implements GithubPort {
  private identity?: ControllerIdentity;

  constructor(private readonly policy: ControllerPolicy, private readonly token = process.env.GH_TOKEN) {}

  /** Фактическая личность и её сверка с политикой. Кэшируется в пределах процесса. */
  async assertIdentity(): Promise<ControllerIdentity> {
    if (this.identity) return this.identity;
    const result = await gh(["api", "user"], this.policy.deadlinesMs.command, this.token);
    if (result.code !== 0) throw new Error("identity-unavailable");
    const user = asRecord(JSON.parse(result.stdout) as unknown);
    const login = readString(user, "login");
    const type = readString(user, "type");
    if (!login || !type) throw new Error("identity-unverifiable");
    if (login !== this.policy.controllerLogin || type !== this.policy.controllerType) throw new Error("identity-mismatch");
    this.identity = { login, type };
    return this.identity;
  }

  private async api(path: string): Promise<unknown> {
    const result = await gh(["api", path], this.policy.deadlinesMs.command, this.token);
    if (result.code !== 0) {
      if (/HTTP 404/.test(result.stderr)) throw new Error("github-not-found");
      throw new Error("github-read-unavailable");
    }
    return JSON.parse(result.stdout) as unknown;
  }

  private async mutate(args: readonly string[]): Promise<string> {
    await this.assertIdentity();
    const result = await gh(args, this.policy.deadlinesMs.command, this.token);
    if (result.code !== 0) throw Object.assign(new Error("github-mutation-refused"), { cause: result.stderr });
    return result.stdout;
  }

  private async changedPaths(number: number): Promise<readonly string[]> {
    const root = `repos/${this.policy.repository}`;
    const files: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const raw = await this.api(`${root}/pulls/${number}/files?per_page=100&page=${page}`);
      if (!Array.isArray(raw)) throw new Error("changed-paths-unreadable");
      const names = raw.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined)
        .map(row => readString(row, "filename")).filter((name): name is string => Boolean(name));
      files.push(...names);
      if (names.length < 100) break;
      if (page === 30) throw new Error("changed-paths-truncated");
    }
    return files;
  }

  private readPr(pr: Record<string, unknown>): PrObservation {
    return {
      repository: readPath(pr, "base", "repo", "full_name") ?? "",
      number: readNumber(pr, "number") ?? 0,
      branch: readPath(pr, "head", "ref") ?? "",
      baseBranch: readPath(pr, "base", "ref") ?? "",
      baseSha: readPath(pr, "base", "sha") ?? "",
      headSha: readPath(pr, "head", "sha") ?? "",
      author: readPath(pr, "user", "login") ?? "",
      authorType: readPath(pr, "user", "type") ?? "",
      draft: readBoolean(pr, "draft") ?? false,
      state: (readString(pr, "state") ?? "").toUpperCase(),
      merged: readBoolean(pr, "merged") ?? false,
      mergeSha: readString(pr, "merge_commit_sha"),
      changedPaths: [],
    };
  }

  async observePr(number: number): Promise<PrObservation> {
    const root = `repos/${this.policy.repository}`;
    const pr = asRecord(await this.api(`${root}/pulls/${number}`));
    if (!pr) throw new Error("pull-request-unreadable");
    return { ...this.readPr(pr), changedPaths: await this.changedPaths(number) };
  }

  /** Открытые запросы — вход для решения precheck. */
  async openPullRequests(): Promise<readonly PrObservation[]> {
    const root = `repos/${this.policy.repository}`;
    const rows: PrObservation[] = [];
    for (let page = 1; page <= 100; page++) {
      const raw = await this.api(`${root}/pulls?state=open&per_page=100&page=${page}`);
      if (!Array.isArray(raw) || raw.some(row => !asRecord(row))) throw new Error("pull-list-unreadable");
      rows.push(...raw.map(row => this.readPr(asRecord(row)!)));
      if (raw.length < 100) return rows;
    }
    throw new Error("pull-list-truncated");
  }

  private async refSha(branch: string): Promise<string | undefined> {
    const raw = await this.api(`repos/${this.policy.repository}/git/ref/heads/${branch}`).catch(error => { if (error instanceof Error && error.message === "github-not-found") return undefined; throw error; });
    return readPath(raw, "object", "sha");
  }

  /** Фактическая голова удалённой ветви. Используется наблюдением, а не догадкой. */
  async remoteBranchHead(branch: string): Promise<string | undefined> {
    return this.refSha(branch);
  }

  /** Применение отправки. Проверки принадлежат наблюдению, а не этому вызову. */
  async pushRef(worktree: string, branch: string, headSha: string): Promise<void> {
    await this.assertIdentity();
    const child = Bun.spawn(["git", "push", "origin", `${headSha}:refs/heads/${branch}`], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
    if (await child.exited !== 0) throw new Error("push-refused");
  }

  async createDraft(branch: string, baseSha: string, headSha: string, version: string): Promise<number> {
    // База не должна уехать между подготовкой и созданием запроса.
    if (await this.mainSha() !== baseSha) throw new Error("base-advanced-before-draft");
    const stdout = await this.mutate([
      "api", `repos/${this.policy.repository}/pulls`, "--method", "POST",
      "-f", `head=${branch}`, "-f", `base=${this.policy.baseBranch}`,
      "-f", `title=Поддержка OMP ${version}`,
      "-f", `body=Автоматически подготовленное обновление перевода до OMP ${version}. Черновик до локальных гейтов.`,
      "-F", "draft=true",
    ]);
    const pr = asRecord(JSON.parse(stdout) as unknown);
    const number = readNumber(pr, "number");
    const head = readPath(pr, "head", "sha");
    const base = readPath(pr, "base", "sha");
    if (!number || head !== headSha || base !== baseSha) throw new Error("draft-receipt-unverified");
    return number;
  }

  async markReady(number: number, expectedHead: string): Promise<void> {
    const before = await this.observePr(number);
    if (before.headSha !== expectedHead) throw new Error("stale-head");
    await this.mutate(["pr", "ready", String(number), "--repo", this.policy.repository]);
    const after = await this.observePr(number);
    if (after.draft) throw new Error("ready-receipt-unverified");
  }

  /** Page through an authoritative API collection; an unreadable/truncated page is not absence. */
  private async collection(path: string, key: string): Promise<readonly Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= 30; page++) {
      const raw = asRecord(await this.api(`${path}&per_page=100&page=${page}`));
      const entries = raw?.[key];
      if (!Array.isArray(entries) || entries.some(entry => !asRecord(entry))) throw new Error("github-collection-unreadable");
      rows.push(...readRecords(raw, key));
      if (entries.length < 100) {
        const total = readNumber(raw, "total_count");
        if (total !== undefined && total !== rows.length) throw new Error("github-collection-truncated");
        return rows;
      }
    }
    throw new Error("github-collection-truncated");
  }

  private checkRunBound(run: Record<string, unknown>, sha: string): boolean {
    const id = readNumber(run, "id");
    const suite = readNumber(run, "check_suite_id");
    return id !== undefined && Number.isSafeInteger(id) && id > 0
      && suite !== undefined && Number.isSafeInteger(suite) && suite > 0
      && readPath(run, "repository", "full_name") === this.policy.repository
      && readPath(run, "head_repository", "full_name") === this.policy.repository
      && readString(run, "head_sha") === sha && readString(run, "event") === "push"
      && readString(run, "path") === ".github/workflows/check.yml";
  }

  private async checkRunsFor(sha: string): Promise<readonly Record<string, unknown>[]> {
    const runs = await this.collection(`repos/${this.policy.repository}/actions/runs?head_sha=${sha}`, "workflow_runs");
    return runs.filter(run => this.checkRunBound(run, sha));
  }

  async checksFor(headSha: string): Promise<readonly CheckRun[]> {
    const root = `repos/${this.policy.repository}`;
    const [checks, workflows] = await Promise.all([
      this.collection(`${root}/commits/${headSha}/check-runs?filter=latest`, "check_runs"),
      this.checkRunsFor(headSha),
    ]);
    const result: CheckRun[] = [];
    for (const workflow of workflows) {
      const runId = readNumber(workflow, "id")!;
      const suiteId = readNumber(workflow, "check_suite_id")!;
      const jobs = await this.collection(`${root}/actions/runs/${runId}/jobs?filter=latest`, "jobs");
      for (const job of jobs) {
        const jobAttempt = readNumber(job, "run_attempt");
        const workflowAttempt = readNumber(workflow, "run_attempt");
        if (readNumber(job, "run_id") !== runId || readString(job, "head_sha") !== headSha
          || jobAttempt === undefined || !Number.isSafeInteger(jobAttempt) || jobAttempt < 1
          || workflowAttempt === undefined || !Number.isSafeInteger(workflowAttempt) || workflowAttempt < jobAttempt) continue;
        const check = checks.find(candidate => readString(job, "check_run_url") === `https://api.github.com/${root}/check-runs/${readNumber(candidate, "id")}`
          && readNumber(asRecord(candidate.check_suite), "id") === suiteId
          && readPath(candidate, "app", "slug") === "github-actions"
          && readString(candidate, "head_sha") === headSha
          && readString(candidate, "name") === readString(job, "name"));
        if (!check) continue;
        result.push({
          id: readNumber(check, "id") ?? 0,
          name: readString(job, "name") ?? "",
          headSha,
          status: readString(job, "status") ?? "",
          conclusion: readString(job, "conclusion") ?? "",
          workflowPath: readString(workflow, "path")!,
          event: readString(workflow, "event")!,
          workflowRunId: runId,
          workflowAttempt: readNumber(workflow, "run_attempt"),
          jobAttempt,
          headBranch: readString(workflow, "head_branch"),
          workflowStatus: readString(workflow, "status"),
          workflowConclusion: readString(workflow, "conclusion"),
        });
      }
    }
    return result;
  }

  /**
   * Обязательные проверки на точном head-SHA.
   *
   * Принимается только прогон события `push`, чей head равен head-SHA запроса: прогон `pull_request`
   * привязан к синтетическому merge-коммиту и receipt-ом служить не может.
   */
  requiredChecksPassed(
    runs: readonly CheckRun[], headSha: string, versions: readonly string[], selected?: CheckWorkflowProof,
  ): { ok: true } | { ok: false; reason: string } {
    const required = [
      ...versions.flatMap(version => this.policy.requiredCheckPlatforms.map(pair =>
        this.policy.requiredCheckTemplate.replaceAll("{os}", pair.os).replaceAll("{version}", version))),
      ...this.policy.additionalRequiredChecks,
    ];
    // Choose one workflow globally, never a separate winner for each job name.
    const eligible = runs.filter(run => run.headSha === headSha && run.event === "push" && run.workflowPath === ".github/workflows/check.yml");
    const runId = selected?.id ?? Math.max(0, ...eligible.map(run => run.workflowRunId ?? 0));
    const attempt = selected?.attempt ?? Math.max(0, ...eligible.filter(run => run.workflowRunId === runId).map(run => run.workflowAttempt ?? 0));
    const bound = eligible.filter(run => run.workflowRunId === runId && run.workflowAttempt === attempt
      && (!selected || run.headBranch === selected.headBranch));
    if (selected && (selected.status !== "completed" || selected.conclusion !== "success")) return { ok: false, reason: "check-workflow-not-successful" };
    for (const name of required) {
      const forName = bound.filter(run => run.name === name);
      if (forName.length === 0) return { ok: false, reason: `check-missing:${name}` };
      if (forName.some(run => run.status !== "completed")) return { ok: false, reason: `check-pending:${name}` };
      if (forName.length === 1 && forName[0]?.conclusion === "success") continue;
      return { ok: false, reason: `check-failed:${name}` };
    }
    return { ok: true };
  }

  async merge(number: number, headSha: string): Promise<{ mergeSha: string }> {
    const before = await this.observePr(number);
    if (before.headSha !== headSha) throw new Error("stale-head");
    if (before.merged && before.mergeSha) return { mergeSha: before.mergeSha };
    await this.mutate([
      "pr", "merge", String(number), "--repo", this.policy.repository,
      "--merge", "--match-head-commit", headSha,
    ]);
    const after = await this.observePr(number);
    if (!after.merged || !after.mergeSha) throw new Error("merge-receipt-unverified");
    return { mergeSha: after.mergeSha };
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.mutate(["api", "--method", "DELETE", `repos/${this.policy.repository}/git/refs/heads/${branch}`]);
  }

  async tag(tag: string, sha: string): Promise<void> {
    const existing = await this.api(`repos/${this.policy.repository}/git/ref/tags/${tag}`).catch(error => { if (error instanceof Error && error.message === "github-not-found") return undefined; throw error; });
    const existingSha = readPath(existing, "object", "sha");
    if (existingSha) {
      if (existingSha !== sha) throw new Error("tag-conflict");
      return;
    }
    await this.mutate([
      "api", "--method", "POST", `repos/${this.policy.repository}/git/refs`,
      "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`,
    ]);
  }

  async releaseState(tag: string): Promise<ReleaseState | undefined> {
    const releases: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page++) {
      const raw = await this.api(`repos/${this.policy.repository}/releases?per_page=100${page === 1 ? "" : `&page=${page}`}`);
      if (!Array.isArray(raw) || raw.some(row => !asRecord(row))) throw new Error("release-list-unreadable");
      releases.push(...raw as Record<string, unknown>[]);
      if (raw.length < 100) break;
      if (page === 100) throw new Error("release-list-truncated");
    }
    const release = releases.find(row => readString(row, "tag_name") === tag);
    if (!release) return undefined;
    return {
      tag,
      draft: readBoolean(release, "draft") ?? false,
      targetSha: readString(release, "target_commitish") ?? "",
      assets: readRecords(release, "assets").map(asset => ({
        name: readString(asset, "name") ?? "",
        id: readNumber(asset, "id") ?? 0,
        sha256: (readString(asset, "digest") ?? "").replace(/^sha256:/, ""),
      })),
    };
  }

  async releasePin(tag: string, sha: string, version: string): Promise<ReleasePin | undefined> {
    const state = await this.releaseState(tag);
    const archive = state?.assets.find(asset => asset.name === `omp-settings-ru-${version}.tgz`);
    if (!archive) return undefined;
    return {
      tag,
      commitSha: sha,
      assetId: archive.id,
      sha256: archive.sha256,
      packageVersion: version,
      supportedPairs: [],
    };
  }

  /**
   * Прогон `check.yml` на точном коммите.
   *
   * `found` — есть завершённый успешный прогон именно `check.yml` с этим head; `absent` — API ответил
   * авторитетно и подходящего прогона нет (ещё не создан либо ещё идёт); `unknown` — ответ нечитаем или
   * недоступен, и тогда ничего не утверждается.
   */
  async checkWorkflowRun(sha: string): Promise<{ kind: "found"; runId: string } | { kind: "absent" } | { kind: "unknown" }> {
    try {
      const runs = await this.checkRunsFor(sha);
      const run = runs.find(row => readString(row, "status") === "completed" && readString(row, "conclusion") === "success");
      return run ? { kind: "found", runId: String(readNumber(run, "id")) } : { kind: "absent" };
    } catch {
      return { kind: "unknown" };
    }
  }

  /** Текущий коммит постоянной ветви — сверка базы перед слиянием. */
  async mainSha(): Promise<string> {
    const raw = await this.api(`repos/${this.policy.repository}/git/ref/heads/${this.policy.baseBranch}`);
    const sha = readPath(raw, "object", "sha");
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("base-head-unreadable");
    return sha;
  }

  /** Коммит, на который указывает тег (аннотированный тег разыменовывается). */
  async tagTarget(tag: string): Promise<string | undefined> {
    const ref = await this.api(`repos/${this.policy.repository}/git/ref/tags/${tag}`).catch(error => { if (error instanceof Error && error.message === "github-not-found") return undefined; throw error; });
    const sha = readPath(ref, "object", "sha");
    const type = readPath(ref, "object", "type");
    if (!sha) return undefined;
    if (type === "commit") return sha;
    const object = await this.api(`repos/${this.policy.repository}/git/tags/${sha}`);
    return readPath(object, "object", "sha");
  }

  /**
   * Подтверждение опубликованного выпуска существующей проверкой репозитория.
   *
   * `loadVerifiedCatalog` скачивает архив, `SHA256SUMS` и каталог, перехеширует их, требует опубликованный
   * (не draft) выпуск и прогон `check.yml` на том же коммите. Возвращается только результат этой проверки:
   * список имён ассетов подтверждением не является.
   *
   * `pending` — выпуск ещё не создан или остаётся draft. Опубликованный выпуск с отсутствующими
   * либо неверными ассетами — `blocked`, никогда не повод генерировать локальную замену каталога.
   */
  async verifyPublishedRelease(
    tag: string, runId: string, mergeSha: string,
  ): Promise<{ kind: "found" } | { kind: "pending" } | { kind: "blocked"; reason: string }> {
    let directory: string | undefined;
    try {
      const state = await this.releaseState(tag);
      if (!state || state.draft) return { kind: "pending" };
      const catalogs = state.assets.filter(asset => asset.name === CATALOG_ASSET);
      if (catalogs.length !== 1 || !Number.isSafeInteger(catalogs[0]!.id) || catalogs[0]!.id <= 0) {
        return { kind: "blocked", reason: "release-catalog-missing-or-ambiguous" };
      }
      const check = asRecord(await this.api(`repos/${this.policy.repository}/actions/runs/${runId}`));
      if (!check || !this.checkRunBound(check, mergeSha) || String(readNumber(check, "id")) !== runId
        || readString(check, "status") !== "completed" || readString(check, "conclusion") !== "success") {
        return { kind: "blocked", reason: "release-check-proof-invalid" };
      }
      const bytes = await downloadReleaseAsset(this.policy.repository, catalogs[0]!.id, this.token);
      directory = await mkdtemp(join(tmpdir(), "maintenance-published-catalog-"));
      const catalogPath = join(directory, CATALOG_ASSET);
      await writeFile(catalogPath, bytes);
      // Supplying downloaded bytes is essential: undefined asks the generator for a NEW local catalog.
      const { release } = await loadVerifiedCatalog(tag, runId, catalogPath, this.policy.repository, this.token);
      if (release.targetCommitSha !== mergeSha) return { kind: "blocked", reason: "release-target-mismatch" };
      return { kind: "found" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return { kind: "blocked", reason: `release-unverified:${message}` };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

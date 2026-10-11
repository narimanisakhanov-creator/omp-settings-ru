import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckRun, ControllerPolicy, LockRecord, MaintenanceStage, MaintenanceState, WorkerStartReceipt,
} from "./contracts";
import { generationKey } from "./contracts";
import { Journal } from "./journal";
import type { GithubPort } from "./github";
import type { OrcaPort } from "./orca";
import { decidePrecheck, type OpenPullRequest, type PrecheckDecision } from "./precheck";
import { collectSemanticEvidence, validateSemantic, type MeasurementEnvironmentOptions, type ReviewRow } from "./semantic";
import { asRecord, readString } from "./json";
import { assertCleanWorktree, assertOrigin, commitApproved, committedPaths, contentHash, changedEntries, currentHead, evidenceSet, intendedTree, observeCommit, parentOf, planPaths } from "./tree";
import { createReportRequest, parseReportRequest, verifyReportFile, type ReportProof, type ReportRequest } from "./report";

/**
 * Машина стадий контроллера сопровождения.
 *
 * Ведёт одну генерацию: подготовка в изолированном дереве исполнителя → проверяемые гейты → коммит и push →
 * черновик PR → независимое ревью → полный содержательный гейт → точные проверки на head-SHA → слияние со
 * сверкой головы → bump, тег и подтверждение draft-выпуска. Публикацию канала выполняет существующий
 * workflow выпуска; контроллер её не дублирует.
 *
 * Каждое внешнее действие проходит через журнал: intent до действия, receipt после. Наблюдение, которое
 * нельзя доказать, блокирует стадию — повторов и выдуманных «успехов» нет.
 */

export interface ControllerContext {
  readonly checkout: string;
  readonly stateDirectory: string;
  readonly policy: ControllerPolicy;
  readonly journal: Journal;
  readonly github: GithubPort;
  readonly orca: OrcaPort;
  readonly supportedVersions: readonly string[];
  readonly pinnedVersion: string;
  /** Источник последней версии хоста. По умолчанию — реестр npm; тесты подставляют фикстуру. */
  readonly registryLatest?: (policy: ControllerPolicy) => Promise<string>;
  readonly measurementEnvironment?: MeasurementEnvironmentOptions;
}

/**
 * Код отказа, пригодный для журнала.
 *
 * Отказ стадии обязан донести **причину**, а не раствориться в общем `stage-failed`: коды вида
 * `measurement-code-changed:scripts/check-coverage.ts` или `historical-identity-removed:<путь>:<хеш>` несут
 * путь и идентичность, поэтому `/`, `.` и `:` — часть кода, а не признак чужого текста.
 *
 * Граница узкая и явная: код начинается со строчного слова (наш собственный префикс отказа) и продолжается
 * двоеточие-разделёнными сегментами безопасного алфавита (`A-Za-z0-9._,-/`), где сегмент начинается с
 * буквы, цифры, `.` или `_` — без пробелов, кавычек, `@`, `?` и обратных слэшей, длиной не больше 200
 * символов. Такой форме отвечает наш структурированный отказ (включая путь, `composer.tokenRate` и имена
 * `ts.SyntaxKind` в сегменте), но не произвольный текст чужой ошибки (`ENOENT: no such file or directory,
 * open 'C:\...'`), не URL с учётными данными (`https://user:pass@host/x`) и не значение секрета: посторонний
 * вывод не проходит алфавит и остаётся `stage-failed` — без утечки и без выдуманной причины.
 */
const REFUSAL_SHAPE = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._-][A-Za-z0-9._,/-]*)*$/;
const REFUSAL_MAX = 200;

export function refusalCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.length === 0 || message.length > REFUSAL_MAX) return "stage-failed";
  return REFUSAL_SHAPE.test(message) ? message : "stage-failed";
}

const STAGE_DEADLINE: Readonly<Record<MaintenanceStage, keyof ControllerPolicy["deadlinesMs"]>> = {
  locked: "agent",
  working: "agent",
  prepared: "command",
  pushed: "verification",
  reviewing: "agent",
  verifying: "verification",
  merged: "release",
  released: "release",
  done: "command",
  blocked: "command",
};

export interface RunOutcome {
  readonly stage: MaintenanceStage;
  readonly key: string;
  readonly refusal?: string;
  readonly mergeSha?: string;
  readonly tag?: string;
}


export class Controller {
  private readonly activePath: string;

  constructor(private readonly context: ControllerContext) {
    this.activePath = join(context.stateDirectory, "active.json");
  }

  /** Предварительная проверка: без дерева, без агента, без удалённых мутаций. */
  async precheck(now = Date.now()): Promise<PrecheckDecision> {
    const { policy, github } = this.context;
    const lock = await this.context.journal.lock();
    const openPrs = await github.openPullRequests();
    const pending = await this.pending();
    return decidePrecheck({
      registryLatest: await (this.context.registryLatest ?? registryLatest)(policy),
      pinned: this.context.pinnedVersion,
      supported: this.context.supportedVersions,
      policy,
      openPrs: openPrs.map(pr => ({
        number: pr.number, branch: pr.branch, baseSha: pr.baseSha, headSha: pr.headSha, author: pr.author,
      })) satisfies OpenPullRequest[],
      ownedPr: pending ? {
        number: pending.pr.number, branch: pending.pr.branch, baseSha: pending.pr.baseSha, headSha: pending.pr.headSha,
      } : undefined,
      lock: lock ? { kind: "held" } : { kind: "free" },
      now,
      deadline: now + policy.deadlinesMs.precheck,
    });
  }

  async pending(): Promise<MaintenanceState | undefined> {
    let key: string;
    try {
      key = (JSON.parse(await readFile(this.activePath, "utf8")) as { key?: string }).key ?? "";
    } catch {
      return undefined;
    }
    if (!key) return undefined;
    const state = await this.context.journal.load(key);
    return !state || state.stage === "done" ? undefined : state;
  }

  /** Один цикл: продолжает сохранённую генерацию либо заводит новую. */
  async run(): Promise<RunOutcome> {
    // Проверка принадлежности корневого чекаута: работаем только в нём и только на чтение политики.
    assertOrigin(this.context.checkout, this.context.policy.repository);
    const existing = await this.pending();
    const state = existing ?? await this.startGeneration();
    const lock = await this.context.journal.acquire(state.key);
    try {
      let current = state;
      if (!existing) current = await this.context.journal.save(current, 0, lock);
      while (current.stage !== "done" && current.stage !== "blocked") {
        if (Date.now() >= current.deadline) {
          current = await this.transition(current, lock, "blocked", { refusal: "stage-deadline-expired" });
          break;
        }
        // Ошибка стадии (в том числе отказ внешней мутации) переводится в записанный `blocked`, а не
        // выбрасывается наружу: цикл всегда заканчивается записанным состоянием, пригодным для возобновления.
        // Revision берётся с диска: частично применённый эффект мог уже сохранить более новое состояние, и
        // перезапись устаревшей ревизией запрещена.
        let next: MaintenanceState;
        try {
          next = await this.advance(current, lock);
        } catch (error) {
          const refusal = refusalCode(error);
          const fresh = await this.context.journal.load(current.key);
          if (!fresh) throw error;
          current = await this.transition(fresh, lock, "blocked", { refusal });
          break;
        }
        const unchangedStage = next.stage === current.stage;
        current = next;
        if (unchangedStage) break;
      }
      try {
        current = await this.settleWorkers(current, lock);
      } catch (error) {
        const fresh = await this.context.journal.load(current.key);
        if (!fresh) throw error;
        current = await this.transition(fresh, lock, "blocked", { refusal: refusalCode(error) });
      }
      await writeFile(this.activePath, JSON.stringify({ key: current.key }), "utf8");
      return {
        stage: current.stage,
        key: current.key,
        refusal: current.refusal,
        mergeSha: current.effects.find(effect => effect.key === "merge")?.receipt?.mergeSha as string | undefined,
        tag: current.effects.find(effect => effect.key === "tag")?.receipt?.tag as string | undefined,
      };
    } finally {
      await this.context.journal.release(lock);
    }
  }

  private async transition(
    state: MaintenanceState, lock: LockRecord, stage: MaintenanceStage, patch: Partial<MaintenanceState> = {},
  ): Promise<MaintenanceState> {
    const deadline = Date.now() + this.context.policy.deadlinesMs[STAGE_DEADLINE[stage]];
    return this.context.journal.save({ ...state, ...patch, stage, deadline }, state.revision, lock);
  }

  private async startGeneration(): Promise<MaintenanceState> {
    const { policy, github } = this.context;
    const latest = await (this.context.registryLatest ?? registryLatest)(policy);
    const openPrs = await github.openPullRequests();
    const decision = decidePrecheck({
      registryLatest: latest,
      pinned: this.context.pinnedVersion,
      supported: this.context.supportedVersions,
      policy,
      openPrs: openPrs.map(pr => ({ number: pr.number, branch: pr.branch, baseSha: pr.baseSha, headSha: pr.headSha, author: pr.author })),
      lock: { kind: "free" },
      now: Date.now(),
      deadline: Date.now() + policy.deadlinesMs.precheck,
    });
    if (decision.kind !== "eligible") throw new Error(`precheck-not-eligible:${decision.kind}`);
    const base = await this.baseSha();
    const nonce = randomUUID();
    const releaseVersion = await this.nextReleaseVersion(base);
    return {
      schemaVersion: 1,
      key: generationKey(policy.repository, decision.candidate, base, nonce),
      generation: { repository: policy.repository, candidateVersion: decision.candidate, baseSha: base, attemptNonce: nonce },
      revision: 0,
      stage: "locked",
      attempt: 1,
      deadline: Date.now() + policy.deadlinesMs.agent,
      upstreamVersion: decision.candidate,
      releaseVersion,
      pr: { number: 0, branch: decision.branch, baseSha: base, headSha: "", candidateVersion: decision.candidate },
      effects: [],
    };
  }

  /**
   * Версия плагина для тега: minor-инкремент текущей версии из принятого коммита.
   *
   * Это версия **плагина**, а не версия хоста: `18.8.9` — кандидат upstream, тег же ставится на версию
   * проекта. Отдельный парсинг semver, без строковых манипуляций над версией хоста.
   */
  private async nextReleaseVersion(baseSha: string): Promise<string> {
    const child = Bun.spawn(["git", "show", `${baseSha}:package.json`], { cwd: this.context.checkout, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error("package-version-unavailable");
    const version = (JSON.parse(text) as { version?: string }).version;
    if (typeof version !== "string") throw new Error("package-version-invalid");
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) throw new Error("package-version-invalid");
    return `${match[1]}.${Number(match[2]) + 1}.0`;
  }

  private async baseSha(): Promise<string> {
    const child = Bun.spawn(["git", "rev-parse", "--verify", "origin/main^{commit}"], { cwd: this.context.checkout, stdout: "pipe", stderr: "pipe" });
    const sha = (await new Response(child.stdout).text()).trim();
    if (await child.exited !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("accepted-base-unavailable");
    return sha;
  }

  private async dispatch(
    state: MaintenanceState, lock: LockRecord, role: "executor" | "reviewer", baseRef: string, name: string,
  ): Promise<MaintenanceState> {
    const { journal, orca } = this.context;
    const objective = role === "executor"
      ? `Сопровождение OMP ${state.pr.candidateVersion} @ ${state.generation.baseSha}`
      : `Ревью OMP ${state.pr.candidateVersion} @ ${state.pr.headSha}`;
    // Run создаётся один раз на генерацию и роль. Наблюдение идёт по durable-метаданным (цель), поэтому
    // повтор после сбоя находит существующий Run, а неопределённость блокирует стадию вместо дубля.
    let withRun = await journal.effect(state, lock, `${role}-run`, { objective },
      async () => {
        const found = await orca.findRunByObjective(objective);
        return found.kind === "found" ? { kind: "found", receipt: { runId: found.runId } } : found;
      },
      async () => ({ runId: await orca.createRun(objective) }));
    const runId = withRun.effects.find(effect => effect.key === `${role}-run`)?.receipt?.runId as string;
    if (!runId) throw new Error("run-receipt-missing");
    let reportRequest: ReportRequest | undefined;
    if (role === "reviewer") {
      const prior = await journal.persistedEffect(withRun, "review-report-request");
      reportRequest = parseReportRequest(prior?.intent.request) ?? await createReportRequest(
        this.context.stateDirectory, this.context.checkout, state.pr.headSha, state.generation.baseSha);
      withRun = await journal.effect(withRun, lock, "review-report-request", { request: reportRequest },
        async () => ({ kind: "found", receipt: { request: reportRequest } }), async () => { throw new Error("worker-report-request-missing"); });
    }
    const spec = orca.taskSpec({
      role,
      upstreamVersion: state.pr.candidateVersion,
      releaseVersion: state.releaseVersion,
      baseSha: state.generation.baseSha,
      headSha: role === "executor" ? "" : state.pr.headSha,
      ...(reportRequest ? { reportRequest } : {}),
    });
    const dispatched = await journal.effect(withRun, lock, role,
      { runId, name, baseSha: baseRef, candidateVersion: state.pr.candidateVersion },
      async () => {
        const rows = await orca.workerList(runId);
        if (rows.length === 0) return { kind: "absent" };
        if (rows.length > 1) return { kind: "unknown" };
        const row = rows[0]!;
        return { kind: "found", receipt: { dispatchId: row.dispatchId, taskId: row.taskId, worktreeId: row.worktreeId ?? "" } };
      },
      async () => {
        const receipt: WorkerStartReceipt = await orca.start(spec, role, runId, name, baseRef);
        if (receipt.kind === "depth-blocked") throw new Error(`dispatch-depth-blocked:${receipt.unblockAction}`);
        return { dispatchId: receipt.dispatchId, taskId: receipt.taskId, worktreeId: receipt.worktreeId };
      });
    if (!reportRequest) return dispatched;
    const receipt = dispatched.effects.find(effect => effect.key === role)?.receipt;
    const binding = { runId, taskId: readString(receipt, "taskId"), dispatchId: readString(receipt, "dispatchId") };
    if (!binding.taskId || !binding.dispatchId) throw new Error("worker-report-binding-missing");
    return journal.effect(dispatched, lock, "review-report-binding", { request: reportRequest, ...binding },
      async () => ({ kind: "found", receipt: binding }), async () => { throw new Error("worker-report-binding-missing"); });
  }

  /** Preserve owned delivery evidence, dispose settled terminals, then ack the whole batch. */
  private async settleWorkers(state: MaintenanceState, lock: LockRecord): Promise<MaintenanceState> {
    const { orca, journal } = this.context;
    let current = state;
    for (const role of ["executor", "reviewer"] as const) {
      const dispatch = current.effects.find(effect => effect.key === role);
      const runId = readString(dispatch?.intent, "runId");
      const dispatchId = readString(dispatch?.receipt, "dispatchId");
      const taskId = readString(dispatch?.receipt, "taskId");
      if (!runId || !dispatchId || !taskId) continue;
      let batch = await orca.delivery(runId);
      const seenDeliveries = new Set<string>();
      while (batch) {
        const delivery = batch;
        if (Date.now() >= state.deadline || seenDeliveries.has(delivery.deliveryId)) throw new Error("worker-delivery-replay-unproven");
        seenDeliveries.add(delivery.deliveryId);
        // Validate all rows before any mutation: an unrelated sibling or question keeps the batch unacked.
        const handled = delivery.messages.map(message => {
          let payload: Record<string, unknown> | undefined;
          try { payload = typeof message.payload === "string" ? asRecord(JSON.parse(message.payload)) : undefined; } catch { /* fail closed below */ }
          if (delivery.runId !== runId || message.run_id !== runId || !readString(message, "id")
            || payload?.dispatchId !== dispatchId || payload.taskId !== taskId
            || !["worker_done", "heartbeat", "status"].includes(String(message.type))) throw new Error("worker-delivery-not-owned");
          return { message, payload };
        });
        for (const { message, payload } of handled) {
          const observed = await orca.observe(dispatchId);
          if (observed.dispatchId !== dispatchId || observed.runId !== runId || observed.taskId !== taskId) throw new Error("worker-settlement-unproven");
          const messageKey = `worker-message:${message.id}`;
          if (message.type === "worker_done") {
            if (!observed.outcome || !observed.completedAt || observed.outcome !== payload.outcome
              || observed.resource?.ownerDispatchId !== dispatchId) throw new Error("worker-settlement-unproven");
            const existing = await journal.persistedEffect(current, messageKey);
            let reportProof: ReportProof | undefined;
            if (!existing?.receipt && role === "reviewer" && observed.outcome === "succeeded") {
              const request = parseReportRequest(current.effects.find(effect => effect.key === "review-report-request")?.intent.request);
              if (!request) throw new Error("worker-report-request-missing");
              reportProof = await orca.readReport(request, { runId, taskId, dispatchId }, delivery);
            }
            const evidence = existing?.receipt ?? { message, outcome: observed.outcome, completedAt: observed.completedAt,
              worktreeId: observed.worktreeId ?? "", ...(reportProof ? { reportProof } : {}) };
            current = await journal.effect(current, lock, messageKey, { runId, dispatchId, taskId, deliveryId: delivery.deliveryId },
              async () => ({ kind: "found", receipt: evidence }), async () => { throw new Error("worker-evidence-missing"); });
            if (role === "reviewer" && observed.outcome === "succeeded") {
              const proof = reportProof ?? asRecord(evidence.reportProof);
              const request = parseReportRequest(current.effects.find(effect => effect.key === "review-report-request")?.intent.request);
              if (!proof || !request) throw new Error("worker-report-proof-missing");
              current = await journal.effect(current, lock, "review-report-proof", { request, runId, taskId, dispatchId },
                async () => ({ kind: "found", receipt: { proof } }), async () => { throw new Error("worker-report-proof-missing"); });
            }
            current = await journal.effect(current, lock, `worker-release:${dispatchId}`, { runId, dispatchId, taskId },
              async () => {
                const worker = await orca.observe(dispatchId);
                if (worker.runId !== runId || worker.taskId !== taskId || !worker.outcome || !worker.completedAt
                  || worker.resource?.ownerDispatchId !== dispatchId) return { kind: "unknown" };
                return worker.resource.state === "released" && worker.resource.releaseState === "released"
                  ? { kind: "found", receipt: { dispatchId, released: true } } : { kind: "absent" };
              },
              async () => {
                await orca.release(dispatchId);
                const worker = await orca.observe(dispatchId);
                if (worker.resource?.ownerDispatchId !== dispatchId || worker.resource.state !== "released"
                  || worker.resource.releaseState !== "released") throw new Error("worker-release-unverified");
                return { dispatchId, released: true };
              });
          } else {
            current = await journal.effect(current, lock, messageKey, { runId, dispatchId, taskId, deliveryId: delivery.deliveryId },
              async () => ({ kind: "found", receipt: { message } }), async () => { throw new Error("worker-evidence-missing"); });
          }
        }
        let next = await orca.delivery(runId);
        current = await journal.effect(current, lock, `worker-ack:${delivery.deliveryId}`, { runId, deliveryId: delivery.deliveryId },
          async () => next?.deliveryId !== delivery.deliveryId ? { kind: "found", receipt: { acknowledged: delivery.deliveryId } } : { kind: "absent" },
          async () => { next = await orca.acknowledge(runId, delivery.deliveryId); return { acknowledged: delivery.deliveryId }; });
        batch = next;
      }
      // Ack may have applied before its receipt: the next check no longer returns that delivery.
      for (const message of current.effects.filter(effect => effect.key.startsWith("worker-message:") && effect.intent.runId === runId
        && effect.intent.dispatchId === dispatchId && effect.intent.taskId === taskId && effect.receipt)) {
        const deliveryId = readString(message.intent, "deliveryId");
        const savedMessage = asRecord(message.receipt?.message);
        if (!deliveryId || (savedMessage?.type === "worker_done" && !current.effects.some(effect => effect.key === `worker-release:${dispatchId}` && effect.receipt))) continue;
        const pendingAck = await journal.persistedEffect(current, `worker-ack:${deliveryId}`);
        if (pendingAck && !pendingAck.receipt) current = await journal.effect(current, lock, `worker-ack:${deliveryId}`, pendingAck.intent,
          async () => {
            const delivery = await orca.delivery(runId);
            return delivery?.deliveryId === deliveryId ? { kind: "unknown" } : { kind: "found", receipt: { acknowledged: deliveryId } };
          }, async () => { throw new Error("worker-ack-unproven"); });
      }
      const observed = await orca.observe(dispatchId);
      if (observed.outcome && !current.effects.some(effect => effect.key === `worker-release:${dispatchId}` && effect.receipt)) {
        throw new Error("worker-settlement-delivery-missing");
      }
    }
    return current;
  }

  private async advance(state: MaintenanceState, lock: LockRecord): Promise<MaintenanceState> {
    const { policy, journal, github, orca } = this.context;
    const dispatchOf = (role: string) => state.effects.find(effect => effect.key === role)?.receipt?.dispatchId as string | undefined;
    const worktreeOf = async (dispatchId: string | undefined): Promise<string | undefined> => {
      if (!dispatchId) return undefined;
      const worker = await orca.observe(dispatchId);
      return worker.worktreeId?.split("::")[1];
    };

    switch (state.stage) {
      case "locked": {
        const applied = await this.dispatch(state, lock, "executor", state.generation.baseSha, `maint-exec-${state.pr.candidateVersion}`);
        const last = applied.effects.find(effect => effect.key === "executor")?.receipt;
        if (!last) return this.transition(applied, lock, "blocked", { refusal: "executor-dispatch-missing" });
        return this.transition(applied, lock, "working");
      }
      case "working": {
        const dispatchId = dispatchOf("executor");
        if (!dispatchId) return this.transition(state, lock, "blocked", { refusal: "executor-dispatch-missing" });
        const worker = await orca.observe(dispatchId);
        if (worker.outcome === "failed") return this.transition(state, lock, "blocked", { refusal: "executor-failed" });
        if (worker.outcome !== "succeeded") return state;
        const worktree = await worktreeOf(dispatchId);
        if (!worktree) return this.transition(state, lock, "blocked", { refusal: "worker-worktree-unverified" });
        try {
          assertOrigin(worktree, policy.repository);
        } catch {
          return this.transition(state, lock, "blocked", { refusal: "executor-worktree-foreign" });
        }
        const plan = planPaths(changedEntries(worktree), policy, state.pr.candidateVersion);
        if (plan.rejected.length > 0) {
          return this.transition(state, lock, "blocked", { refusal: `path-outside-policy:${plan.rejected[0]!.path}` });
        }
        const evidence = await collectSemanticEvidence(
          worktree, state.generation.baseSha, state.pr.candidateVersion, this.context.supportedVersions, plan.approved,
          undefined, this.context.measurementEnvironment,
        );
        if ("failure" in evidence) return this.transition(state, lock, "blocked", { refusal: evidence.failure });
        const verdict = validateSemantic(evidence, policy);
        if (!verdict.ok) return this.transition(state, lock, "blocked", { refusal: verdict.reason });
        return this.transition(state, lock, "prepared");
      }
      case "prepared": {
        const worktree = await worktreeOf(dispatchOf("executor"));
        if (!worktree) return this.transition(state, lock, "blocked", { refusal: "worker-worktree-unverified" });
        const saved = await journal.persistedEffect(state, "commit");
        let intent: Readonly<Record<string, unknown>>;
        if (saved) {
          intent = saved.intent;
        } else {
          const plan = planPaths(changedEntries(worktree), policy, state.pr.candidateVersion);
          if (plan.rejected.length > 0 || plan.approved.length === 0) return this.transition(state, lock, "blocked", { refusal: "no-approved-changes" });
          intent = { base: state.generation.baseSha, releaseVersion: state.releaseVersion,
            message: `Поддержка OMP ${state.pr.candidateVersion}`, paths: plan.approved,
            treeHash: intendedTree(worktree, state.generation.baseSha, plan.approved), contentHash: await contentHash(worktree, plan.approved) };
        }
        const paths = intent.paths;
        const message = intent.message;
        const intended = intent.treeHash;
        if (intent.base !== state.generation.baseSha || intent.releaseVersion !== state.releaseVersion
          || message !== `Поддержка OMP ${state.pr.candidateVersion}` || typeof intended !== "string" || !/^[a-f0-9]{40}$/.test(intended)
          || !Array.isArray(paths) || paths.length === 0 || paths.some(path => typeof path !== "string")
          || planPaths(paths.map(path => ({ path, status: "M " })), policy, state.pr.candidateVersion).rejected.length > 0
          || intent.contentHash !== await contentHash(worktree, paths)) throw new Error("commit-intent-unverifiable");
        const observed = observeCommit(worktree, state.generation.baseSha, paths, message, intended);
        if (observed.kind === "unknown" || (saved?.receipt && (observed.kind !== "found" || saved.receipt.headSha !== observed.receipt.headSha
          || saved.receipt.treeHash !== observed.receipt.treeHash))) throw new Error("commit-receipt-unverified");
        const applied = await journal.effect(state, lock, "commit", intent,
          async () => observed,
          async () => {
            const head = commitApproved(worktree, paths, message, state.generation.baseSha, intended);
            if (parentOf(worktree, head) !== state.generation.baseSha) throw new Error("commit-parent-unexpected");
            const packageVersion = readString(asRecord(JSON.parse(await Bun.file(`${worktree}/package.json`).text())), "version");
            if (packageVersion !== state.releaseVersion) throw new Error("package-release-version-mismatch");
            return { headSha: head, treeHash: intended };
          });
        const headSha = applied.effects.find(effect => effect.key === "commit")?.receipt?.headSha as string;
        if (!/^[a-f0-9]{40}$/.test(headSha)) return this.transition(applied, lock, "blocked", { refusal: "commit-receipt-unverified" });
        return this.transition(applied, lock, "pushed", { pr: { ...state.pr, headSha } });
      }
      case "pushed": {
        const worktree = await worktreeOf(dispatchOf("executor"));
        if (!worktree) return this.transition(state, lock, "blocked", { refusal: "worker-worktree-unverified" });
        // Отправка — тоже эффект: наблюдается фактическая голова удалённой ветви, а не догадка.
        const pushed = await journal.effect(state, lock, "push",
          { branch: state.pr.branch, headSha: state.pr.headSha, repository: policy.repository },
          async () => {
            const remote = await github.remoteBranchHead(state.pr.branch);
            if (remote === state.pr.headSha) return { kind: "found", receipt: { headSha: remote } };
            if (remote === undefined) return { kind: "absent" };
            return { kind: "conflict" };
          },
          async () => {
            await github.pushRef(worktree, state.pr.branch, state.pr.headSha);
            const remote = await github.remoteBranchHead(state.pr.branch);
            if (remote !== state.pr.headSha) throw new Error("push-receipt-unverified");
            return { headSha: state.pr.headSha };
          });
        const applied = await journal.effect(pushed, lock, "draft-pr",
          { branch: state.pr.branch, baseSha: state.generation.baseSha, headSha: state.pr.headSha },
          async () => {
            const existing = (await github.openPullRequests()).find(pr => pr.branch === state.pr.branch && pr.headSha === state.pr.headSha);
            return existing ? { kind: "found", receipt: { number: existing.number } } : { kind: "absent" };
          },
          async () => {
            const number = await github.createDraft(state.pr.branch, state.generation.baseSha, state.pr.headSha, state.pr.candidateVersion);
            return { number, branch: state.pr.branch, baseSha: state.generation.baseSha, headSha: state.pr.headSha };
          });
        const number = applied.effects.find(effect => effect.key === "draft-pr")?.receipt?.number as number;
        return this.transition(applied, lock, "reviewing", { pr: { ...state.pr, number } });
      }
      case "reviewing": {
        const applied = await this.dispatch(state, lock, "reviewer", state.pr.headSha, `maint-review-${state.pr.candidateVersion}`);
        const reviewerDispatch = applied.effects.find(effect => effect.key === "reviewer")?.receipt?.dispatchId as string | undefined;
        if (!reviewerDispatch) return this.transition(applied, lock, "blocked", { refusal: "reviewer-dispatch-missing" });
        const executorDispatch = dispatchOf("executor");
        if (reviewerDispatch === executorDispatch) return this.transition(applied, lock, "blocked", { refusal: "reviewer-not-independent" });
        const reviewerWorktree = await worktreeOf(reviewerDispatch);
        const executorWorktree = await worktreeOf(executorDispatch);
        if (!reviewerWorktree || !executorWorktree || reviewerWorktree === executorWorktree) {
          return this.transition(applied, lock, "blocked", { refusal: "reviewer-worktree-not-independent" });
        }
        const observed = await orca.observe(reviewerDispatch);
        if (observed.outcome === "failed") return this.transition(applied, lock, "blocked", { refusal: "reviewer-failed" });
        if (observed.outcome !== "succeeded") return applied;
        const request = parseReportRequest(applied.effects.find(effect => effect.key === "review-report-request")?.intent.request);
        const binding = applied.effects.find(effect => effect.key === "review-report-binding")?.receipt;
        const runId = readString(binding, "runId"); const taskId = readString(binding, "taskId");
        if (!request || !runId || !taskId || binding?.dispatchId !== reviewerDispatch) throw new Error("worker-report-binding-missing");
        if (observed.runId !== runId || observed.taskId !== taskId || !observed.completedAt
          || observed.resource?.ownerDispatchId !== reviewerDispatch) throw new Error("worker-settlement-unproven");
        const savedProof = asRecord(applied.effects.find(effect => effect.key === "review-report-proof")?.receipt?.proof);
        const proof = savedProof ? { ...savedProof, ...await verifyReportFile(request, String(savedProof.reportSha256)) }
          : await orca.readReport(request, { runId, taskId, dispatchId: reviewerDispatch });
        const proved = await journal.effect(applied, lock, "review-report-proof", { request, runId, taskId, dispatchId: reviewerDispatch },
          async () => ({ kind: "found", receipt: { proof } }), async () => { throw new Error("worker-report-proof-missing"); });
        const verdict = proof.verdict;
        if (verdict.verdict !== "approved" || verdict.headSha !== state.pr.headSha
          || verdict.baseSha !== state.generation.baseSha || verdict.evidenceHashes.length === 0) {
          return this.transition(proved, lock, "blocked", { refusal: "review-not-approved" });
        }
        // Ревьюер обязан смотреть на точный проверяемый коммит в СВОЁМ дереве: иначе вердикт относится к
        // другому состоянию, и проверка смысла ниже ничего не доказывает.
        let reviewerHead: string;
        try {
          reviewerHead = currentHead(reviewerWorktree);
        } catch {
          return this.transition(proved, lock, "blocked", { refusal: "reviewer-worktree-head-unavailable" });
        }
        if (reviewerHead !== state.pr.headSha) {
          return this.transition(proved, lock, "blocked", { refusal: "reviewer-worktree-head-mismatch" });
        }
        // Ревьюер не вносит правок: грязное дерево или индекс означают, что проверялось не то состояние.
        try {
          assertCleanWorktree(reviewerWorktree);
        } catch {
          return this.transition(proved, lock, "blocked", { refusal: "reviewer-worktree-dirty" });
        }
        // Набор изменений генерации берётся из истории (база → голова), а не из статуса рабочего дерева:
        // чистое дерево на проверяемом коммите не имеет незакоммиченных изменений.
        let committed: readonly string[];
        try {
          committed = committedPaths(reviewerWorktree, state.generation.baseSha, state.pr.headSha);
        } catch {
          return this.transition(proved, lock, "blocked", { refusal: "committed-diff-unavailable" });
        }
        const reviewerPaths = planPaths(
          committed.map(path => ({ path, status: "M " })), policy, state.pr.candidateVersion,
        );
        if (reviewerPaths.rejected.length > 0) {
          return this.transition(proved, lock, "blocked", { refusal: `path-outside-policy:${reviewerPaths.rejected[0]!.path}` });
        }
        // Доказательства пересчитываются в дереве РЕВЬЮЕРА: строки ревью обязаны совпасть с фактическим
        // каталогом проверяемого коммита, а не с произвольным текстом.
        const reviewerEvidence = await collectSemanticEvidence(
          reviewerWorktree, state.generation.baseSha, state.pr.candidateVersion,
          this.context.supportedVersions, reviewerPaths.approved, verdict.reviewRows,
          this.context.measurementEnvironment,
        );
        if ("failure" in reviewerEvidence) {
          return this.transition(proved, lock, "blocked", { refusal: reviewerEvidence.failure });
        }
        const semantic = validateSemantic(reviewerEvidence, policy);
        if (!semantic.ok) return this.transition(proved, lock, "blocked", { refusal: semantic.reason });
        // Отпечатки доказательств сверяются как множество: контроллер сам считает канонический набор из
        // проверяемого коммита и содержимого изменённых файлов, и он обязан совпасть ровно — без пропусков и
        // без лишних записей.
        let canonicalEvidence: readonly string[];
        try {
          canonicalEvidence = await evidenceSet(reviewerWorktree, state.pr.headSha, reviewerPaths.approved);
        } catch {
          return this.transition(proved, lock, "blocked", { refusal: "evidence-set-unavailable" });
        }
        const suppliedEvidence = [...new Set(verdict.evidenceHashes)].sort();
        if (suppliedEvidence.length !== canonicalEvidence.length
          || suppliedEvidence.some((hash, index) => hash !== canonicalEvidence[index])) {
          return this.transition(proved, lock, "blocked", { refusal: "review-evidence-set-mismatch" });
        }
        // Готовность PR — внешняя мутация, поэтому она проходит через журнал, а не мимо него.
        const ready = await journal.effect(proved, lock, "pr-ready",
          { number: state.pr.number, headSha: state.pr.headSha },
          async () => {
            const pr = await github.observePr(state.pr.number);
            return pr.draft ? { kind: "absent" } : { kind: "found", receipt: { number: pr.number, headSha: pr.headSha } };
          },
          async () => {
            await github.markReady(state.pr.number, state.pr.headSha);
            return { number: state.pr.number, headSha: state.pr.headSha };
          });
        return this.transition(ready, lock, "verifying", {
          reviewVerdict: {
            headSha: verdict.headSha,
            baseSha: verdict.baseSha,
            evidenceHashes: verdict.evidenceHashes,
          },
        });
      }
      case "verifying": {
        const savedMerge = await journal.persistedEffect(state, "merge");
        const base = await github.mainSha();
        let recovered = state;
        if (savedMerge) {
          const intent = savedMerge.intent;
          if (intent.headSha !== state.pr.headSha || intent.baseSha !== state.generation.baseSha || intent.number !== state.pr.number
            || intent.branch !== state.pr.branch || intent.repository !== policy.repository) throw new Error("merge-intent-unverifiable");
          const pr = await github.observePr(state.pr.number);
          if (pr.repository !== policy.repository || pr.number !== state.pr.number || pr.branch !== state.pr.branch
            || pr.headSha !== state.pr.headSha || (!pr.merged && pr.baseSha !== state.generation.baseSha) || pr.baseBranch !== policy.baseBranch
            || pr.author !== policy.controllerLogin || pr.authorType !== policy.controllerType) throw new Error("merge-owner-mismatch");
          if (pr.merged) {
            if (!pr.mergeSha || !/^[a-f0-9]{40}$/.test(pr.mergeSha) || (savedMerge.receipt && savedMerge.receipt.mergeSha !== pr.mergeSha)) throw new Error("merge-receipt-unverified");
            recovered = await journal.effect(state, lock, "merge", intent,
              async () => ({ kind: "found", receipt: { mergeSha: pr.mergeSha } }), async () => { throw new Error("merge-already-applied"); });
          } else if (savedMerge.receipt) throw new Error("merge-receipt-unverified");
          else throw new Error("merge-intent-unverifiable");
        }
        if (!recovered.effects.some(effect => effect.key === "merge" && effect.receipt) && base !== state.generation.baseSha) {
          return this.transition(recovered, lock, "blocked", { refusal: "base-advanced" });
        }
        let applied = recovered;
        if (!recovered.effects.some(effect => effect.key === "merge" && effect.receipt)) {
        // Метаданные выпуска проверяются на фактическом дереве исполнителя: версия пакета, заголовок
        // CHANGELOG и незанятый тег. Контроллер их не синтезирует — если исполнитель их не подготовил,
        // стадия блокируется, и тег не ставится.
        const releaseWorktree = await worktreeOf(dispatchOf("executor"));
        if (!releaseWorktree) return this.transition(state, lock, "blocked", { refusal: "worker-worktree-unverified" });
        const metadata = await this.validateReleaseMetadata(releaseWorktree, state.releaseVersion);
        if (!metadata.ok) return this.transition(state, lock, "blocked", { refusal: metadata.reason });
        const versions = [...new Set([...this.context.supportedVersions, state.pr.candidateVersion])];
        const checks: readonly CheckRun[] = await github.checksFor(state.pr.headSha);
        const gate = github.requiredChecksPassed(checks, state.pr.headSha, versions);
        if (!gate.ok) {
          return gate.reason.includes("pending") ? state : this.transition(state, lock, "blocked", { refusal: gate.reason });
        }
        applied = await journal.effect(recovered, lock, "merge",
          { headSha: state.pr.headSha, baseSha: state.generation.baseSha, number: state.pr.number, branch: state.pr.branch, repository: policy.repository },
          async () => {
            const pr = await github.observePr(state.pr.number);
            if (pr.repository !== policy.repository || pr.headSha !== state.pr.headSha || pr.baseSha !== state.generation.baseSha
              || pr.branch !== state.pr.branch || pr.baseBranch !== policy.baseBranch || pr.author !== policy.controllerLogin
              || pr.authorType !== policy.controllerType || pr.number !== state.pr.number) return { kind: "conflict" };
            return pr.merged && pr.mergeSha ? { kind: "found", receipt: { mergeSha: pr.mergeSha } } : { kind: "absent" };
          },
          async () => ({ mergeSha: (await github.merge(state.pr.number, state.pr.headSha)).mergeSha }));
        }
        const mergeSha = applied.effects.find(effect => effect.key === "merge")?.receipt?.mergeSha as string;
        // Удаление временной ветви — внешняя мутация, поэтому она тоже проходит через журнал.
        const cleaned = await journal.effect(applied, lock, "branch-deleted", { branch: state.pr.branch, mergeSha },
          async () => {
            const head = await github.remoteBranchHead(state.pr.branch);
            return head === undefined ? { kind: "found", receipt: { branch: state.pr.branch } } : { kind: "absent" };
          },
          async () => {
            await github.deleteBranch(state.pr.branch);
            const head = await github.remoteBranchHead(state.pr.branch);
            if (head !== undefined) throw new Error("branch-delete-unverified");
            return { branch: state.pr.branch };
          });
        return this.transition(cleaned, lock, "merged", { pr: { ...state.pr, baseSha: mergeSha } });
      }
      case "merged": {
        const mergeSha = state.effects.find(effect => effect.key === "merge")?.receipt?.mergeSha as string;
        if (!/^\d+\.\d+\.\d+$/.test(state.releaseVersion)) {
          return this.transition(state, lock, "blocked", { refusal: "release-version-missing" });
        }
        const tag = `v${state.releaseVersion}`;
        const applied = await journal.effect(state, lock, "tag", { tag, sha: mergeSha },
          async () => {
            const target = await github.tagTarget(tag);
            if (!target) return { kind: "absent" };
            if (target !== mergeSha) throw new Error("tag-conflict");
            return { kind: "found", receipt: { tag, sha: target } };
          },
          async () => {
            await github.tag(tag, mergeSha);
            return { tag, sha: mergeSha };
          });
        return this.transition(applied, lock, "released");
      }
      case "released": {
        const tag = state.effects.find(effect => effect.key === "tag")?.receipt?.tag as string;
        const mergeSha = state.effects.find(effect => effect.key === "merge")?.receipt?.mergeSha as string;
        const target = await github.tagTarget(tag);
        if (target !== mergeSha) return this.transition(state, lock, "blocked", { refusal: "tag-target-mismatch" });
        // Прогон `check.yml` на слитом коммите: нечитаемый ответ не утверждает ничего, отсутствие — ожидание
        // в пределах stage deadline.
        const run = await github.checkWorkflowRun(mergeSha);
        if (run.kind === "unknown") return this.transition(state, lock, "blocked", { refusal: "check-run-unreadable" });
        if (run.kind === "absent") return state;
        // Проверка выпуска выполняется заново на каждом прогоне и не подменяется константой: это чистое
        // наблюдение, поэтому доказательство пишется состоянием, а не «эффектом» с выдуманным receipt-ом.
        const verified = await github.verifyPublishedRelease(tag, run.runId, mergeSha);
        if (verified.kind === "pending") return state;
        if (verified.kind === "blocked") return this.transition(state, lock, "blocked", { refusal: verified.reason });
        const settled = await this.settleWorkers(state, lock);
        return this.transition(settled, lock, "done", {
          releaseProof: { tag, mergeSha, checkRun: run.runId },
          refusal: undefined,
        });
      }
      default:
        return state;
    }
  }

  /**
   * Метаданные выпуска, подготовленные исполнителем.
   *
   * Проверяется фактическое содержимое дерева: версия `package.json` равна ожидаемой версии выпуска, а в
   * `CHANGELOG.md` есть заголовок этой версии. Контроллер ничего не подставляет: отсутствие метаданных —
   * блокировка, а не скрытая правка. Незанятость тега проверяется отдельным эффектом `tag`.
   */
  private async validateReleaseMetadata(
    worktree: string, releaseVersion: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const packageFile = Bun.file(`${worktree}/package.json`);
    if (!await packageFile.exists()) return { ok: false, reason: "package-json-missing" };
    const version = (JSON.parse(await packageFile.text()) as { version?: string }).version;
    if (version !== releaseVersion) return { ok: false, reason: "package-release-version-mismatch" };
    const changelog = Bun.file(`${worktree}/CHANGELOG.md`);
    if (!await changelog.exists()) return { ok: false, reason: "changelog-missing" };
    const heading = new RegExp(`^##\\s+\\[?${releaseVersion.replaceAll(".", "\\.")}\\]?`, "m");
    if (!heading.test(await changelog.text())) return { ok: false, reason: "changelog-version-missing" };
    return { ok: true };
  }
}

async function gitHead(worktree: string): Promise<string> {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}

async function registryLatest(policy: ControllerPolicy): Promise<string> {
  const response = await fetch("https://registry.npmjs.org/@oh-my-pi/pi-coding-agent", {
    signal: AbortSignal.timeout(policy.deadlinesMs.command),
  });
  if (!response.ok) throw new Error("registry-unavailable");
  const body = await response.json() as { "dist-tags"?: Record<string, string> };
  const latest = body["dist-tags"]?.latest;
  if (typeof latest !== "string") throw new Error("registry-version-unavailable");
  return latest;
}


export { gitHead };

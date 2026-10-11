import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadAcceptedPolicy } from "./maintenance/policy";
import { Journal } from "./maintenance/journal";
import { GitHub, type GithubPort } from "./maintenance/github";
import { Orca, type OrcaPort } from "./maintenance/orca";
import { Controller } from "./maintenance/controller";
import { decidePrecheck, exitCode, type PrecheckDecision } from "./maintenance/precheck";
import { assertCleanWorktree, assertOrigin, currentHead } from "./maintenance/tree";
import { asRecord, readNumber, readPath, readString } from "./maintenance/json";
import { ACCEPTANCE_SCENARIO_FILES, ACCEPTANCE_SCENARIOS, type AcceptanceScenario } from "./maintenance/acceptance-scenarios";
import type { CheckRun, ControllerPolicy } from "./maintenance/contracts";
import { bindReportRequest, createReportRequest, loadReportBinding, loadReportRequest, type ReportProof } from "./maintenance/report";

/**
 * CLI контроллера сопровождения.
 *
 * Отдельная точка входа: ручной обновлятор по пину (`scripts/maintenance.ts`) остаётся ровно тем, чем был.
 *
 * `run` выполняет внешние действия, поэтому до него обязательна локальная приёмка. Приёмка здесь — не запись
 * идентификаторов, а **факт наблюдения**: `accept` сам опрашивает принятый коммит у GitHub, сам опрашивает
 * Orca и сам пересчитывает отпечатки, а из файла доказательства берёт только ссылки (какой Run, какой
 * dispatch) и байты отчёта. Проверяемые поля в receipt записывает верификатор, а не автор файла.
 */

/**
 * Локальная приёмка.
 *
 * Запись привязана к содержимому дерева контроллера, к политике из принятого коммита и к самому коммиту.
 * Доказательство состоит из наблюдений: отпечаток отчёта локального E2E по фактическим байтам, точная
 * проверка на принятом коммите с её именем/путём/событием/головой/результатом, подтверждённый dispatch
 * исполнителя в своём Run и подтверждённый вердикт независимого ревьюера на том же коммите.
 */
export interface AcceptanceReceipt {
  readonly schemaVersion: 1;
  readonly treeHash: string;
  readonly policyDigest: string;
  readonly acceptedBaseSha: string;
  /** Путь к структурированному отчёту локального E2E: байты перехешируются при каждой сверке. */
  readonly evidencePath: string;
  /** Отпечаток фактических байтов отчёта. */
  readonly evidenceHash: string;
  /** Точная проверка на принятом коммите: идентификатор, имя, путь workflow, событие, голова, результат. */
  readonly check: {
    readonly checkRunId: string;
    readonly name: string;
    readonly workflowPath: string;
    readonly event: string;
    readonly headSha: string;
    readonly status: string;
    readonly conclusion: string;
    readonly workflowRunId: string;
  };
  /** Подтверждённые вердикт независимого ревью и его dispatch (с Run, к которому он принадлежит). */
  readonly review: { readonly dispatchId: string; readonly runId: string; readonly taskId: string; readonly requestPath: string; readonly headSha: string; readonly verdict: string; readonly proof: ReportProof };
  /** Подтверждённый dispatch исполнителя в своём Run. */
  readonly dispatch: { readonly dispatchId: string; readonly runId: string; readonly worktreeId: string };
  readonly acceptedAt: string;
  /** Команда прогона, из которой получено доказательство, — для читаемости записи. */
  readonly evidenceCommand: string;
}

/**
 * Структурированное доказательство продюсера: факты прогона и ссылки на реальные dispatch-и.
 *
 * `passed` и отпечатки считает продюсер из фактического прогона (код выхода, неизменность дерева до и после),
 * а не пользователь. Значения отпечатков отсюда снова вычисляются верификатором: файл предъявляет факты, а не
 * доверие.
 */
export interface AcceptanceEvidence {
  readonly schemaVersion: 1;
  readonly kind: "acceptance-evidence";
  readonly passed: boolean;
  readonly exitCode: number;
  readonly command: string;
  readonly scenarios: readonly { readonly name: string; readonly file: string; readonly testsExecuted: number; readonly passed: boolean }[];
  /** Дерево контроллера до и после прогона: доказательство, что тесты не меняли проверяемый источник. */
  readonly treeBefore: string;
  readonly treeAfter: string;
  readonly treeHash: string;
  readonly policyDigest: string;
  readonly acceptedBaseSha: string;
  /** Реальные ссылки на завершённые dispatch-и: исполнителя и независимого ревьюера. */
  readonly dispatch: { readonly runId: string; readonly dispatchId: string };
  readonly review: { readonly runId: string; readonly dispatchId: string; readonly requestPath: string };
  readonly producedAt: string;
}

/**
 * Обязательный набор сценариев приёмки — источник истины для продюсера доказательства.
 *
 * Объявлен в листовом модуле `./maintenance/acceptance-scenarios`, потому что тот же список нужен семантическому
 * гейту: объявление здесь замыкало бы цикл модулей CLI → контроллер → продюсер → CLI. Здесь он только
 * переэкспортируется, чтобы потребители продюсера продолжали читать его с прежнего пути.
 */
export { ACCEPTANCE_SCENARIOS, type AcceptanceScenario };

/**
 * Файлы, отпечаток которых и есть проверяемое дерево контроллера: код контроллера, политика и **файлы
 * обязательных сценариев приёмки**.
 *
 * Сценарии входят в отпечаток, потому что доказательство продюсера состоит именно из факта их прогона:
 * без них кандидат мог бы переписать проверку в том же коммите, который она же и приёмлет.
 */
const CONTROLLER_FILES = [
  ...ACCEPTANCE_SCENARIO_FILES,
  "scripts/maintenance/acceptance-scenarios.ts",
  "scripts/maintenance-controller.ts",
  "scripts/maintenance-acceptance-smoke.ts",
  "scripts/maintenance/contracts.ts",
  "scripts/maintenance/policy.ts",
  "scripts/maintenance/precheck.ts",
  "scripts/maintenance/journal.ts",
  "scripts/maintenance/github.ts",
  "scripts/maintenance/orca.ts",
  "scripts/maintenance/report.ts",
  "scripts/maintenance/semantic.ts",
  "scripts/maintenance/measurement-environment.ts",
  "scripts/maintenance/tree.ts",
  "scripts/maintenance/json.ts",
  "scripts/maintenance/controller.ts",
  "maintenance.config.json",
] as const;

/** Отпечаток фактического содержимого дерева контроллера — не версия и не имя ветви. */
export async function controllerTreeHash(checkout: string): Promise<string> {
  const hasher = createHash("sha256");
  for (const path of CONTROLLER_FILES) {
    const file = Bun.file(join(checkout, path));
    hasher.update(path);
    hasher.update("\0");
    hasher.update(await file.exists() ? await file.text() : "<absent>");
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function usage(): never {
  throw new Error(
    "usage: bun scripts/maintenance-controller.ts (--precheck | status | --policy-digest | --preflight) [--checkout <dir>] [--state-dir <dir>] | run [--checkout <dir>] [--state-dir <dir>] | accept --evidence <file.json> [--checkout <dir>] [--state-dir <dir>]",
  );
}

/** Проверка формы приёмки: обязательные поля и их вид. Содержание проверяет повторное наблюдение. */
export function acceptanceErrors(receipt: unknown): readonly string[] {
  const record = asRecord(receipt);
  if (!record) return ["not-object"];
  const errors: string[] = [];
  const sha40 = (value: string | undefined): boolean => value !== undefined && /^[a-f0-9]{40}$/.test(value);
  const sha64 = (value: string | undefined): boolean => value !== undefined && /^[a-f0-9]{64}$/.test(value);
  if (readNumber(record, "schemaVersion") !== 1) errors.push("schema-version");
  if (!sha64(readString(record, "treeHash"))) errors.push("tree-hash");
  if (!sha64(readString(record, "policyDigest"))) errors.push("policy-digest");
  if (!sha40(readString(record, "acceptedBaseSha"))) errors.push("accepted-base");
  if (!readString(record, "evidencePath")) errors.push("evidence-path");
  if (!sha64(readString(record, "evidenceHash"))) errors.push("evidence-hash");
  const check = asRecord(record.check);
  if (!check) errors.push("check");
  else {
    const checkRunId = readString(check, "checkRunId");
    if (checkRunId === undefined || !/^\d+$/.test(checkRunId)) errors.push("check-run");
    const workflowRunId = readString(check, "workflowRunId");
    if (workflowRunId === undefined || !/^\d+$/.test(workflowRunId)) errors.push("check-workflow");
    if (!readString(check, "name")) errors.push("check-name");
    if (!readString(check, "workflowPath")) errors.push("check-path");
    if (readString(check, "event") !== "push") errors.push("check-event");
    if (!sha40(readString(check, "headSha"))) errors.push("check-head");
    if (readString(check, "status") !== "completed") errors.push("check-status");
    if (readString(check, "conclusion") !== "success") errors.push("check-conclusion");
  }
  const review = asRecord(record.review);
  if (!review) errors.push("review");
  else {
    if (!readString(review, "dispatchId")) errors.push("review-dispatch");
    if (!readString(review, "runId")) errors.push("review-run");
    if (!sha40(readString(review, "headSha"))) errors.push("review-head");
    if (readString(review, "verdict") !== "approved") errors.push("review-verdict");
    if (!readString(review, "taskId") || !readString(review, "requestPath") || !asRecord(review.proof)) errors.push("review-proof");
  }
  const dispatch = asRecord(record.dispatch);
  if (!dispatch) errors.push("dispatch");
  else {
    if (!readString(dispatch, "dispatchId")) errors.push("dispatch-id");
    if (!readString(dispatch, "runId")) errors.push("dispatch-run");
    const worktreeId = readString(dispatch, "worktreeId");
    if (worktreeId === undefined || !worktreeId.includes("::")) errors.push("dispatch-worktree");
  }
  const acceptedAt = readString(record, "acceptedAt");
  if (acceptedAt === undefined || Number.isNaN(Date.parse(acceptedAt))) errors.push("accepted-at");
  return errors;
}

/**
 * Разбор и проверка доказательства продюсера.
 *
 * Возвращает нормализованное доказательство или причину отказа. Здесь проверяется, что `passed` выведен из
 * фактического прогона: код выхода нулевой, дерево контроллера до и после совпадает, обязательный набор
 * сценариев присутствует и в каждом выполнено хотя бы по одному тесту.
 */
function parseEvidence(
  record: Readonly<Record<string, unknown>>, treeHash: string, digest: string, baseSha: string,
): { ok: true; evidence: AcceptanceEvidence } | { ok: false; reason: string } {
  if (readNumber(record, "schemaVersion") !== 1) return { ok: false, reason: "schema-version" };
  if (readString(record, "kind") !== "acceptance-evidence") return { ok: false, reason: "kind" };
  if (record.passed !== true) return { ok: false, reason: "not-passed" };
  if (readNumber(record, "exitCode") !== 0) return { ok: false, reason: "exit-code" };
  const command = readString(record, "command");
  if (!command) return { ok: false, reason: "command" };

  const treeBefore = readString(record, "treeBefore");
  const treeAfter = readString(record, "treeAfter");
  const stamped = readString(record, "treeHash");
  const sha64 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
  if (treeBefore === undefined || treeAfter === undefined || stamped === undefined
    || !sha64(treeBefore) || !sha64(treeAfter) || !sha64(stamped)) {
    return { ok: false, reason: "tree-hash" };
  }
  // Дерево не изменилось прогоном и совпадает с тем, на которое выдаётся приёмка: иначе тесты проверяли не то.
  if (treeBefore !== treeAfter) return { ok: false, reason: "tree-changed-by-run" };
  if (stamped !== treeBefore || stamped !== treeHash) return { ok: false, reason: "tree-mismatch" };
  if (readString(record, "policyDigest") !== digest) return { ok: false, reason: "policy-mismatch" };
  if (readString(record, "acceptedBaseSha") !== baseSha) return { ok: false, reason: "base-mismatch" };

  const rawScenarios = record.scenarios;
  if (!Array.isArray(rawScenarios)) return { ok: false, reason: "scenarios" };
  const byFile = new Map<string, number>();
  for (const entry of rawScenarios) {
    const row = asRecord(entry);
    if (!row) return { ok: false, reason: "scenarios" };
    const file = readString(row, "file");
    const testsExecuted = readNumber(row, "testsExecuted");
    if (!file || testsExecuted === undefined) return { ok: false, reason: "scenarios" };
    if (row.passed !== true || testsExecuted <= 0) return { ok: false, reason: `scenario-not-passed:${file}` };
    byFile.set(file, testsExecuted);
  }
  for (const required of ACCEPTANCE_SCENARIOS) {
    // Сокращённый набор не является приёмкой: каждый обязательный файл обязан быть прогнан и пройти.
    if (!byFile.has(required.file)) return { ok: false, reason: `scenario-missing:${required.file}` };
  }

  const dispatch = asRecord(record.dispatch);
  const review = asRecord(record.review);
  const dispatchRunId = dispatch ? readString(dispatch, "runId") : undefined;
  const dispatchId = dispatch ? readString(dispatch, "dispatchId") : undefined;
  const reviewRunId = review ? readString(review, "runId") : undefined;
  const reviewDispatchId = review ? readString(review, "dispatchId") : undefined;
  if (!dispatchRunId || !dispatchId) return { ok: false, reason: "dispatch" };
  if (!reviewRunId || !reviewDispatchId) return { ok: false, reason: "review" };
  if (reviewDispatchId === dispatchId) return { ok: false, reason: "review-same-dispatch" };

  return {
    ok: true,
    evidence: {
      schemaVersion: 1,
      kind: "acceptance-evidence",
      passed: true,
      exitCode: 0,
      command,
      scenarios: rawScenarios.map(entry => {
        const row = asRecord(entry)!;
        return {
          name: readString(row, "name") ?? "",
          file: readString(row, "file")!,
          testsExecuted: readNumber(row, "testsExecuted")!,
          passed: true,
        };
      }),
      treeBefore,
      treeAfter,
      treeHash: stamped,
      policyDigest: digest,
      acceptedBaseSha: baseSha,
      dispatch: { runId: dispatchRunId, dispatchId },
      review: { runId: reviewRunId, dispatchId: reviewDispatchId, requestPath: readString(review, "requestPath") ?? "" },
      producedAt: readString(record, "producedAt") ?? "",
    },
  };
}

/**
 * Пин хоста из принятого коммита: `devDependencies["@oh-my-pi/pi-coding-agent"]`.
 *
 * Именно это значение решает, является ли версия реестра новым кандидатом (`decidePrecheck`). Из рабочего
 * дерева оно не читается: незакоммиченная правка `package.json` иначе позволяла бы объявить кандидата уже
 * поддержанным (или наоборот) без единого принятого изменения. Отсутствующий или не-semver пин — отказ, а не
 * пустая строка, которую можно сравнить с версией реестра.
 */
export function pinnedVersionAt(checkout: string, baseSha: string): string {
  const shown = Bun.spawnSync(["git", "show", `${baseSha}:package.json`], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
  if (shown.exitCode !== 0) throw new Error("pinned-version-unavailable");
  let manifest: unknown;
  try {
    manifest = JSON.parse(shown.stdout.toString()) as unknown;
  } catch {
    throw new Error("pinned-version-unavailable");
  }
  // Поле читается рантайм-проверкой вложенного пути: неверная форма даёт `undefined`, а не выдуманный объект.
  const version = readPath(manifest, "devDependencies", "@oh-my-pi/pi-coding-agent");
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("pinned-version-unavailable");
  return version;
}

function versionsFromManifest(text: string, failure: string): readonly string[] {
  const manifest = JSON.parse(text) as { versions?: { version?: string }[] };
  const versions = (manifest.versions ?? []).map(record => record.version).filter((value): value is string => typeof value === "string");
  if (versions.length === 0) throw new Error(failure);
  return versions;
}

/**
 * Манифест поддержанных хостов из принятого коммита: вход гейта — и проверок, и решения о кандидате —
 * берётся у доверенной базы. Рабочее дерево для этого не читается вовсе: незакоммиченная правка манифеста
 * не должна менять ни набор обязательных проверок, ни состав поддержанных версий.
 */
function supportedVersionsAt(checkout: string, baseSha: string): readonly string[] {
  const shown = Bun.spawnSync(["git", "show", `${baseSha}:baseline/supported-hosts.json`], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
  if (shown.exitCode !== 0) throw new Error("accepted-supported-versions-unavailable");
  return versionsFromManifest(shown.stdout.toString(), "accepted-supported-versions-unavailable");
}

/** Порты, которыми пользуется приёмка: те же границы, что у контроллера, подставляемые в тестах. */
export interface AcceptancePorts {
  readonly github: Pick<GithubPort, "checksFor" | "requiredChecksPassed" | "checkWorkflowRun">;
  readonly orca: Pick<OrcaPort, "observe" | "readReport" | "workerList">;
}

export interface AcceptanceContext {
  readonly checkout: string;
  readonly stateDirectory: string;
  readonly policy: ControllerPolicy;
  readonly digest: string;
  readonly baseSha: string;
  readonly ports: AcceptancePorts;
}

function requireSettledRun(checks: readonly CheckRun[], headSha: string, policy: ControllerPolicy, versions: readonly string[]): CheckRun {
  const required = [
    ...versions.flatMap(version => policy.requiredCheckPlatforms.map(pair =>
      policy.requiredCheckTemplate.replaceAll("{os}", pair.os).replaceAll("{version}", version))),
    ...policy.additionalRequiredChecks,
  ];
  for (const name of required) {
    const settled = checks.filter(run => run.name === name && run.headSha === headSha && run.event === "push"
      && run.status === "completed" && run.conclusion === "success" && run.id > 0);
    if (settled.length > 0) return settled[0]!;
  }
  throw new Error("acceptance-check-run-missing");
}

/** Голова дерева Orca-воркера; непригодное дерево — отсутствие доказательства, а не пустая строка. */
function worktreeHeadOrUndefined(worktree: string): string | undefined {
  try {
    return currentHead(worktree);
  } catch {
    return undefined;
  }
}

/**
 * Наблюдение вместо доверия к файлу: `accept` опрашивает GitHub и Orca и записывает то, что увидел.
 *
 * Из отчёта E2E берутся только ссылки (Run, dispatch, ревью-dispatch) и сам факт `passed`; его отпечаток
 * считается по байтам, а соответствие дереву/политике/базе — по фактическим значениям. Права инициировать
 * внешние действия приёмка не даёт: она ничего не публикует.
 */
export async function mintAcceptance(context: AcceptanceContext, evidencePath: string): Promise<AcceptanceReceipt> {
  const { checkout, policy, digest, baseSha, ports } = context;
  const bytes = await readFile(resolve(evidencePath)).catch(() => undefined);
  if (!bytes) throw new Error("acceptance-evidence-unreadable");
  const evidenceHash = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("acceptance-evidence-invalid:json");
  }
  const raw = asRecord(parsed);
  if (!raw) throw new Error("acceptance-evidence-invalid:not-object");

  const treeHash = await controllerTreeHash(checkout);
  const evidenceCheck = parseEvidence(raw, treeHash, digest, baseSha);
  if (!evidenceCheck.ok) throw new Error(`acceptance-evidence-invalid:${evidenceCheck.reason}`);
  const evidence = evidenceCheck.evidence;

  const versions = supportedVersionsAt(checkout, baseSha);
  const checks = await ports.github.checksFor(baseSha);
  const gate = ports.github.requiredChecksPassed(checks, baseSha, versions);
  if (!gate.ok) throw new Error(`acceptance-check-gate-failed:${gate.reason}`);
  const check = requireSettledRun(checks, baseSha, policy, versions);
  const workflow = await ports.github.checkWorkflowRun(baseSha);
  if (workflow.kind !== "found") throw new Error("acceptance-workflow-run-missing");

  const dispatchId = evidence.dispatch.dispatchId;
  const rows = await ports.orca.workerList(evidence.dispatch.runId);
  if (!rows.some(row => row.dispatchId === dispatchId)) throw new Error("acceptance-dispatch-not-owned");
  const executor = await ports.orca.observe(dispatchId);
  if (executor.outcome !== "succeeded") throw new Error("acceptance-dispatch-not-settled");
  const executorWorktree = executor.worktreeId?.split("::")[1];
  if (!executorWorktree) throw new Error("acceptance-dispatch-worktree-missing");
  if (worktreeHeadOrUndefined(executorWorktree) !== baseSha) throw new Error("acceptance-dispatch-head-mismatch");

  const reviewDispatchId = evidence.review.dispatchId;
  // Ревьюер обязан быть членом своего Run и работать в СВОЁМ дереве: одного лишь чужого dispatch-а мало.
  const reviewRows = await ports.orca.workerList(evidence.review.runId);
  if (!reviewRows.some(row => row.dispatchId === reviewDispatchId)) throw new Error("acceptance-review-not-owned");
  const reviewer = await ports.orca.observe(reviewDispatchId);
  if (reviewer.outcome !== "succeeded") throw new Error("acceptance-review-not-settled");
  const reviewerWorktree = reviewer.worktreeId?.split("::")[1];
  if (!reviewerWorktree) throw new Error("acceptance-review-worktree-missing");
  if (reviewerWorktree === executorWorktree) throw new Error("acceptance-review-worktree-not-independent");
  try {
    assertOrigin(reviewerWorktree, policy.repository);
  } catch {
    throw new Error("acceptance-review-worktree-foreign");
  }
  if (worktreeHeadOrUndefined(reviewerWorktree) !== baseSha) throw new Error("acceptance-review-head-mismatch");
  // Ревьюер — только чтение: грязное дерево означает, что проверялось не то состояние.
  try {
    assertCleanWorktree(reviewerWorktree);
  } catch {
    throw new Error("acceptance-review-worktree-dirty");
  }
  const request = await loadReportRequest(evidence.review.requestPath, context.stateDirectory);
  const reviewRow = reviewRows.find(row => row.dispatchId === reviewDispatchId)!;
  const binding = await loadReportBinding(evidence.review.requestPath, context.stateDirectory);
  if (binding.runId !== evidence.review.runId || binding.dispatchId !== reviewDispatchId || binding.taskId !== reviewRow.taskId) throw new Error("worker-report-binding-mismatch");
  const proof = await ports.orca.readReport(request, binding);
  const verdict = proof.verdict;
  if (verdict.verdict !== "approved" || verdict.headSha !== baseSha || verdict.baseSha !== baseSha) {
    throw new Error("acceptance-review-not-approved");
  }
  // Ревьюер обязан предъявить отпечаток фактического проверяемого артефакта — дерева контроллера, а не
  // произвольный непустой список: иначе «независимое ревью» не привязано ни к чему.
  const attested = [...new Set(verdict.evidenceHashes)].sort();
  if (attested.length !== 1 || attested[0] !== treeHash) throw new Error("acceptance-review-attestation-mismatch");

  return {
    schemaVersion: 1,
    treeHash,
    policyDigest: digest,
    acceptedBaseSha: baseSha,
    evidencePath: resolve(evidencePath),
    evidenceHash,
    check: {
      checkRunId: String(check.id),
      name: check.name,
      workflowPath: check.workflowPath,
      event: check.event,
      headSha: check.headSha,
      status: check.status,
      conclusion: check.conclusion,
      workflowRunId: workflow.runId,
    },
    review: { dispatchId: reviewDispatchId, runId: evidence.review.runId, taskId: reviewRow.taskId, requestPath: evidence.review.requestPath, headSha: verdict.headSha, verdict: verdict.verdict, proof },
    dispatch: { dispatchId, runId: evidence.dispatch.runId, worktreeId: executor.worktreeId! },
    acceptedAt: new Date().toISOString(),
    evidenceCommand: evidence.command,
  };
}

/**
 * Повторная сверка непосредственно перед первым внешним действием.
 *
 * Приёмка — снимок наблюдений; между снимком и `run` база, политика, дерево контроллера, отчёт E2E и
 * проверки могли измениться. Любое расхождение или отзыв доказательства — отказ, а не «продолжим».
 */
export async function recheckAcceptance(receipt: AcceptanceReceipt, context: AcceptanceContext): Promise<void> {
  const { checkout, digest, baseSha, ports } = context;
  if (receipt.treeHash !== await controllerTreeHash(checkout)) throw new Error("local-acceptance-stale-tree");
  if (receipt.policyDigest !== digest) throw new Error("local-acceptance-stale-policy");
  if (receipt.acceptedBaseSha !== baseSha) throw new Error("local-acceptance-stale-base");

  const bytes = await readFile(receipt.evidencePath).catch(() => undefined);
  if (!bytes) throw new Error("local-acceptance-evidence-missing");
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.evidenceHash) throw new Error("local-acceptance-evidence-changed");

  const checks = await ports.github.checksFor(baseSha);
  const gate = ports.github.requiredChecksPassed(checks, baseSha, supportedVersionsAt(checkout, baseSha));
  if (!gate.ok) throw new Error(`local-acceptance-check-revoked:${gate.reason}`);
  const settled = checks.find(run => String(run.id) === receipt.check.checkRunId
    && run.headSha === baseSha && run.event === "push" && run.status === "completed" && run.conclusion === "success");
  if (!settled) throw new Error("local-acceptance-check-revoked:run-missing");

  const executor = await ports.orca.observe(receipt.dispatch.dispatchId);
  const executorWorktree = executor.worktreeId?.split("::")[1];
  if (executor.outcome !== "succeeded" || !executorWorktree || worktreeHeadOrUndefined(executorWorktree) !== baseSha) {
    throw new Error("local-acceptance-dispatch-revoked");
  }
  const reviewRows = await ports.orca.workerList(receipt.review.runId);
  if (!reviewRows.some(row => row.dispatchId === receipt.review.dispatchId)) throw new Error("local-acceptance-review-revoked");
  const reviewer = await ports.orca.observe(receipt.review.dispatchId);
  const reviewerWorktree = reviewer.worktreeId?.split("::")[1];
  if (reviewer.outcome !== "succeeded" || !reviewerWorktree || reviewerWorktree === executorWorktree) {
    throw new Error("local-acceptance-review-revoked");
  }
  const request = await loadReportRequest(receipt.review.requestPath, context.stateDirectory);
  const binding = await loadReportBinding(receipt.review.requestPath, context.stateDirectory);
  if (binding.runId !== receipt.review.runId || binding.taskId !== receipt.review.taskId || binding.dispatchId !== receipt.review.dispatchId) throw new Error("local-acceptance-review-revoked");
  const proof = await ports.orca.readReport(request, binding);
  if (proof.reportSha256 !== receipt.review.proof.reportSha256 || proof.deliveryId !== receipt.review.proof.deliveryId
    || proof.messageId !== receipt.review.proof.messageId) throw new Error("local-acceptance-review-revoked");
  const verdict = proof.verdict;
  // Отпечаток проверяемого артефакта сверяется повторно: ревью могло быть отозвано или относиться к другому дереву.
  const attested = verdict ? [...new Set(verdict.evidenceHashes)].sort() : [];
  if (!verdict || verdict.verdict !== "approved" || verdict.headSha !== baseSha || verdict.baseSha !== baseSha
    || attested.length !== 1 || attested[0] !== receipt.treeHash) {
    throw new Error("local-acceptance-review-revoked");
  }
  assertOrigin(reviewerWorktree, context.policy.repository);
  if (worktreeHeadOrUndefined(reviewerWorktree) !== baseSha) throw new Error("local-acceptance-review-revoked");
  assertCleanWorktree(reviewerWorktree);
}

async function contextFor(checkout: string, stateDirectory: string) {
  const { policy, digest, baseSha } = await loadAcceptedPolicy(checkout);
  const journal = await Journal.open(stateDirectory);
  const github = new GitHub(policy);
  const orca = new Orca(policy, checkout);
  return {
    policy,
    digest,
    baseSha,
    ports: { github, orca } satisfies AcceptancePorts,
    controller: new Controller({
      checkout,
      stateDirectory,
      policy,
      journal,
      github,
      orca,
      // Набор поддержанных версий — вход решения о кандидате, поэтому он берётся у принятой базы, а не из
      // рабочего дерева: незакоммиченная правка манифеста не должна расширять или сужать поддержку.
      supportedVersions: supportedVersionsAt(checkout, baseSha),
      // Пин хоста — тоже вход решения о кандидате: он берётся из принятого коммита, чтобы незакоммиченная
      // правка `package.json` не могла объявить новую версию реестра уже поддержанной.
      pinnedVersion: pinnedVersionAt(checkout, baseSha),
    }),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  if (!subcommand) usage();
  const checkout = resolve(option(args, "--checkout") ?? process.cwd());
  const stateDirectory = resolve(option(args, "--state-dir") ?? join(homedir(), ".omp", "maintenance", "controller"));

  if (subcommand === "--policy-digest") {
    const { policy, digest, baseSha } = await loadAcceptedPolicy(checkout);
    console.log(JSON.stringify({ repository: policy.repository, controllerLogin: policy.controllerLogin, baseSha, digest }));
    return;
  }
  if (subcommand === "--preflight") {
    const { digest, baseSha } = await loadAcceptedPolicy(checkout);
    console.log(JSON.stringify({ treeHash: await controllerTreeHash(checkout), policyDigest: digest, acceptedBaseSha: baseSha }));
    return;
  }

  if (subcommand === "review-request") {
    const { baseSha } = await loadAcceptedPolicy(checkout);
    const request = await createReportRequest(stateDirectory, checkout, baseSha, baseSha);
    console.log(JSON.stringify({ requestPath: join(stateDirectory, "reports", `${request.nonce}.request.json`), request }));
    return;
  }
  if (subcommand === "review-bind") {
    const requestPath = option(args, "--review-request"); const runId = option(args, "--review-run"); const dispatchId = option(args, "--review-dispatch");
    if (!requestPath || !runId || !dispatchId) throw new Error("worker-report-binding-missing");
    const { policy } = await loadAcceptedPolicy(checkout);
    const orca = new Orca(policy, checkout);
    const rows = await orca.workerList(runId);
    const row = rows.find(worker => worker.dispatchId === dispatchId);
    const observed = await orca.observe(dispatchId);
    if (!row || observed.runId !== runId || observed.taskId !== row.taskId || observed.resource?.ownerDispatchId !== dispatchId) throw new Error("worker-report-binding-unproven");
    const binding = { runId, dispatchId, taskId: row.taskId };
    await bindReportRequest(resolve(requestPath), stateDirectory, binding);
    console.log(JSON.stringify({ binding }));
    return;
  }
  const { policy, digest, baseSha, ports, controller } = await contextFor(checkout, stateDirectory);
  const context: AcceptanceContext = { checkout, stateDirectory, policy, digest, baseSha, ports };

  if (subcommand === "accept") {
    const evidencePath = option(args, "--evidence");
    if (!evidencePath) usage();
    const receipt = await mintAcceptance(context, evidencePath);
    const errors = acceptanceErrors(receipt);
    if (errors.length > 0) throw new Error(`acceptance-invalid:${errors.join(",")}`);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "acceptance.json"), JSON.stringify(receipt, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, receipt }));
    return;
  }

  if (subcommand === "--precheck") {
    let decision: PrecheckDecision;
    try {
      decision = await controller.precheck();
    } catch (error) {
      decision = { kind: "blocked", reason: error instanceof Error ? error.message : "precheck-unavailable" };
    }
    console.log(JSON.stringify(decision));
    process.exitCode = exitCode(decision);
    return;
  }
  if (subcommand === "status") {
    const pending = await controller.pending();
    console.log(JSON.stringify(pending
      ? { kind: pending.stage === "done" ? "done" : "pending", stage: pending.stage, key: pending.key, refusal: pending.refusal }
      : { kind: "idle" }));
    return;
  }
  if (subcommand === "run") {
    let acceptance: AcceptanceReceipt;
    try {
      acceptance = JSON.parse(await readFile(join(stateDirectory, "acceptance.json"), "utf8")) as AcceptanceReceipt;
    } catch {
      throw new Error("local-acceptance-missing");
    }
    const errors = acceptanceErrors(acceptance);
    if (errors.length > 0) throw new Error(`local-acceptance-invalid:${errors.join(",")}`);
    // Сверка делается до первого эффекта: `controller.run()` ниже уже может отправить коммит.
    await recheckAcceptance(acceptance, context);
    const outcome = await controller.run();
    console.log(JSON.stringify(outcome));
    if (outcome.stage === "blocked") process.exitCode = 11;
    return;
  }
  usage();
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Единый машинный отказ: точная причина сохраняется, стек не печатается, исключение не глотается.
    const reason = error instanceof Error ? error.message : "controller-failed";
    console.log(JSON.stringify({ kind: "blocked", reason }));
    process.exitCode = 11;
  }
}

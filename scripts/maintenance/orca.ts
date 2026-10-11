import type { ControllerPolicy, WorkerObservation, WorkerStartReceipt } from "./contracts";
import { asRecord, readPath, readString } from "./json";
import { parseStrictReportJSON, verifyReportFile, type ReportBinding, type ReportProof, type ReportRequest } from "./report";

/**
 * Порт Orca.
 *
 * Все значения передаются argv — интерполяции в shell нет. Идентификаторы берутся только из receipts.
 * `new-top-level` требует `--name`; отказ `invalid_argument` не повторяется дословной командой.
 * Исчерпание глубины вложенности возвращается как `depth-blocked` с точным действием — обхода нет.
 */

export interface WorkerRow {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly state: string;
  readonly worktreeId?: string;
}

export interface WorkerStatus extends WorkerObservation {
  readonly runId?: string;
  readonly taskId?: string;
  readonly resource?: { readonly ownerDispatchId: string; readonly state: string; readonly releaseState: string };
}

export interface WorkerDelivery {
  readonly runId: string;
  readonly deliveryId: string;
  readonly messages: readonly Record<string, unknown>[];
}

/**
 * Вход спецификации задачи. Значения приходят из состояния контроллера: версия хоста и версия плагина —
 * разные числа, и промпт обязан назвать их раздельно, иначе исполнитель запишет хостовую версию в
 * `package.json` и коммит не совпадёт с ожидаемой версией выпуска.
 */
export interface TaskSpecRequest {
  readonly role: "executor" | "reviewer";
  /** Версия хоста OMP (кандидат upstream), например `18.8.9`. */
  readonly upstreamVersion: string;
  /** Версия плагина для тега `v<releaseVersion>`, например `0.6.0`. */
  readonly releaseVersion: string;
  /** Принятая база генерации. */
  readonly baseSha: string;
  /** Голова запроса: пустая у исполнителя (коммит ещё не создан) и точный SHA у ревьюера. */
  readonly headSha: string;
  readonly reportRequest?: ReportRequest;
}

/** Граница Orca, которой пользуется контроллер: подставляется локальным портом в тестах. */
export interface OrcaPort {
  createRun(objective: string): Promise<string>;
  findRunByObjective(objective: string): Promise<{ kind: "found"; runId: string } | { kind: "absent" } | { kind: "unknown" }>;
  taskSpec(request: TaskSpecRequest): string;
  start(spec: string, role: "executor" | "reviewer", runId: string, name: string, baseRef: string): Promise<WorkerStartReceipt>;
  observe(dispatchId: string): Promise<WorkerStatus>;
  readReport(request: ReportRequest, binding: ReportBinding, delivery?: WorkerDelivery): Promise<ReportProof>;
  delivery(runId: string): Promise<WorkerDelivery | undefined>;
  acknowledge(runId: string, deliveryId: string): Promise<WorkerDelivery | undefined>;
  release(dispatchId: string): Promise<void>;
  workerList(runId: string): Promise<readonly WorkerRow[]>;
}

function executableFromEnvironment(): string {
  const configured = process.env.ORCA_CLI_COMMAND;
  if (configured) return configured;
  if (process.platform === "win32") {
    return `${process.env.LOCALAPPDATA}\\Programs\\orca\\resources\\bin\\orca.exe`;
  }
  return "orca";
}

export class Orca implements OrcaPort {
  private readonly executable: string;

  /**
   * `repository` — дерево, из которого создаётся воркер: контроллер передаёт свой проверенный чекаут, а не
   * текущий каталог процесса. Иначе при запуске CLI из другого каталога/клона воркер получил бы чужой
   * репозиторий.
   */
  constructor(
    private readonly policy: ControllerPolicy,
    private readonly repository: string = process.cwd(),
    executable = executableFromEnvironment(),
  ) {
    this.executable = executable;
  }

  protected async invoke(args: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
    const child = Bun.spawn([this.executable, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0 && !stdout.trim()) throw Object.assign(new Error("orca-unavailable"), { cause: stderr });
      const envelope = asRecord(JSON.parse(stdout) as unknown);
      if (!envelope) throw new Error("orca-receipt-unreadable");
      if (envelope.ok === false) {
        const failure = new Error(readPath(envelope, "error", "code") ?? "orca-outcome-unknown");
        Object.assign(failure, { detail: readPath(envelope, "error", "message") ?? "" });
        throw failure;
      }
      return asRecord(envelope.result) ?? envelope;
    } finally {
      clearTimeout(timer);
    }
  }

  async createRun(objective: string): Promise<string> {
    const result = await this.invoke(["orchestration", "run-create", "--objective", objective, "--json"], this.policy.deadlinesMs.command);
    const runId = readPath(result, "run", "id") ?? readString(result, "runId");
    if (!runId) throw new Error("run-receipt-unverified");
    return runId;
  }

  /**
   * Поиск Run по неизменяемой цели.
   *
   * Цель содержит репозиторий, кандидата, роль и базу — она и есть durable-метаданные генерации. Ровно один
   * совпавший Run доказывает, что эффект уже применён; ноль — что он не применён; больше одного или
   * нечитаемый ответ — «доказать нельзя», и стадия блокируется, а не повторяется.
   */
  async findRunByObjective(objective: string): Promise<{ kind: "found"; runId: string } | { kind: "absent" } | { kind: "unknown" }> {
    let result: Record<string, unknown>;
    try {
      result = await this.invoke(["orchestration", "run-list", "--json"], this.policy.deadlinesMs.command);
    } catch {
      return { kind: "unknown" };
    }
    const rows = result.runs;
    if (!Array.isArray(rows)) return { kind: "unknown" };
    const matches = rows.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined)
      .filter(row => readString(row, "objective") === objective);
    if (matches.length === 0) return { kind: "absent" };
    if (matches.length > 1) return { kind: "unknown" };
    const runId = readString(matches[0]!, "id");
    return runId ? { kind: "found", runId } : { kind: "unknown" };
  }

  /**
   * Доверенный текст задачи. Тело запроса на слияние и любые внешние тексты инструкциями не являются.
   *
   * Версия хоста и версия плагина называются раздельно: единственный номер в старом промпте был хостовым, и
   * исполнитель записал бы его в `package.json`. Разрешённые пути берутся из принятой политики, а не из
   * текста запроса.
   */
  taskSpec(request: TaskSpecRequest): string {
    const { role, upstreamVersion, releaseVersion, baseSha, headSha } = request;
    const common = [
      `Target: репозиторий ${this.policy.repository}.`,
      `Версия хоста OMP (кандидат upstream): ${upstreamVersion}.`,
      `Версия плагина для тега v${releaseVersion}: ${releaseVersion}.`,
      `Constraints: не сливать, не ставить тег, не публиковать выпуск, не менять личный профиль пользователя,`,
      `не трогать автоматизацию и правила репозитория, не обходить разрешения.`,
      `Ownership: только разрешённые пути ${this.policy.executorPaths.join(", ")}.`,
      `Constraints: измерительный код (\`scripts/**\` и \`src/**\`, кроме файлов каталога \`src/translations/ru-part-*.ts\` ` +
        `и \`ru-variants.ts\`) править нельзя: изменение измерителя — отказ гейта, а не улучшение.`,
      `Observable acceptance: заверши задачу сообщением worker_done с явными taskId и dispatchId.`,
    ].join(" ");
    if (role === "executor") {
      const incoming = this.policy.incomingPaths
        .map(pattern => `\`${pattern.replaceAll("<candidate>", upstreamVersion)}\``)
        .join(", ");
      return `${common} Change: обнови перевод до хостовой версии ${upstreamVersion}, сохранив все ранее поддержанные версии и ` +
        `подстановочные маркеры. Элементы выпуска принадлежат плагину, а не хосту: установи в \`package.json\` ` +
        `\`version\` = ${releaseVersion} (версия плагина), добавь в \`CHANGELOG.md\` заголовок \`## [${releaseVersion}]\` ` +
        `по формату существующих записей, а хостовые пины обнови на ${upstreamVersion}. Подготовь конечный набор ` +
        `артефактов: ${incoming}. Предъяви полное покрытие и нулевой дрейф по каждой версии и платформе.`;
    }
    // Форма строки ревью берётся у гейта (`ReviewRow` в scripts/maintenance/semantic.ts), а не выдумывается здесь:
    // `path` — идентификатор НАСТРОЙКИ, а не путь файла. Набор отпечатков — ровно `evidenceSet(…, headSha, approved)`.
    const report = request.reportRequest;
    if (!report) throw new Error("worker-report-request-missing");
    return `${common} Change: независимо проверь только чтением точный коммит ${headSha} (база ${baseSha}); ` +
      `рабочее дерево должно остаться чистым. Единственная разрешённая запись — файл вне рабочего дерева: ${report.reportPath}. ` +
      `Запиши туда ровно один строгий JSON без markdown: ` +
      JSON.stringify({ schemaVersion: 1, nonce: report.nonce, role: "reviewer", verdict: "approved", headSha, baseSha,
        evidenceHashes: ["<64 hex>"], reviewRows: [{ path: "<идентификатор настройки>", sourceHash: "<64 hex>", translationHash: "<64 hex>", reviewedAtVersion: upstreamVersion, platforms: ["<платформа>"] }] }) +
      ` reviewRows — точные ReviewRow (scripts/maintenance/semantic.ts), по каждому изменённому варианту; evidenceHashes — ` +
      `ровно evidenceSet (scripts/maintenance/tree.ts) этого коммита. Вычисли SHA256 фактических байтов файла, НЕ добавляй хеш файла в сам вердикт. ` +
      `Заверши через orca orchestration send --subject review-complete --type worker_done --body '<три предложения о результате>' ` +
      `--payload '<JSON с actual taskId, actual dispatchId, outcome=succeeded, nonce,reportPath,reportSha256,headSha,baseSha,role>'. ` +
      `Не добавляй --task-id, --dispatch-id, --outcome или --report-path вместе с --payload: это взаимоисключающие формы. ` +
      `JSON должен содержать фактический 64-hex reportSha256 и значения запроса ${JSON.stringify(report)}. ` +
      `Не полагайся на финальный текст или транскрипт.`;
  }

  async start(
    spec: string, role: "executor" | "reviewer", runId: string, name: string, baseRef: string,
  ): Promise<WorkerStartReceipt> {
    try {
      const result = await this.invoke([
        "orchestration", "worker-start",
        "--spec", spec,
        "--worktree", "new-top-level",
        "--name", name,
        "--repo", `path:${this.repository}`,
        "--agent", role === "reviewer" ? this.policy.reviewerAgent : this.policy.executorAgent,
        "--run", runId,
        "--base-branch", baseRef,
        "--timeout-ms", String(this.policy.deadlinesMs.agent),
        "--json",
      ], this.policy.deadlinesMs.agent);
      const dispatchId = result.dispatchId;
      const taskId = result.taskId;
      const worktreeId = (result.effects as { kind: string; id?: string }[] | undefined)
        ?.find(effect => effect.kind === "worktree")?.id;
      if (typeof dispatchId !== "string" || typeof taskId !== "string" || !dispatchId || !taskId) {
        throw new Error("worker-start-receipt-unverified");
      }
      return { kind: "started", runId, taskId, dispatchId, worktreeId: worktreeId ?? "" };
    } catch (error) {
      if (error instanceof Error && /depth/i.test(error.message)) {
        return {
          kind: "depth-blocked",
          reason: error.message,
          unblockAction: "Запустить контроллер из законного верхнеуровневого автоматизированного координатора (расписание automation), не создавая обходной терминал.",
        };
      }
      throw error;
    }
  }

  async observe(dispatchId: string): Promise<WorkerStatus> {
    const result = await this.invoke(["orchestration", "worker-show", "--dispatch", dispatchId, "--json"], this.policy.deadlinesMs.command);
    const dispatch = asRecord(result.dispatch);
    const worker = asRecord(result.worker);
    const resource = asRecord(asRecord(result.projection)?.resource);
    if (dispatch?.id !== dispatchId) throw new Error("dispatch-receipt-mismatch");
    return {
      dispatchId,
      runId: readString(dispatch, "runId"), taskId: readString(dispatch, "taskId"),
      outcome: worker?.state === "succeeded" ? "succeeded" : worker?.state === "failed" ? "failed" : undefined,
      completedAt: readString(dispatch, "completedAt"),
      worktreeId: readString(worker, "worktreeId"),
      resource: resource && typeof resource.ownerDispatchId === "string" && typeof resource.state === "string" && typeof resource.releaseState === "string"
        ? { ownerDispatchId: resource.ownerDispatchId, state: resource.state, releaseState: resource.releaseState } : undefined,
    };
  }

  async readReport(request: ReportRequest, binding: ReportBinding, delivery?: WorkerDelivery): Promise<ReportProof> {
    const worker = await this.observe(binding.dispatchId);
    if (worker.dispatchId !== binding.dispatchId || worker.runId !== binding.runId || worker.taskId !== binding.taskId
      || worker.outcome !== "succeeded" || !worker.completedAt || worker.resource?.ownerDispatchId !== binding.dispatchId) {
      throw new Error("worker-settlement-unproven");
    }
    const batch = delivery ?? await this.delivery(binding.runId);
    if (!batch || batch.runId !== binding.runId) throw new Error("worker-report-delivery-missing");
    const completions: { message: Record<string, unknown>; payload: Record<string, unknown> }[] = [];
    for (const message of batch.messages) {
      if (message.type !== "worker_done") continue;
      let payload: Record<string, unknown> | undefined;
      try { payload = asRecord(typeof message.payload === "string" ? parseStrictReportJSON(message.payload) : undefined); } catch { /* reject below */ }
      if (message.run_id !== binding.runId || !readString(message, "id") || !payload) throw new Error("worker-report-metadata-unverifiable");
      if (payload.dispatchId !== binding.dispatchId || payload.taskId !== binding.taskId) throw new Error("worker-delivery-not-owned");
      completions.push({ message, payload });
    }
    if (completions.length !== 1) throw new Error("worker-report-delivery-unverifiable");
    const { message, payload } = completions[0]!;
    const reportSha256 = readString(payload, "reportSha256");
    if (payload.outcome !== "succeeded" || payload.nonce !== request.nonce || payload.reportPath !== request.reportPath
      || payload.role !== request.role || payload.headSha !== request.headSha || payload.baseSha !== request.baseSha
      || !reportSha256 || !/^[a-f0-9]{64}$/.test(reportSha256)) throw new Error("worker-report-metadata-unverifiable");
    const report = await verifyReportFile(request, reportSha256);
    return { request, binding, deliveryId: batch.deliveryId, messageId: String(message.id), reportSha256, ...report };
  }

  private decodeDelivery(result: Record<string, unknown>, runId: string): WorkerDelivery | undefined {
    if (result.runId !== runId || !Array.isArray(result.messages)) throw new Error("worker-delivery-unverifiable");
    if (result.messages.length === 0) return undefined;
    const deliveryId = readString(result, "deliveryId");
    const messages = result.messages.map(asRecord);
    if (!deliveryId || messages.some(message => !message || message.run_id !== runId || !readString(message, "id"))) throw new Error("worker-delivery-unverifiable");
    return { runId, deliveryId, messages: messages as Record<string, unknown>[] };
  }

  async delivery(runId: string): Promise<WorkerDelivery | undefined> {
    return this.decodeDelivery(await this.invoke(["orchestration", "check", "--run", runId, "--json"], this.policy.deadlinesMs.command), runId);
  }

  async acknowledge(runId: string, deliveryId: string): Promise<WorkerDelivery | undefined> {
    const result = await this.invoke(["orchestration", "check", "--run", runId, "--ack", deliveryId, "--json"], this.policy.deadlinesMs.command);
    if (result.acknowledged !== deliveryId) throw new Error("worker-ack-unverifiable");
    return this.decodeDelivery(result, runId);
  }

  async release(dispatchId: string): Promise<void> {
    const worker = await this.observe(dispatchId);
    if (!worker.outcome || !worker.completedAt || worker.resource?.ownerDispatchId !== dispatchId) throw new Error("worker-release-unproven");
    const result = await this.invoke(["orchestration", "worker-release", "--dispatch", dispatchId, "--json"], this.policy.deadlinesMs.command);
    if (result.state !== "released") throw new Error("worker-release-unverified");
    const released = await this.observe(dispatchId);
    if (released.resource?.ownerDispatchId !== dispatchId || released.resource.state !== "released" || released.resource.releaseState !== "released") throw new Error("worker-release-unverified");
  }

  async workerList(runId: string): Promise<readonly WorkerRow[]> {
    const result = await this.invoke(["orchestration", "worker-list", "--run", runId, "--json"], this.policy.deadlinesMs.command);
    const rows = (result.workers ?? []) as Record<string, any>[];
    return rows.map(row => ({
      dispatchId: row.dispatchId,
      taskId: row.taskId,
      runId: row.runId,
      state: row.workerState ?? "",
      worktreeId: row.resource?.worktreeId,
    }));
  }
}

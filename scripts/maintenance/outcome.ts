import { appendFile, writeFile } from "node:fs/promises";

export type OutcomeStage = "discover" | "prepare" | "translate" | "verify" | "publish";
export type OutcomeResult = "no-work" | "released" | "retired" | "blocked";
export interface MaintenanceOutcome {
  readonly schemaVersion: 1;
  readonly baseSha: string;
  readonly candidateVersion: string;
  readonly stage: OutcomeStage;
  readonly outcome: OutcomeResult;
  readonly reason: string;
  readonly retryable: boolean;
  /** A manual dispatch starts a new preparation budget, never a new CI budget. */
  readonly retryBlocked?: true;
}
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STAGES = ["discover", "prepare", "translate", "verify", "publish"] as const;
const RESULTS = ["no-work", "released", "retired", "blocked"] as const;
const TRANSPORT = /^(?:(?:registry|github|model)-http-(?:429|5\d\d)|registry-timeout|model-timeout)$/;

export function sanitizeOutcomeReason(reason: string): string {
  return /^[A-Za-z0-9:._/-]{1,300}$/.test(reason) ? reason : "maintenance-action-blocked";
}
export function classifyOutcomeReason(reason: string, stage: OutcomeStage): boolean {
  return TRANSPORT.test(reason) || (stage === "discover" && ["companion-package-unavailable", "native-asset-unavailable"].includes(reason));
}
export function outcomeArtifactName(runId: string, attempt: string): string {
  if (!/^[1-9]\d{0,19}$/.test(runId) || !/^[1-9]\d{0,5}$/.test(attempt)) throw new Error("maintenance-outcome-identity-invalid");
  return `maintenance-outcome-${runId}-${attempt}`;
}
export function parseOutcome(value: unknown): MaintenanceOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("maintenance-outcome-invalid");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["schemaVersion", "baseSha", "candidateVersion", "stage", "outcome", "reason", "retryable", "retryBlocked"].includes(key)) || raw.schemaVersion !== 1 || typeof raw.baseSha !== "string" || !SHA.test(raw.baseSha) || typeof raw.candidateVersion !== "string" || !VERSION.test(raw.candidateVersion) || !STAGES.includes(raw.stage as OutcomeStage) || !RESULTS.includes(raw.outcome as OutcomeResult) || typeof raw.reason !== "string" || sanitizeOutcomeReason(raw.reason) !== raw.reason || typeof raw.retryable !== "boolean" || (raw.retryBlocked !== undefined && raw.retryBlocked !== true) || (raw.retryable && (raw.outcome !== "blocked" || !classifyOutcomeReason(raw.reason, raw.stage as OutcomeStage)))) throw new Error("maintenance-outcome-invalid");
  return raw as unknown as MaintenanceOutcome;
}
export function canStartPreparation(history: readonly MaintenanceOutcome[], baseSha: string, candidateVersion: string, retryBlocked: boolean): boolean {
  if (retryBlocked) return true;
  const matching = history.filter(item => item.baseSha === baseSha && item.candidateVersion === candidateVersion);
  let reset = -1;
  for (let index = matching.length - 1; index >= 0; index--) {
    if (matching[index]!.retryBlocked === true) { reset = index; break; }
  }
  const failed = matching.slice(Math.max(0, reset)).filter(item => item.outcome === "blocked");
  return !failed.some(item => !item.retryable) && failed.length < 2;
}
export interface JobOutcome { readonly result: string; readonly reason?: string; readonly retryable?: string; readonly outcome?: string }
export interface OutcomeJobs {
  readonly baseSha: string; readonly candidateVersion: string; readonly mode: string; readonly retryBlocked?: boolean;
  readonly discover: JobOutcome; readonly prepare?: JobOutcome; readonly translate?: JobOutcome; readonly verify?: JobOutcome; readonly publish?: JobOutcome;
}
/** Trusted, secret-free aggregation of typed CLI outputs and runner conclusions. */
export function outcomeFromJobs(input: OutcomeJobs): MaintenanceOutcome | null {
  if (!VERSION.test(input.candidateVersion)) return null;
  const finish = (stage: OutcomeStage, outcome: OutcomeResult, reason: string, retryable = false) => parseOutcome({ schemaVersion: 1, baseSha: input.baseSha, candidateVersion: input.candidateVersion, stage, outcome, reason: sanitizeOutcomeReason(reason), retryable, ...(input.retryBlocked ? { retryBlocked: true } : {}) });
  for (const stage of STAGES) {
    const job = input[stage];
    if (job && !["success", "skipped"].includes(job.result)) {
      const reason = sanitizeOutcomeReason(job.reason ?? `${stage}-${job.result || "unavailable"}`);
      return finish(stage, "blocked", reason, job.retryable === "true" && classifyOutcomeReason(reason, stage));
    }
  }
  if (input.mode === "blocked") return finish("discover", "blocked", input.discover.reason ?? "discovery-blocked");
  if (input.mode === "no-work") return finish("discover", "no-work", "no-work");
  if (input.publish?.result === "success" && ["released", "retired"].includes(input.publish.outcome ?? "")) return finish("publish", input.publish.outcome as OutcomeResult, input.publish.outcome!);
  return finish("publish", "blocked", "maintenance-cycle-incomplete");
}
export async function writeOutcome(path: string, outcome: MaintenanceOutcome): Promise<void> {
  await writeFile(path, JSON.stringify(parseOutcome(outcome)) + "\n", { encoding: "utf8" });
}

if (import.meta.main) {
  const needs = JSON.parse(process.env.OUTCOME_NEEDS ?? "{}") as Record<OutcomeStage, { result: string; outputs?: Record<string, string> }>;
  const input: OutcomeJobs = {
    baseSha: needs.discover?.outputs?.base ?? process.env.GITHUB_SHA ?? "",
    candidateVersion: needs.discover?.outputs?.version ?? "",
    mode: needs.discover?.outputs?.mode ?? "blocked",
    retryBlocked: process.env.RETRY_BLOCKED === "true" && process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    ...Object.fromEntries(STAGES.map(stage => [stage, { result: needs[stage]?.result ?? "skipped", ...needs[stage]?.outputs }])),
    discover: { result: needs.discover?.result ?? "failure", ...needs.discover?.outputs },
  };
  const outcome = outcomeFromJobs(input);
  if (outcome) await writeOutcome("maintenance-outcome.json", outcome);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `upload=${outcome !== null}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, outcome ? `\n${JSON.stringify(outcome)}\n` : "\nNo candidate selected; outcome artifact intentionally omitted.\n");
}

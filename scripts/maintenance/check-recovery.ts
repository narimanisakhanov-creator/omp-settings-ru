import type { ControllerPolicy } from "./contracts";
import type { HostedGitHub } from "./actions-github";
import { asRecord, readNumber, readString } from "./json";

/**
 * Восстановление обязательного прогона `check.yml` на точном коммите.
 *
 * Контракт: доказательством служит **завершённый успешный** прогон `push`-события на этом SHA и полный набор
 * обязательных job-ов последней попытки. Всё остальное — либо ожидание, либо отказ.
 *
 * Повтор разрешён только как повтор **неизменных байтов**: `rerun --failed` того же прогона, не более трёх
 * попыток (`run_attempt < 3`). Это не утверждение, что причина сбоя инфраструктурная, и не повод править
 * тесты или принимать старый успешный attempt вместо нового неуспешного. Исчерпанный бюджет — durable отказ:
 * счётчик живёт в `run_attempt` GitHub, поэтому рестарт процесса его не обнуляет.
 *
 * Отказы, которые нельзя обойти: `action_required`, отсутствующий workflow, neutral/skipped обязательный job,
 * чужой репозиторий/SHA/ветка. Они блокируют кандидата до вмешательства человека.
 */

/** Потолок повторов одного прогона: attempt 1 — исходный, 2 и 3 — допустимые повторы. */
export const MAX_RUN_ATTEMPTS = 3;

/** Повторный POST не отправляется, пока не истёк этот срок наблюдения за новым attempt. */
const RERUN_OBSERVATION_MS = 60_000;
const POLL_INTERVAL_MS = 15_000;

export interface BoundRun {
  readonly id: number;
  readonly attempt: number;
  readonly status: string;
  readonly conclusion: string;
  readonly headSha: string;
  readonly headBranch: string;
}

/** Прогоны `check.yml` этого репозитория на точном SHA и ветке; чужие значения отбрасываются. */
function boundRuns(
  rows: readonly Record<string, unknown>[], repository: string, sha: string, branch: string,
): readonly BoundRun[] {
  const runs: BoundRun[] = [];
  for (const row of rows) {
    if (readString(row, "path") !== ".github/workflows/check.yml") continue;
    if (readString(row, "event") !== "push") continue;
    if (asRecord(row.repository)?.full_name !== repository) continue;
    if (readString(row, "head_sha") !== sha) continue;
    if (readString(row, "head_branch") !== branch) continue;
    const id = readNumber(row, "id");
    const attempt = readNumber(row, "run_attempt");
    if (id === undefined || !Number.isSafeInteger(id) || id <= 0
      || attempt === undefined || !Number.isSafeInteger(attempt) || attempt <= 0) throw new Error(`check-run-binding-invalid:${id ?? 0}`);
    if (runs.some(run => run.id === id)) throw new Error(`check-run-ambiguous:${sha}`);
    runs.push({
      id, attempt,
      status: readString(row, "status") ?? "",
      conclusion: readString(row, "conclusion") ?? "",
      headSha: sha, headBranch: branch,
    });
  }
  return runs.sort((left, right) => right.id - left.id);
}

/** Значение для сводки: только печатаемые символы, ограниченная длина, без управляющих последовательностей. */
function sanitized(value: string): string {
  return value.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "?").slice(0, 120);
}

async function writeSummary(lines: readonly string[]): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const existing = await Bun.file(path).exists() ? await Bun.file(path).text() : "";
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await Bun.write(path, `${existing}${prefix}${lines.join("\n")}\n`, { createPath: true });
}

/**
 * Неуспешные job-ы и шаги попытки: имя, идентификатор и вывод шага. Содержимое логов не копируется, поэтому
 * в сводку не могут попасть токены или сырой stderr.
 */
async function failedJobSummary(github: HostedGitHub, run: BoundRun): Promise<readonly string[]> {
  const root = `repos/${github.policy.repository}`;
  const jobs = await github.list(`${root}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?filter=all`, "jobs");
  const lines = [`- run ${run.id} attempt ${run.attempt} (${sanitized(run.conclusion)})`];
  for (const job of jobs) {
    if (readString(job, "conclusion") === "success") continue;
    const name = sanitized(readString(job, "name") ?? "");
    const id = readNumber(job, "id") ?? 0;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const failedSteps = steps
      .map(asRecord)
      .filter((step): step is Record<string, unknown> => step !== undefined)
      .filter(step => {
        const conclusion = readString(step, "conclusion");
        return conclusion !== undefined && conclusion !== "success" && conclusion !== "skipped";
      })
      .map(step => `${sanitized(readString(step, "name") ?? "")}(${sanitized(readString(step, "conclusion") ?? "")})`);
    lines.push(`  - ${name} [${id}] ${sanitized(readString(job, "conclusion") ?? "")}${failedSteps.length > 0 ? `: ${failedSteps.join(", ")}` : ""}`);
  }
  return lines;
}

async function readRun(github: HostedGitHub, runId: number, attempt: number, sha: string, branch: string): Promise<BoundRun | undefined> {
  const root = `repos/${github.policy.repository}`;
  const raw = asRecord(await github.api(`${root}/actions/runs/${runId}/attempts/${attempt}`));
  if (!raw) return undefined;
  if (readNumber(raw, "id") !== runId || readNumber(raw, "run_attempt") !== attempt
    || readString(raw, "path") !== ".github/workflows/check.yml" || readString(raw, "event") !== "push"
    || asRecord(raw.repository)?.full_name !== github.policy.repository || readString(raw, "head_sha") !== sha
    || readString(raw, "head_branch") !== branch) throw new Error(`check-run-binding-invalid:${runId}`);
  return {
    id: runId,
    attempt,
    status: readString(raw, "status") ?? "",
    conclusion: readString(raw, "conclusion") ?? "",
    headSha: sha,
    headBranch: branch,
  };
}

/**
 * Дождаться успешного обязательного прогона на `sha`, при необходимости повторив **только упавшие** job-ы.
 *
 * Возвращает управление лишь тогда, когда обязательный набор подтверждён; любой иной исход — исключение с
 * точным кодом, который попадёт в сводку и outcome.
 */
export async function ensureCheckRun(
  github: HostedGitHub, sha: string, versions: readonly string[], branch: string,
): Promise<void> {
  const policy: ControllerPolicy = github.policy;
  const root = `repos/${policy.repository}`;
  let deadline = Date.now() + policy.deadlinesMs.checks;
  let lastRun: BoundRun | undefined;
  while (Date.now() < deadline) {
    const rows = await github.list(`${root}/actions/runs?head_sha=${sha}`, "workflow_runs");
    const runs = boundRuns(rows, policy.repository, sha, branch);
    const run = runs[0];
    if (!run) {
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (lastRun && (run.id < lastRun.id || (run.id === lastRun.id && run.attempt < lastRun.attempt))) {
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (lastRun?.id !== run.id || lastRun.attempt !== run.attempt) deadline = Date.now() + policy.deadlinesMs.checks;
    lastRun = run;
    if (run.status !== "completed") {
      // Активный прогон не отменяется: он и есть единственный источник доказательства для этого SHA.
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (run.conclusion === "success") {
      const verdict = github.checks.requiredChecksPassed(await github.checks.checksFor(sha), sha, versions, run);
      if (verdict.ok) return;
      if (verdict.reason.startsWith("check-pending:")) { await Bun.sleep(POLL_INTERVAL_MS); continue; }
      // Успешный workflow при неполном/чужом обязательном наборе — блокировка, а не ожидание.
      throw new Error(verdict.reason);
    }
    if (!["failure", "cancelled", "timed_out"].includes(run.conclusion)) {
      // action_required, startup_failure, stale, neutral: разрешений и состояния workflow недостаточно.
      throw new Error(`check-run-blocked:${run.conclusion}:${run.id}`);
    }
    if (run.attempt >= MAX_RUN_ATTEMPTS) throw new Error(`candidate-checks-retries-exhausted:${run.id}`);
    const summary = await failedJobSummary(github, run);
    await writeSummary(["## Failed required checks", "", ...summary]);
    try {
      await github.command(["run", "rerun", String(run.id), "--repo", policy.repository, "--failed"], true);
    } catch {
      // A rejected POST (including already-running) has the same observation contract.
      // Only an actual API attempt advances the budget; never resend this POST.
    }
    const observedAt = Date.now();
    let started = false;
    while (Date.now() - observedAt < RERUN_OBSERVATION_MS) {
      const observed = await readRun(github, run.id, run.attempt + 1, sha, branch).catch(error => {
        if (error instanceof Error && error.message.startsWith("check-run-binding-invalid:")) throw error;
        return undefined;
      });
      if (observed && observed.attempt > run.attempt) {
        lastRun = observed;
        deadline = Date.now() + policy.deadlinesMs.checks;
        started = true;
        break;
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    if (!started) throw new Error(`check-rerun-not-started:${run.id}`);
  }
  throw new Error(lastRun ? `candidate-checks-timeout:${lastRun.id}` : `check-run-missing:${sha}`);
}

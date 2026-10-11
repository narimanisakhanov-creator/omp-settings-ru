import type { ControllerPolicy } from "./contracts";

/**
 * Решение предварительной проверки — чистая функция над наблюдением.
 *
 * Внешних эффектов нет: ни сети, ни файлов, ни git. Возвращённое решение и есть весь контракт стадии
 * `locked`; код выхода вычисляется отдельно.
 */

export interface OpenPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly author: string;
}

export interface OwnedPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export type LockState = { readonly kind: "free" } | { readonly kind: "held" };

export type PrecheckDecision =
  | { readonly kind: "eligible"; readonly candidate: string; readonly branch: string; readonly resume: boolean }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "blocked"; readonly reason: string };

export interface PrecheckInput {
  readonly registryLatest: string;
  readonly pinned: string;
  readonly supported: readonly string[];
  readonly policy: ControllerPolicy;
  readonly openPrs: readonly OpenPullRequest[];
  readonly ownedPr?: OwnedPullRequest;
  readonly lock: LockState;
  readonly now: number;
  readonly deadline: number;
}

function semver(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = semver(left);
  const b = semver(right);
  if (!a || !b) throw new Error("invalid-version");
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

/** Запись журнала подтверждает принадлежность только при полном совпадении наблюдения. */
export function matchesOwnedPr(observed: OpenPullRequest, owned: OwnedPullRequest): boolean {
  return observed.number === owned.number
    && observed.branch === owned.branch
    && observed.baseSha === owned.baseSha
    && observed.headSha === owned.headSha;
}

export function decidePrecheck(input: PrecheckInput): PrecheckDecision {
  if (input.now >= input.deadline) return { kind: "blocked", reason: "deadline-expired" };
  if (input.lock.kind === "held") return { kind: "blocked", reason: "repo-locked-owner-liveness-unknown" };

  const latest = semver(input.registryLatest);
  if (!latest) return { kind: "blocked", reason: "registry-version-invalid" };
  const pinned = semver(input.pinned);
  if (!pinned) return { kind: "blocked", reason: "pinned-version-invalid" };
  if (compareVersions(input.registryLatest, input.pinned) <= 0) return { kind: "skip", reason: "no-work" };

  const candidate = input.registryLatest;
  if (input.supported.includes(candidate)) return { kind: "skip", reason: "already-supported" };

  const branch = `upgrade/omp-${candidate}`;
  const pattern = new RegExp(input.policy.branchPattern);
  if (pattern.exec(branch)?.[1] !== candidate) return { kind: "blocked", reason: "branch-pattern-mismatch" };

  const forCandidate = input.openPrs.filter(pr => pr.branch === branch);
  if (input.ownedPr) {
    const observed = forCandidate.find(pr => pr.number === input.ownedPr!.number);
    if (observed && matchesOwnedPr(observed, input.ownedPr)) {
      return { kind: "eligible", candidate, branch, resume: true };
    }
  }
  if (forCandidate.length > 0) return { kind: "skip", reason: "foreign-pr" };

  return { kind: "eligible", candidate, branch, resume: false };
}

export function exitCode(decision: PrecheckDecision): number {
  if (decision.kind === "eligible") return 0;
  if (decision.kind === "skip") return 10;
  if (decision.reason.includes("deadline") || decision.reason.includes("registry-version-invalid")) return 12;
  if (decision.reason.includes("locked")) return 13;
  return 11;
}

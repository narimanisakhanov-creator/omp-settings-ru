export type SourcePlatform = "win32" | "darwin" | "linux";
export interface ReleasePin {
  readonly tag: string;
  readonly commitSha: string;
  readonly assetId: number;
  readonly sha256: string;
  readonly packageVersion: string;
  readonly supportedPairs: readonly { readonly hostVersion: string; readonly platform: SourcePlatform }[];
}
export interface InstalledHost {
  readonly version: string;
  readonly platform: SourcePlatform;
  readonly executableHash: string;
}
export interface ManagerCapabilities {
  readonly installVerifiedPath: boolean;
  readonly replaceVerifiedPath: boolean;
  readonly pinnedUpgradeTarget: boolean;
  readonly isolatedProfile: boolean;
  readonly userScope: boolean;
}
export interface UpdateReceipt {
  readonly phase: "staged" | "verified" | "activated" | "rolled-back" | "safe-pending" | "deferred" | "blocked";
  readonly pin: ReleasePin;
  readonly previousPackageHash: string;
  readonly smokePassed: boolean;
  readonly refusal?: string;
}

// --- Контроллер сопровождения -------------------------------------------------

export type MaintenanceStage =
  | "locked" | "working" | "prepared" | "pushed" | "reviewing"
  | "verifying" | "merged" | "released" | "done" | "blocked";

export interface ControllerPolicy {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly baseBranch: "main";
  /** Подтверждённый локальный аккаунт, которым аутентифицирован контроллер (`gh api user`). */
  readonly controllerLogin: string;
  readonly controllerType: "User";
  readonly branchPattern: string;
  readonly executorAgent: string;
  readonly reviewerAgent: string;
  readonly incomingPaths: readonly string[];
  readonly executorPaths: readonly string[];
  readonly requiredCheckTemplate: string;
  readonly requiredCheckPlatforms: readonly { readonly os: string; readonly platform: SourcePlatform }[];
  readonly additionalRequiredChecks: readonly string[];
  readonly scanner: {
    readonly version: string; readonly platform: SourcePlatform; readonly asset: string;
    readonly url: string; readonly archiveSha256: string; readonly executableSha256: string;
  };
  readonly deadlinesMs: {
    readonly precheck: number; readonly command: number; readonly agent: number;
    readonly verification: number; readonly release: number; readonly checks: number;
  };
}

export interface EffectRecord {
  readonly key: string;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly receipt?: Readonly<Record<string, unknown>>;
}

export interface MaintenanceState {
  readonly schemaVersion: 1;
  /** Неизменяемая идентичность генерации: репозиторий + кандидат + база + nonce попытки.
   *  Стабильна через push исполнителя, смену головы и возобновление: голову запроса она не содержит. */
  readonly key: string;
  readonly generation: {
    readonly repository: string;
    readonly candidateVersion: string;
    readonly baseSha: string;
    readonly attemptNonce: string;
  };
  readonly revision: number;
  readonly stage: MaintenanceStage;
  readonly attempt: number;
  readonly deadline: number;
  /** Версия хоста (upstream), до которой обновляется поддержка. Не версия плагина и не тег. */
  readonly upstreamVersion: string;
  /** Версия плагина, которая уйдёт в тег `v<releaseVersion>`. Выводится из текущей версии плагина. */
  readonly releaseVersion: string;
  readonly pr: {
    readonly number: number; readonly branch: string; readonly baseSha: string;
    readonly headSha: string; readonly candidateVersion: string;
  };
  /** Вердикт независимого ревьюера, привязанный к проверяемым головам. Не «эффект»: это наблюдение. */
  readonly reviewVerdict?: {
    readonly headSha: string;
    readonly baseSha: string;
    readonly evidenceHashes: readonly string[];
  };
  /** Доказательство подтверждённого выпуска: тег, слитый коммит и прогон `check.yml`. */
  readonly releaseProof?: {
    readonly tag: string;
    readonly mergeSha: string;
    readonly checkRun: string;
  };
  readonly effects: readonly EffectRecord[];
  readonly refusal?: string;
}

/** Ключ генерации: репозиторий, кандидат, база и nonce попытки. Голова запроса в ключ не входит. */
export function generationKey(
  repository: string, candidateVersion: string, baseSha: string, attemptNonce: string,
): string {
  return `${repository}/candidate-${candidateVersion}/${baseSha}/attempt-${attemptNonce}`;
}

export interface LockRecord {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly nonce: string;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly acquiredAt: number;
}

export type EffectObservation =
  | { readonly kind: "found"; readonly receipt: Readonly<Record<string, unknown>> }
  | { readonly kind: "absent" }
  | { readonly kind: "conflict" }
  | { readonly kind: "unknown" };

export interface CheckRun {
  readonly id: number; readonly name: string; readonly headSha: string;
  readonly status: string; readonly conclusion: string;
  readonly workflowPath: string; readonly event: string;
}

export interface WorkerObservation {
  readonly dispatchId: string;
  readonly outcome?: "succeeded" | "failed";
  readonly completedAt?: string;
  readonly worktreeId?: string;
}

export interface WorkerStartReceipt {
  readonly kind: "started" | "depth-blocked";
  readonly runId?: string; readonly taskId?: string; readonly dispatchId?: string;
  readonly worktreeId?: string; readonly reason?: string; readonly unblockAction?: string;
}

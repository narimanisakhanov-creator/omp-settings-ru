export type SourcePlatform = "win32" | "darwin" | "linux";
export interface ScannerPin {
  readonly version:string;
  readonly platform:"win32";
  readonly asset:string;
  readonly url:string;
  readonly archiveSha256:string;
  readonly executableSha256:string;
}
export interface MaintenancePolicy {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly baseBranch: string;
  readonly botLogin: string;
  readonly botType: "Bot";
  readonly branchPattern: string;
  readonly executorAgent: string;
  readonly reviewerAgent: string;
  readonly incomingPaths: readonly string[];
  readonly executorPaths: readonly string[];
  readonly requiredCheckTemplate: string;
  readonly requiredCheckPlatforms: readonly { readonly os: string; readonly platform: SourcePlatform }[];
  readonly additionalRequiredChecks: readonly string[];
  readonly activation: { readonly accepted: boolean; readonly activate: boolean; readonly targetProfile?: string };
  readonly scanner?:ScannerPin;
  readonly deadlinesMs: Readonly<Record<"precheck" | "command" | "agent" | "verification" | "release" | "updater", number>>;
}
export interface EligiblePr {
  readonly repository: string;
  readonly number: number;
  readonly sourceHeadSha: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly candidateVersion: string;
  readonly changedPaths: readonly string[];
}
export type MaintenanceStage = "locked" | "working" | "pushed" | "reviewing" | "verifying" | "merged" | "released" | "staged" | "verified" | "activated" | "done" | "blocked" | "safe-pending" | "waiting-session" | "rolled-back";
export interface EffectRecord {
  readonly key: string;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly receipt?: Readonly<Record<string, unknown>>;
}
export interface MaintenanceState {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly revision: number;
  readonly stage: MaintenanceStage;
  readonly pr: EligiblePr;
  readonly attempt: number;
  readonly deadline: number;
  readonly sourceHeadSha: string;
  readonly workingHeadSha?: string;
  readonly reviewedHeadSha?: string;
  readonly mergeSha?: string;
  readonly worktreeId?: string;
  readonly runId?: string;
  readonly executorDispatchId?: string;
  readonly reviewerDispatchId?: string;
  readonly effects: readonly EffectRecord[];
  readonly refusal?: string;
}
export interface LockRecord {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly nonce: string;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly acquiredAt: number;
}
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

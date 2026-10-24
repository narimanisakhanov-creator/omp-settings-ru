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

export interface ControllerPolicy {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly baseBranch: "main";
  /** Fine-grained PAT account verified before every privileged GitHub mutation. */
  readonly controllerLogin: string;
  readonly controllerType: "User";
  readonly branchPattern: string;
  readonly executorPaths: readonly string[];
  readonly requiredCheckTemplate: string;
  readonly requiredCheckPlatforms: readonly { readonly os: string; readonly platform: SourcePlatform }[];
  readonly additionalRequiredChecks: readonly string[];
  readonly deadlinesMs: {
    readonly precheck: number; readonly command: number;
    readonly verification: number; readonly release: number; readonly checks: number;
  };
}

export interface CheckRun {
  readonly id: number; readonly name: string; readonly headSha: string;
  readonly status: string; readonly conclusion: string;
  readonly workflowPath: string; readonly event: string;
}

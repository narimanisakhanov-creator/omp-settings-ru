import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { asRecord, parseStrictJSON } from "./maintenance/json";
import { loadAcceptedPolicy, validatePolicy, compareVersions } from "./maintenance/policy";
import { git, stableVersion, validateBundle, writeBundleManifest, type Candidate } from "./maintenance/actions-bundle";
import { HostedGitHub } from "./maintenance/actions-github";
import { prepareCandidate } from "./maintenance/actions-candidate";
import { snapshotValue } from "./maintenance/snapshots";
import { verifyCandidate } from "./maintenance/actions-verify";
import { publishCandidate, finalizeCandidate } from "./maintenance/actions-publish";
import { parseCatalogJSON, CATALOG_PATH } from "./maintenance/catalog";
import type { ControllerPolicy } from "./maintenance/contracts";
import { translateCandidate } from "./maintenance/translate";
import { requestModelJSON, ModelRequestError } from "./maintenance/model";
import { selectFixedHostAsset } from "./ci/prepare-host";
import { SUPPORTED_HOSTS } from "./maintenance/paths";

export interface Discovery { readonly mode: "no-work" | "prepare" | "resume" | "blocked"; readonly candidateVersion?: string; readonly baseSha: string; readonly reason?: string }
export async function discover(checkout: string, baseSha: string, policy: ControllerPolicy, github: HostedGitHub, requested?: string): Promise<Discovery> {
  if (requested && !stableVersion.test(requested)) throw new Error("requested-stable-version-required");
  const pending: { version: string; baseDrift: boolean }[] = [];
  for (const { pr, identity } of await github.ownedPulls()) {
    const release = await github.checks.releaseState(`v${identity.releaseVersion}`);
    if (pr.merged_at && release && !release.draft) {
      const checks = await github.checks.checkWorkflowRun(String(pr.merge_commit_sha));
      if (checks.kind === "found") {
        const proof = await github.checks.verifyPublishedRelease(`v${identity.releaseVersion}`, checks.runId, String(pr.merge_commit_sha));
        if (proof.kind === "found") continue;
        if (proof.kind === "blocked") throw new Error(proof.reason);
      }
    }
    if (!pr.merged_at && pr.state !== "open") continue;
    const artifact = asRecord(await github.api(`repos/${policy.repository}/actions/artifacts/${identity.artifactId}`));
    const baseDrift = !pr.merged_at && (identity.baseSha !== baseSha || artifact?.expired === true);
    if (!pr.merged_at && !baseDrift) {
      await github.origin({ ...identity, semanticReview: "disabled", files: [] }, identity.artifactId);
      const checks = await github.checks.checksFor(identity.headSha);
      if (checks.some(check => check.status === "completed" && check.conclusion !== "success")) throw new Error("owned-candidate-ci-failed-explicit-rerun-required");
    }
    pending.push({ version: identity.upstreamVersion, baseDrift });
  }
  if (pending.length > 1) throw new Error("multiple-unfinished-maintenance-candidates");
  if (pending.length) return { mode: "resume", candidateVersion: pending[0]!.version, baseSha };
  const pkg = asRecord(parseStrictJSON(git(checkout, ["show", `${baseSha}:package.json`])));
  const pinned = asRecord(pkg?.devDependencies)?.["@oh-my-pi/pi-coding-agent"];
  if (typeof pinned !== "string" || !stableVersion.test(pinned)) throw new Error("accepted-pin-invalid");
  let candidateVersion = requested;
  if (!candidateVersion) {
    const response = await fetch("https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest", { signal: AbortSignal.timeout(policy.deadlinesMs.command), redirect: "error" });
    if (!response.ok) throw new Error("registry-latest-unavailable");
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error("registry-response-too-large");
    const metadata = asRecord(parseStrictJSON(text)); candidateVersion = typeof metadata?.version === "string" ? metadata.version : undefined;
  }
  if (!candidateVersion || !stableVersion.test(candidateVersion)) throw new Error("registry-stable-version-required");
  if (compareVersions(candidateVersion, pinned) <= 0) return { mode: "no-work", candidateVersion, baseSha };
  const support = asRecord(parseStrictJSON(git(checkout, ["show", `${baseSha}:${SUPPORTED_HOSTS}`])));
  if (Array.isArray(support?.versions) && support.versions.some(row => asRecord(row)?.version === candidateVersion)) return { mode: "no-work", candidateVersion, baseSha };
  for (const name of ["pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"]) {
    const companion = await fetch(`https://registry.npmjs.org/@oh-my-pi%2F${name}/${candidateVersion}`, { signal: AbortSignal.timeout(policy.deadlinesMs.command), redirect: "error" });
    if (!companion.ok) throw new Error("companion-package-unavailable");
    const packageMetadata = asRecord(parseStrictJSON(await companion.text()));
    if (packageMetadata?.version !== candidateVersion || typeof asRecord(packageMetadata.dist)?.integrity !== "string") throw new Error("companion-package-invalid");
  }
  const native = await github.api(`repos/can1357/oh-my-pi/releases/tags/v${candidateVersion}`);
  for (const platform of ["win32", "darwin", "linux"]) selectFixedHostAsset(native, candidateVersion, platform, "x64");
  return { mode: "prepare", candidateVersion, baseSha };
}
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`option-value-required:${name}`); return value;
}
async function output(discovery: Discovery): Promise<void> {
  console.log(JSON.stringify(discovery));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `mode=${discovery.mode}\nversion=${discovery.candidateVersion ?? ""}\nbase=${discovery.baseSha}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Hosted maintenance: ${discovery.mode}\n\n${discovery.reason ?? discovery.candidateVersion ?? ""}\n`);
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); const command = args[0];
  if (!["discover", "prepare", "translate", "verify", "publish-candidate", "finalize"].includes(command ?? "")) throw new Error("maintenance-command-invalid");
  const checkout = process.cwd();
  if (process.env.GITHUB_ACTIONS === "true" && (process.env.GITHUB_REF !== "refs/heads/main" || !["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? ""))) throw new Error("trusted-main-workflow-required");
  const accepted = command === "translate"
    ? { policy: validatePolicy(parseStrictJSON(await Bun.file(join(checkout, "maintenance.config.json")).text())), baseSha: process.env.MAINTENANCE_BASE_SHA ?? "" }
    : await loadAcceptedPolicy(checkout);
  const readToken = process.env.GH_TOKEN;
  const maintenanceToken = process.env.MAINTENANCE_GH_TOKEN;
  if (command !== "translate") { delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN; delete process.env.MAINTENANCE_GH_TOKEN; }
  if (command !== "translate" && git(checkout, ["rev-parse", "HEAD"]) !== accepted.baseSha) throw new Error("trusted-code-not-accepted-main");
  const { policy, baseSha } = accepted;
  if (command === "translate") {
    if (process.env.MAINTENANCE_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) throw new Error("translation-github-secret-forbidden");
    const { root, candidate } = await translationStage("bundle", async () => {
      const root = resolve(option(args, "--bundle") ?? ""); const candidate = await validateBundle(root);
      if (candidate.baseSha !== baseSha || candidate.repository !== policy.repository || candidate.runId !== process.env.GITHUB_RUN_ID || candidate.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error("translation-bundle-origin-mismatch");
      return { root, candidate };
    });
    const { snapshots, catalog } = await translationStage("input", async () => {
      const input = asRecord(parseStrictJSON(await Bun.file(join(root, "input.json")).text()));
      if (!input || Object.keys(input).join(",") !== "snapshots" || !Array.isArray(input.snapshots)) throw new Error("translation-input-invalid");
      return { snapshots: input.snapshots.map(value => snapshotValue(value)), catalog: parseCatalogJSON(await Bun.file(join(root, "data", CATALOG_PATH)).text()) };
    });
    const requests: { messages: readonly { role: string; content: string }[]; bytes: string; sha256: string }[] = [];
    const result = await translationStage("translate", () => translateCandidate({ candidateVersion: candidate.upstreamVersion, snapshots, catalog, request: async messages => {
      const response = await requestModelJSON(messages);
      requests.push({ messages, bytes: response.bytes, sha256: response.sha256 });
      await writeArtifact(join(root, "requests.json"), requests);
      return response;
    } }));
    await translationStage("output", async () => {
      await writeArtifact(join(root, "data", CATALOG_PATH), result.catalog);
      const manifestPath = join(root, "data/src/translations/variant-review.json");
      const manifest = asRecord(parseStrictJSON(await Bun.file(manifestPath).text()));
      if (!manifest || !Array.isArray(manifest.variants)) throw new Error("variant-review-manifest-invalid");
      manifest.semanticReview = "disabled";
      await writeArtifact(manifestPath, manifest);
      await writeArtifact(join(root, "requests.json"), requests);
      await writeBundleManifest(root, candidate);
    });
    return;
  }
  if (process.env.MAINTENANCE_API_KEY) throw new Error("model-secret-forbidden-in-nontranslation-command");
  if (command === "discover") {
    const github = new HostedGitHub(policy, readToken ?? "");
    try { await output(await discover(checkout, baseSha, policy, github, process.env.REQUESTED_VERSION || option(args, "--version"))); }
    catch (error) { await output({ mode: "blocked", baseSha, reason: error instanceof Error ? error.message : "discovery-blocked" }); throw error; }
  } else if (command === "prepare") {
    if (maintenanceToken) throw new Error("prepare-write-secret-forbidden");
    const version = option(args, "--version") ?? ""; const base = option(args, "--base"); const root = option(args, "--output") ?? "";
    if (!stableVersion.test(version) || base !== baseSha) throw new Error("prepare-version-or-base-invalid");
    const pkg = asRecord(parseStrictJSON(git(checkout, ["show", `${baseSha}:package.json`])));
    const parts = String(pkg?.version).split(".").map(Number);
    const candidate: Candidate = { schemaVersion: 1, repository: policy.repository, runId: process.env.GITHUB_RUN_ID ?? "", runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "", baseSha, upstreamVersion: version, releaseVersion: `${parts[0]}.${parts[1]! + 1}.0`, semanticReview: "disabled", files: [] };
    await prepareCandidate(checkout, root, candidate, policy);
  } else if (command === "verify") {
    if (maintenanceToken) throw new Error("verification-secret-forbidden");
    const root = resolve(option(args, "--bundle") ?? ""); const candidate = await validateBundle(root);
    if (candidate.baseSha !== baseSha || candidate.runId !== process.env.GITHUB_RUN_ID || candidate.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error("verification-origin-mismatch");
    await verifyCandidate(checkout, root, policy, readToken);
  } else {
    const token = maintenanceToken;
    if (!token) throw new Error("maintenance-pat-required");
    const github = new HostedGitHub(policy, token);
    if (command === "publish-candidate") await publishCandidate(checkout, resolve(option(args, "--bundle") ?? ""), github, process.env.MAINTENANCE_ARTIFACT_ID ?? "");
    else await finalizeCandidate(checkout, option(args, "--version") ?? "", github);
  }
}
type TranslationStage = "bundle" | "input" | "translate" | "output";
/** Fixed stage wrapper: the CLI prints only the stage plus a fixed detail, never the cause. */
class TranslationStageError extends Error {
  readonly stage: TranslationStage;
  readonly cause: unknown;
  constructor(stage: TranslationStage, cause: unknown) { super("translation-stage-failed"); this.name = "TranslationStageError"; this.stage = stage; this.cause = cause; }
}
async function translationStage<T>(stage: TranslationStage, body: () => Promise<T> | T): Promise<T> {
  try { return await body(); } catch (error) { throw error instanceof TranslationStageError ? error : new TranslationStageError(stage, error); }
}
async function writeArtifact(path: string, value: unknown): Promise<void> {
  await translationStage("output", () => Bun.write(path, JSON.stringify(value, null, 2) + "\n"));
}
const TRANSLATION_SYSTEM_CODES: Readonly<Record<string, true>> = { ENOENT: true, EACCES: true, EPERM: true, EISDIR: true, ENOTDIR: true, EEXIST: true, ENOSPC: true, EMFILE: true, ENAMETOOLONG: true, EIO: true, ERR_INVALID_ARG_TYPE: true, ERR_OUT_OF_RANGE: true };
function modelFailure(error: ModelRequestError): string {
  if (error.config !== undefined) return `${error.code}:${error.config}`;
  if (error.status !== undefined) return `${error.code}-${error.status}`;
  return error.code;
}
function translationDetail(error: unknown): string {
  if (error instanceof Error) {
    if ("code" in error && typeof error.code === "string" && Object.hasOwn(TRANSLATION_SYSTEM_CODES, error.code)) return error.code;
    const name = error.constructor.name;
    if (name === "SyntaxError") return "SyntaxError";
    if (name === "Error") return "Error";
  }
  return "unclassified";
}
function translationFailure(error: unknown): string {
  let cause: unknown = error;
  while (cause instanceof TranslationStageError) cause = cause.cause;
  if (cause instanceof ModelRequestError) return modelFailure(cause);
  const detail = translationDetail(cause);
  return error instanceof TranslationStageError ? `translate-failed:${error.stage}:${detail}` : `translate-failed:${detail}`;
}
if (import.meta.main) await main().catch(async error => {
  const reason = process.argv[2] === "translate"
    ? translationFailure(error)
    : error instanceof Error && /^[A-Za-z0-9:._/-]{1,300}$/.test(error.message) ? error.message : "maintenance-action-blocked";
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nBlocked: ${reason}\n`);
  console.error(reason); process.exitCode = 1;
});

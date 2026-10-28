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
import { SUPPORTED_HOSTS, validateSupportedHostsManifest } from "./maintenance/paths";
import { pendingWindowVersions, selectUpstreamWindow } from "./maintenance/upstream-window";
import { canStartPreparation, classifyOutcomeReason, sanitizeOutcomeReason, type MaintenanceOutcome, type OutcomeStage } from "./maintenance/outcome";

const REGISTRY_LIMIT = 32 * 1024 * 1024;
const REGISTRY_TIMEOUT_MS = 30_000;

async function fetchJSONBounded(url: string): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), redirect: "error" }); }
  catch (error) { if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("registry-timeout"); throw new Error("registry-network-unconfirmed"); }
  if (!response.ok) throw new Error(`registry-http-${response.status}`);
  if (!response.body) throw new Error("registry-window-invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > REGISTRY_LIMIT) {
        await reader.cancel().catch(() => {});
        throw new Error("registry-response-too-large");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("registry-timeout");
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseStrictJSON(new TextDecoder().decode(bytes));
}
export interface Discovery { readonly mode: "no-work" | "prepare" | "resume" | "blocked"; readonly candidateVersion?: string; readonly baseSha: string; readonly reason?: string }
export async function discover(checkout: string, baseSha: string, policy: ControllerPolicy, github: HostedGitHub, requested?: string): Promise<Discovery> {
  const paused = process.env.MAINTENANCE_PAUSED;
  if (paused !== undefined && paused !== "" && paused !== "true" && paused !== "false") throw new Error("maintenance-pause-invalid");
  if (paused === "true") return { mode: "blocked", baseSha, reason: "maintenance-paused" };
  if (requested && !stableVersion.test(requested)) throw new Error("requested-stable-version-required");
  const pending: string[] = [];
  for (const { pr, identity } of await github.ownedPulls()) {
    const release = await github.checks.releaseState(`v${identity.releaseVersion}`);
    let published = false;
    if (pr.merged_at && release && !release.draft) {
      const checks = await github.checks.checkWorkflowRun(String(pr.merge_commit_sha));
      if (checks.kind === "found") {
        const proof = await github.checks.verifyPublishedRelease(`v${identity.releaseVersion}`, checks.runId, String(pr.merge_commit_sha));
        published = proof.kind === "found";
        if (proof.kind === "blocked") throw new Error(proof.reason);
      }
    }
    if (published) continue;
    if (!pr.merged_at && pr.state !== "open") continue;
    const merged = Boolean(pr.merged_at);
    const artifact = merged ? undefined : asRecord(await github.api(`repos/${policy.repository}/actions/artifacts/${identity.artifactId}`));
    const baseDrift = !merged && (identity.baseSha !== baseSha || artifact?.expired === true);
    if (!merged && !baseDrift) {
      await github.origin({ ...identity, semanticReview: "disabled", files: [] }, identity.artifactId);
    } else {
      // Merged candidates may outlive their bundle; their original trusted run still identifies them.
      const run = asRecord(await github.api(`repos/${policy.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`));
      if (!run || String(run.id) !== identity.runId || String(run.run_attempt) !== identity.runAttempt || run.path !== ".github/workflows/upstream-watch.yml" || !["schedule", "workflow_dispatch"].includes(String(run.event)) || run.head_branch !== "main" || run.head_sha !== identity.baseSha || asRecord(run.repository)?.full_name !== policy.repository) throw new Error("resume-origin-invalid");
    }
    if (!baseDrift) {
      const sha = merged ? pr.merge_commit_sha : identity.headSha;
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("resume-merge-sha-invalid");
      const branch = merged ? "main" : `upgrade/omp-${identity.upstreamVersion}`;
      const rows = await github.list(`repos/${policy.repository}/actions/runs?head_sha=${sha}`, "workflow_runs");
      const runs = rows.filter(run => run.path === ".github/workflows/check.yml" && run.event === "push");
      const ids = new Set<number>();
      for (const run of runs) {
        if (typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id <= 0 || typeof run.run_attempt !== "number" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.head_sha !== sha || run.head_branch !== branch || asRecord(run.repository)?.full_name !== policy.repository || asRecord(run.head_repository)?.full_name !== policy.repository) throw new Error(`check-run-binding-invalid:${String(run.id)}`);
        if (ids.has(run.id)) throw new Error(`check-run-ambiguous:${sha}`);
        ids.add(run.id);
      }
      runs.sort((left, right) => Number(right.id) - Number(left.id));
      const run = runs[0];
      if (run) {
        if (!["queued", "in_progress", "waiting", "pending", "requested", "completed"].includes(String(run.status))) throw new Error(`check-run-binding-invalid:${String(run.id)}`);
        if (run.status === "completed" && run.conclusion !== "success") {
          if (!["failure", "cancelled", "timed_out"].includes(String(run.conclusion))) throw new Error(`check-run-blocked:${String(run.conclusion)}:${String(run.id)}`);
          if (Number(run.run_attempt) >= 3) throw new Error(`candidate-checks-retries-exhausted:${String(run.id)}`);
        }
      }
    }
    pending.push(identity.upstreamVersion);
  }
  if (pending.length > 1) throw new Error("multiple-unfinished-maintenance-candidates");
  if (pending.length) return { mode: "resume", candidateVersion: pending[0]!, baseSha };

  const pkg = asRecord(parseStrictJSON(git(checkout, ["show", `${baseSha}:package.json`])));
  const pinned = asRecord(pkg?.devDependencies)?.["@oh-my-pi/pi-coding-agent"];
  if (typeof pinned !== "string" || !stableVersion.test(pinned)) throw new Error("accepted-pin-invalid");
  const support = validateSupportedHostsManifest(parseStrictJSON(git(checkout, ["show", `${baseSha}:${SUPPORTED_HOSTS}`])));
  const active = new Set(support.versions.map(row => row.version));
  const serviced = new Set([...active, ...(support.historical ?? []).map(row => row.version)]);
  const metadata = await fetchJSONBounded("https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent");
  const target = selectUpstreamWindow(metadata);
  // Latest is not a ceiling for the stable window, but a rollback is still an explicit stop.
  const latest = asRecord(asRecord(metadata)?.["dist-tags"])?.latest;
  if (typeof latest !== "string") throw new Error("registry-window-invalid");
  if (compareVersions(latest, pinned) < 0) throw new Error("registry-latest-regressed");
  for (const version of target) if (compareVersions(version, pinned) <= 0 && !active.has(version)) throw new Error("support-window-backfill-required");
  const next = pendingWindowVersions(target, pinned).find(version => !active.has(version));
  if (requested && requested !== next) {
    if (serviced.has(requested)) return { mode: "no-work", candidateVersion: requested, baseSha };
    throw new Error("requested-version-not-next");
  }
  if (!next) return { mode: "no-work", candidateVersion: pinned, baseSha };
  const candidateVersion = next;
  await output({ mode: "blocked", candidateVersion, baseSha, reason: "candidate-selected" });
  const retryBlocked = process.env.RETRY_BLOCKED === "true" && process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (process.env.RETRY_BLOCKED === "true" && !retryBlocked) throw new Error("retry-blocked-manual-only");
  if (retryBlocked && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, "\nManual retry_blocked starts a new preparation cycle; CI attempt limits remain unchanged.\n");
  let outcomes: readonly MaintenanceOutcome[];
  try { outcomes = await github.readOutcomes(baseSha, candidateVersion); }
  catch (error) {
    if (!retryBlocked || !(error instanceof Error) || error.message !== "maintenance-outcome-unavailable") throw error;
    outcomes = [];
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, "\nManual reset acknowledges unavailable previous outcome evidence.\n");
  }
  if (!canStartPreparation(outcomes, baseSha, candidateVersion, retryBlocked)) throw new Error("maintenance-outcome-blocked");
  for (const name of ["pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"]) {
    let value: unknown;
    try { value = await fetchJSONBounded(`https://registry.npmjs.org/@oh-my-pi%2F${name}/${candidateVersion}`); }
    catch (error) { if (error instanceof Error && error.message === "registry-http-404") throw new Error("companion-package-unavailable"); throw error; }
    const companion = asRecord(value);
    if (companion?.version !== candidateVersion || typeof asRecord(companion?.dist)?.integrity !== "string") throw new Error("companion-package-invalid");
  }
  let native: unknown;
  try { native = await github.api(`repos/can1357/oh-my-pi/releases/tags/v${candidateVersion}`); }
  catch (error) { if (error instanceof Error && error.message === "github-http-404") throw new Error("native-asset-unavailable"); throw error; }
  for (const platform of ["win32", "darwin", "linux"]) {
    const assets = asRecord(native)?.assets;
    if (Array.isArray(assets) && !assets.some(asset => asRecord(asset)?.name === (platform === "win32" ? "omp-windows-x64.exe" : `omp-${platform}-x64`))) throw new Error("native-asset-unavailable");
    selectFixedHostAsset(native, candidateVersion, platform, "x64");
  }
  return { mode: "prepare", candidateVersion, baseSha };
}
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`option-value-required:${name}`); return value;
}
async function output(discovery: Discovery): Promise<void> {
  console.log(JSON.stringify({ ...discovery, ...(discovery.reason ? { reason: sanitizeOutcomeReason(discovery.reason) } : {}) }));
  const reason = discovery.reason ? sanitizeOutcomeReason(discovery.reason) : "none";
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `mode=${discovery.mode}\n${discovery.candidateVersion ? `version=${discovery.candidateVersion}\n` : ""}base=${discovery.baseSha}\nreason=${reason}\nretryable=${classifyOutcomeReason(reason, "discover")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Hosted maintenance: ${discovery.mode}\n\n${reason === "none" ? discovery.candidateVersion ?? "" : reason}\n`);
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
  if (command === "discover" && process.env.GITHUB_ACTIONS === "true" && accepted.baseSha !== process.env.GITHUB_SHA) throw new Error("trusted-discovery-run-base-mismatch");
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
    else {
      const outcome = await finalizeCandidate(checkout, option(args, "--version") ?? "", github);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
    }
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
  const command = process.argv[2];
  const stage: OutcomeStage = command === "discover" || command === "prepare" || command === "translate" || command === "verify" ? command : "publish";
  const reason = process.argv[2] === "translate"
    ? translationFailure(error)
    : sanitizeOutcomeReason(error instanceof Error ? error.message : "maintenance-action-blocked");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `reason=${reason}\nretryable=${classifyOutcomeReason(reason, stage)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nBlocked: ${reason}\n`);
  console.error(reason); process.exitCode = 1;
});

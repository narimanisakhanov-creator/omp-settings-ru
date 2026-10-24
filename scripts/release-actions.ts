import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { asRecord, parseStrictJSON } from "./maintenance/json";
import {
  catalogIdentity,
  findRelease,
  readField,
  runGh,
  sha256Bytes,
  tagCommit,
  validatePrepublicationCatalog,
  waitForCheckRun,
  type PrepublicationEvidence,
} from "./marketplace-catalog";

/**
 * The release side of the marketplace channel: tag proof, draft reconciliation and the
 * prepublication proof that must exist before the existing publisher is allowed to run.
 *
 * There is exactly one publisher (`marketplace-index.ts`); this module never writes a
 * catalog, never promotes a release and never creates/deletes tags. Prepublication evidence
 * is taken from the successful release run's own artifact, so proving a draft never needs a
 * token that can read or write a draft release. The draft job itself reads the release back
 * and resumes a partially uploaded draft with the missing assets.
 */

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[1-9]\d{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAIN_BRANCH = "main";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const MARKETPLACE_WORKFLOW = ".github/workflows/marketplace-index.yml";
const CATALOG_ASSET = "marketplace.json";
const SUMS_ASSET = "SHA256SUMS";

function record(value: unknown, reason: string): Record<string, unknown> {
  const row = asRecord(value);
  if (!row) throw new Error(reason);
  return row;
}

function sha256(value: string, reason: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(reason);
  return value;
}

function hash(value: unknown, reason: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(reason);
  return value;
}

function runId(value: unknown, reason: string): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !RUN_ID.test(text)) throw new Error(reason);
  return text;
}

function repositoryName(value: string): string {
  if (!REPOSITORY.test(value)) throw new Error("release-repository-invalid");
  return value;
}

/** The single tag contract: an immutable stable `vX.Y.Z`, never a prerelease or a range. */
export function parseReleaseTag(value: string): { tag: string; version: string } {
  if (typeof value !== "string" || !TAG.test(value)) throw new Error("release-tag-invalid");
  return { tag: value, version: value.slice(1) };
}

export function expectedAssetNames(version: string): readonly string[] {
  return [`omp-settings-ru-${version}.tgz`, SUMS_ASSET, CATALOG_ASSET];
}

/** The attempt that uploaded the prepublish receipt, read from its immutable name. */
export function parsePrepublishArtifactName(name: string, tag: string, runId: string): string {
  const prefix = `prepublish-${parseReleaseTag(tag).tag}-${runId}-`;
  const attempt = typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (!RUN_ID.test(attempt)) throw new Error("release-artifact-name-mismatch");
  return attempt;
}

/**
 * Read the build attempt out of the build artifact's own name.
 *
 * A rerun of only the privileged job increments the run attempt but does not re-run the
 * build, so the attempt can never be taken from the current environment or from a job
 * output that may not survive a partial rerun. The uploaded name is immutable and already
 * carries the attempt that produced the bytes.
 */
export function parseReleaseArtifactName(name: string, tag: string, runId: string): string {
  const prefix = `release-${parseReleaseTag(tag).tag}-${runId}-`;
  const attempt = typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (!RUN_ID.test(attempt)) throw new Error("release-artifact-name-mismatch");
  return attempt;
}

/**
 * Bind the downloaded manifest to the artifact that carried it.
 *
 * The manifest's own `runAttempt` must equal the attempt embedded in the artifact name, and
 * both must belong to this run. Anything else is a mismatched pair and is refused before a
 * release is touched.
 */
export function bindReleaseArtifact(rawManifest: unknown, expected: { repository: string; tag: string; version: string; releaseSha: string; runId: string; artifactName: string }): ReleaseManifest {
  const attempt = parseReleaseArtifactName(expected.artifactName, expected.tag, expected.runId);
  return parseReleaseManifest(rawManifest, { ...expected, runAttempt: attempt });
}

export interface ReleaseRunProof {
  readonly id: string;
  readonly attempt: string;
  readonly event: "push" | "workflow_dispatch";
  readonly headSha: string;
  readonly headBranch: string;
}

/**
 * Read one release workflow run against the exact tag commit.
 *
 * The run is the authority for the artifact: repository, workflow path, event, branch and
 * commit are all checked rather than taken from a step output. The draft job runs inside
 * its own still-open run, so `requireSuccess` is reserved for the completed run that
 * prepublish has to observe.
 */
export function parseReleaseRun(raw: unknown, expected: { repository: string; tag: string; tagSha: string; runId?: string; runAttempt?: string; requireSuccess: boolean }): ReleaseRunProof {
  const run = record(raw, "release-run-unreadable");
  const id = runId(run.id, "release-run-id-invalid");
  const attempt = runId(run.run_attempt, "release-run-attempt-invalid");
  if (expected.runId !== undefined && id !== expected.runId) throw new Error("release-run-id-mismatch");
  if (expected.runAttempt !== undefined && attempt !== expected.runAttempt) throw new Error("release-run-attempt-mismatch");
  if (run.path !== RELEASE_WORKFLOW) throw new Error("release-run-workflow-mismatch");
  if (record(run.repository, "release-run-repository-missing").full_name !== expected.repository) throw new Error("release-run-repository-mismatch");
  if (run.event !== "push" && run.event !== "workflow_dispatch") throw new Error("release-run-event-invalid");
  if (run.head_branch !== expected.tag) throw new Error("release-run-tag-mismatch");
  if (run.head_sha !== expected.tagSha) throw new Error("release-run-sha-mismatch");
  if (expected.requireSuccess) {
    if (run.status !== "completed" || run.conclusion !== "success") throw new Error("release-run-not-successful");
  } else if (run.status === "completed" && run.conclusion !== "success") {
    throw new Error("release-run-not-successful");
  }
  return { id, attempt, event: run.event, headSha: expected.tagSha, headBranch: expected.tag };
}

/**
 * Pick the successful release run for a tag commit from one or more run pages.
 *
 * A rerun keeps the run id and increments `run_attempt`; the highest successful attempt is
 * the one whose artifact is allowed to feed the draft. A green run for another commit or
 * another workflow is not evidence at all.
 */
export function selectReleaseRun(rows: unknown, expected: { repository: string; tag: string; tagSha: string }): Record<string, unknown> {
  if (!Array.isArray(rows)) throw new Error("release-runs-unreadable");
  const candidates = rows.flatMap(value => {
    const run = asRecord(value);
    if (!run) return [];
    if (run.path !== RELEASE_WORKFLOW || run.head_sha !== expected.tagSha || run.head_branch !== expected.tag) return [];
    if (asRecord(run.repository)?.full_name !== expected.repository) return [];
    if (run.event !== "push" && run.event !== "workflow_dispatch") return [];
    return [run];
  });
  const successful = candidates.filter(run => run.status === "completed" && run.conclusion === "success");
  if (successful.length === 0) {
    if (candidates.length === 0) throw new Error("release-run-missing");
    if (candidates.some(run => run.status !== "completed")) throw new Error("release-run-pending");
    throw new Error("release-run-not-successful");
  }
  successful.sort((left, right) => Number(right.run_attempt) - Number(left.run_attempt) || Number(right.id) - Number(left.id));
  return successful[0]!;
}

export interface BuildJobProof {
  readonly id: string;
  readonly name: string;
  readonly conclusion: "success";
}

/**
 * Prove the read-only build job completed successfully in this exact run attempt.
 *
 * The draft job runs before the release run itself can be `completed`, so the build job's
 * own API record is the conclusion that authorises reading its artifact. A job from another
 * attempt, another head or a failed conclusion is not evidence. `name` selects which job of
 * that attempt is proven; it defaults to the `verify` job that uploads the artifact.
 */
export function parseBuildJob(raw: unknown, expected: { runId: string; runAttempt: string; tagSha: string; name?: string }): BuildJobProof {
  const name = expected.name ?? "verify";
  const payload = asRecord(raw);
  const jobs = Array.isArray(raw) ? raw : payload?.jobs;
  if (!Array.isArray(jobs)) throw new Error("release-build-jobs-unreadable");
  const matches = jobs.filter(value => {
    const job = asRecord(value);
    return job?.name === name && String(job.run_id) === expected.runId && String(job.run_attempt) === expected.runAttempt && job.head_sha === expected.tagSha;
  });
  if (matches.length === 0) throw new Error("release-build-job-missing");
  if (matches.length > 1) throw new Error("release-build-job-ambiguous");
  const job = matches[0]!;
  if (job.status !== "completed") throw new Error("release-build-job-pending");
  if (job.conclusion !== "success") throw new Error("release-build-job-not-successful");
  return { id: String(job.id), name, conclusion: "success" };
}

export interface ArtifactProof {
  readonly id: number;
  readonly name: string;
  readonly runId: string;
  readonly headSha: string;
  readonly headBranch: string;
}

/**
 * Prove an artifact against the exact originating run.
 *
 * The id is immutable, the name embeds the run id and attempt (so a rerun cannot present an
 * older attempt's artifact), the artifact must not be expired, and its workflow-run metadata
 * must still name the run and commit that produced it.
 */
export function parseArtifact(raw: unknown, expected: { name: string; id: number; runId: string; headSha: string }): ArtifactProof {
  const artifact = record(raw, "release-artifact-unreadable");
  const id = artifact.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("release-artifact-id-invalid");
  if (id !== expected.id) throw new Error("release-artifact-id-mismatch");
  if (artifact.name !== expected.name) throw new Error("release-artifact-name-mismatch");
  if (artifact.expired !== false) throw new Error("release-artifact-expired");
  if (typeof artifact.size_in_bytes !== "number" || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) throw new Error("release-artifact-size-invalid");
  if (artifact.digest !== undefined && artifact.digest !== null && (typeof artifact.digest !== "string" || !DIGEST.test(artifact.digest))) throw new Error("release-artifact-digest-invalid");
  const origin = record(artifact.workflow_run, "release-artifact-run-missing");
  if (origin.id === undefined || String(origin.id) !== expected.runId) throw new Error("release-artifact-run-mismatch");
  if (origin.head_sha !== expected.headSha) throw new Error("release-artifact-head-mismatch");
  return { id, name: expected.name, runId: expected.runId, headSha: expected.headSha, headBranch: typeof origin.head_branch === "string" ? origin.head_branch : "" };
}

export interface ReleaseArtifactSelection {
  readonly id: number;
  readonly name: string;
  readonly attempt: string;
}

/**
 * Pick the release artifact this run uploaded, from the run's own artifact list.
 *
 * A rerun of only the privileged `draft` job increments the run attempt without re-running
 * `verify`, so the artifact keeps the attempt that actually produced its bytes; the name,
 * not the current environment, is the authority. Name, run, head and non-expiry are all
 * re-proven, and between two genuine attempts the newest one wins, exactly like a rerun of
 * the whole workflow. An absent artifact is refused rather than downloaded by a guessed name.
 */
export function selectReleaseArtifact(raw: unknown, expected: { tag: string; runId: string; headSha: string }): ReleaseArtifactSelection {
  const payload = asRecord(raw);
  const artifacts = Array.isArray(raw) ? raw : payload?.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("release-artifacts-unreadable");
  const prefix = `release-${parseReleaseTag(expected.tag).tag}-${runId(expected.runId, "release-run-id-invalid")}-`;
  const candidates = artifacts.flatMap(value => {
    const row = asRecord(value);
    const name = row?.name;
    if (!row || typeof name !== "string" || !name.startsWith(prefix)) return [];
    const attempt = name.slice(prefix.length);
    if (!RUN_ID.test(attempt)) return [];
    return [{ row, name, attempt }];
  });
  if (candidates.length === 0) throw new Error("release-artifact-missing");
  const live = candidates.filter(candidate => candidate.row.expired === false);
  if (live.length === 0) throw new Error("release-artifact-expired");
  if (new Set(live.map(candidate => candidate.attempt)).size !== live.length) throw new Error("release-artifact-ambiguous");
  live.sort((left, right) => Number(right.attempt) - Number(left.attempt));
  const chosen = live[0]!;
  const id = chosen.row.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("release-artifact-id-invalid");
  parseArtifact(chosen.row, { name: chosen.name, id, runId: expected.runId, headSha: expected.headSha });
  return { id, name: chosen.name, attempt: chosen.attempt };
}

export interface ReleaseAssetSpec {
  readonly name: string;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly tag: string;
  readonly version: string;
  readonly releaseSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly assets: readonly ReleaseAssetSpec[];
}

const MANIFEST_KEYS = "assets,releaseSha,repository,runAttempt,runId,schemaVersion,tag,version";

/**
 * Read the asset manifest produced by the read-only build job.
 *
 * The manifest is data, not authentication: trust comes from the successful originating
 * run and the exact tag commit. It exists so the privileged job can refuse a truncated or
 * swapped artifact before touching a release.
 */
export function parseReleaseManifest(raw: unknown, expected: { repository: string; tag: string; version: string; releaseSha: string; runId: string; runAttempt: string }): ReleaseManifest {
  const manifest = record(raw, "release-manifest-invalid");
  if (Object.keys(manifest).sort().join(",") !== MANIFEST_KEYS) throw new Error("release-manifest-invalid");
  if (manifest.schemaVersion !== 1) throw new Error("release-manifest-schema");
  if (manifest.repository !== expected.repository || !REPOSITORY.test(expected.repository)) throw new Error("release-manifest-repository");
  if (manifest.tag !== expected.tag || manifest.version !== expected.version) throw new Error("release-manifest-tag");
  if (manifest.releaseSha !== expected.releaseSha) throw new Error("release-manifest-sha");
  if (manifest.runId !== expected.runId || manifest.runAttempt !== expected.runAttempt) throw new Error("release-manifest-run");
  const names = expectedAssetNames(expected.version);
  const assets = manifest.assets;
  if (!Array.isArray(assets) || assets.length !== names.length) throw new Error("release-manifest-assets");
  const parsed: ReleaseAssetSpec[] = [];
  for (const value of assets) {
    const asset = asRecord(value);
    if (!asset || Object.keys(asset).sort().join(",") !== "name,sha256") throw new Error("release-manifest-assets");
    if (typeof asset.name !== "string" || !names.includes(asset.name)) throw new Error("release-manifest-asset-name");
    if (parsed.some(entry => entry.name === asset.name)) throw new Error("release-manifest-assets");
    parsed.push({ name: asset.name, sha256: hash(asset.sha256, "release-manifest-asset-hash") });
  }
  if (parsed.map(asset => asset.name).sort().join("\0") !== [...names].sort().join("\0")) throw new Error("release-manifest-asset-name");
  return { schemaVersion: 1, repository: expected.repository, tag: expected.tag, version: expected.version, releaseSha: expected.releaseSha, runId: expected.runId, runAttempt: expected.runAttempt, assets: parsed };
}

/** Every manifest asset must be present with exactly the recorded bytes. */
export function verifyManifestAssets(manifest: ReleaseManifest, files: ReadonlyMap<string, Uint8Array>): void {
  for (const asset of manifest.assets) {
    const bytes = files.get(asset.name);
    if (!bytes) throw new Error(`release-asset-missing:${asset.name}`);
    if (sha256Bytes(bytes) !== asset.sha256) throw new Error(`release-asset-hash-mismatch:${asset.name}`);
  }
}

/** The archive hash recorded in `SHA256SUMS`; the manifest must agree with it. */
export function archiveChecksumFromSums(sums: Uint8Array, archiveName: string): string {
  const decoded = new TextDecoder().decode(sums);
  for (const line of decoded.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/, 2);
    if (parts[1] === archiveName) return parts[0] ?? "";
  }
  return "";
}

export interface ExistingReleaseAsset {
  readonly name: string;
  readonly digest: string | null;
}

export interface ReleaseAssetPlan {
  readonly action: "create" | "resume" | "identical";
  readonly upload: readonly ReleaseAssetSpec[];
  readonly skip: readonly string[];
}

/**
 * Decide what a draft reconciliation may do with the release's current assets.
 *
 * Missing assets are uploaded; an identical asset is left untouched; a differing digest is
 * a conflict and is refused before any write. A published release is never modified: it is
 * either byte-identical or refused. Foreign asset names are refused rather than ignored,
 * because a release must not carry assets this workflow did not build.
 */
export function planReleaseAssets(existing: readonly ExistingReleaseAsset[], wanted: readonly ReleaseAssetSpec[], published: boolean, releaseExists: boolean): ReleaseAssetPlan {
  if (wanted.length === 0 || new Set(wanted.map(asset => asset.name)).size !== wanted.length) throw new Error("release-manifest-assets");
  const byName = new Map<string, ExistingReleaseAsset>();
  for (const asset of existing) {
    if (byName.has(asset.name)) throw new Error(`release-assets-ambiguous:${asset.name}`);
    byName.set(asset.name, asset);
  }
  const wantedNames = new Set(wanted.map(asset => asset.name));
  for (const asset of existing) if (!wantedNames.has(asset.name)) throw new Error(`release-asset-foreign:${asset.name}`);
  const upload: ReleaseAssetSpec[] = [];
  const skip: string[] = [];
  for (const asset of wanted) {
    const current = byName.get(asset.name);
    if (!current) {
      if (published) throw new Error(`release-published-asset-missing:${asset.name}`);
      upload.push(asset);
      continue;
    }
    if (typeof current.digest !== "string" || !DIGEST.test(current.digest)) throw new Error(`release-asset-digest-unavailable:${current.name}`);
    if (current.digest.slice(7) !== asset.sha256) throw new Error(`release-asset-conflict:${current.name}`);
    skip.push(asset.name);
  }
  // A draft that already exists but carries no assets must be resumed, not re-created.
  const action: ReleaseAssetPlan["action"] = !releaseExists ? "create" : upload.length === 0 ? "identical" : "resume";
  return { action, upload, skip };
}

export interface PackageIdentity {
  readonly version: string;
  readonly hostVersion: string;
}

/** The tag's own package identity, read from the committed tree rather than the runner. */
export function packageIdentity(raw: unknown, expectedVersion: string): PackageIdentity {
  const pkg = record(raw, "release-package-unreadable");
  const version = pkg.version;
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) throw new Error("release-package-version-invalid");
  if (version !== expectedVersion) throw new Error("release-package-version-mismatch");
  const dependencies = asRecord(pkg.devDependencies);
  const host = dependencies?.["@oh-my-pi/pi-coding-agent"];
  if (typeof host !== "string" || !STABLE_VERSION.test(host)) throw new Error("release-host-version-invalid");
  return { version, hostVersion: host };
}

function gitEnv(): Record<string, string | undefined> {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL/i.test(key) || key.startsWith("GIT_CONFIG_")) delete environment[key];
  delete environment.GIT_ASKPASS;
  delete environment.SSH_ASKPASS;
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function gitResult(checkout: string, args: readonly string[]): { code: number; stdout: string } {
  const child = Bun.spawnSync(["git", ...args], { cwd: checkout, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stdout: new TextDecoder().decode(child.stdout).trim() };
}

function gitText(checkout: string, args: readonly string[], reason: string): string {
  const result = gitResult(checkout, args);
  if (result.code !== 0) throw new Error(reason);
  return result.stdout;
}

function requireCommit(checkout: string, sha: string): void {
  if (gitResult(checkout, ["cat-file", "-e", `${sha}^{commit}`]).code !== 0) throw new Error("release-commit-unavailable");
}

export function localMainSha(checkout: string): string {
  for (const ref of ["refs/remotes/origin/main", "refs/heads/main"]) {
    const result = gitResult(checkout, ["rev-parse", "--verify", ref]);
    if (result.code === 0 && SHA.test(result.stdout)) return result.stdout;
  }
  throw new Error("trusted-main-reference-missing");
}

/** The privileged jobs only ever execute scripts checked out at the accepted main commit. */
export function assertTrustedMain(checkout: string): string {
  const head = sha256(gitText(checkout, ["rev-parse", "--verify", "HEAD"], "release-checkout-unreadable"), "release-checkout-invalid");
  if (head !== localMainSha(checkout)) throw new Error("trusted-main-checkout-mismatch");
  return head;
}

export function assertReleaseAncestor(checkout: string, releaseSha: string): void {
  sha256(releaseSha, "release-sha-invalid");
  if (gitResult(checkout, ["merge-base", "--is-ancestor", releaseSha, "HEAD"]).code !== 0) throw new Error("release-sha-not-on-main");
}

export function packageAtCommit(checkout: string, releaseSha: string, version: string): PackageIdentity {
  const text = gitText(checkout, ["show", `${sha256(releaseSha, "release-sha-invalid")}:package.json`], "release-package-unavailable");
  return packageIdentity(parseStrictJSON(text), version);
}

export interface PrepublishEvidence {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly tag: string;
  readonly version: string;
  readonly tagSha: string;
  readonly releaseState: "draft";
  readonly releaseRunId: string;
  readonly releaseRunAttempt: string;
  readonly checkRunId: string;
  readonly catalogSha256: string;
  readonly archiveSha256: string;
  readonly sumsSha256: string;
  readonly hostVersion: string;
}

export interface PrepublishReceipt extends PrepublishEvidence {
  readonly smoke: "distribution-smoke";
  readonly smokePassed: true;
}

const EVIDENCE_KEYS = "archiveSha256,catalogSha256,checkRunId,hostVersion,releaseRunAttempt,releaseRunId,releaseState,repository,schemaVersion,sumsSha256,tag,tagSha,version";
const RECEIPT_KEYS = "archiveSha256,catalogSha256,checkRunId,hostVersion,releaseRunAttempt,releaseRunId,releaseState,repository,schemaVersion,smoke,smokePassed,sumsSha256,tag,tagSha,version";

function evidenceFields(row: Record<string, unknown>): PrepublishEvidence {
  if (row.schemaVersion !== 1 || typeof row.repository !== "string" || typeof row.tag !== "string") throw new Error("prepublish-receipt-invalid");
  const repository = repositoryName(row.repository);
  const tag = parseReleaseTag(row.tag);
  if (row.version !== tag.version) throw new Error("prepublish-receipt-invalid");
  // Prepublication evidence only ever describes a draft: the release state itself is
  // re-observed by the privileged promotion job, never asserted by this receipt.
  if (row.releaseState !== "draft") throw new Error("prepublish-receipt-invalid");
  if (typeof row.hostVersion !== "string" || !STABLE_VERSION.test(row.hostVersion)) throw new Error("prepublish-receipt-invalid");
  return {
    schemaVersion: 1,
    repository,
    tag: tag.tag,
    version: tag.version,
    tagSha: sha256(typeof row.tagSha === "string" ? row.tagSha : "", "prepublish-receipt-invalid"),
    releaseState: "draft",
    releaseRunId: runId(row.releaseRunId, "prepublish-receipt-invalid"),
    releaseRunAttempt: runId(row.releaseRunAttempt, "prepublish-receipt-invalid"),
    checkRunId: runId(row.checkRunId, "prepublish-receipt-invalid"),
    catalogSha256: hash(row.catalogSha256, "prepublish-receipt-invalid"),
    archiveSha256: hash(row.archiveSha256, "prepublish-receipt-invalid"),
    sumsSha256: hash(row.sumsSha256, "prepublish-receipt-invalid"),
    hostVersion: row.hostVersion,
  };
}

export function parsePrepublishEvidence(raw: unknown): PrepublishEvidence {
  const row = record(raw, "prepublish-receipt-invalid");
  if (Object.keys(row).sort().join(",") !== EVIDENCE_KEYS) throw new Error("prepublish-receipt-invalid");
  return evidenceFields(row);
}

export interface ArtifactEvidenceSource {
  readonly repository: string;
  readonly tag: string;
  readonly version: string;
  readonly tagSha: string;
  readonly checkRunId: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly hostVersion: string;
  readonly manifest: ReleaseManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/**
 * Build the prepublication evidence from the release artifact's own bytes.
 *
 * The draft release API is never read here: the successful release run that produced this
 * artifact is the authority, the manifest is bound to that run's exact repository, tag,
 * commit, id and attempt, and every byte is re-hashed locally. The catalog that the native
 * smoke will install is therefore exactly the catalog the sealed assets carry, not a copy
 * that the release service happened to serve at read time.
 */
export function artifactEvidence(source: ArtifactEvidenceSource): { evidence: PrepublishEvidence; catalogBytes: Uint8Array } {
  const { repository, tag, version, tagSha, manifest, files } = source;
  verifyManifestAssets(manifest, files);
  const archiveName = `omp-settings-ru-${version}.tgz`;
  const archive = manifest.assets.find(asset => asset.name === archiveName);
  if (!archive) throw new Error(`release-asset-missing:${archiveName}`);
  const sums = files.get(SUMS_ASSET);
  const catalogBytes = files.get(CATALOG_ASSET);
  if (!sums || !catalogBytes) throw new Error("release-manifest-assets");
  // The archive must be the one SHA256SUMS describes; the two artifacts cannot disagree.
  const sumsArchiveSha256 = archiveChecksumFromSums(sums, archiveName);
  if (sumsArchiveSha256 !== archive.sha256) throw new Error("release-checksums-mismatch");
  const sumsSha256 = sha256Bytes(sums);
  const catalogSha256 = sha256Bytes(catalogBytes);
  const prepublication: PrepublicationEvidence = {
    tag, version, targetCommitSha: tagSha, draft: true, prerelease: false, published: false,
    checksPassed: true, checksHeadSha: tagSha,
    assets: manifest.assets.map(asset => ({
      name: asset.name,
      digest: `sha256:${asset.sha256}`,
      browserDownloadUrl: `https://github.com/${repository}/releases/download/${tag}/${asset.name}`,
    })),
    archiveSha256: archive.sha256,
    sumsSha256,
    sumsArchiveSha256,
    catalogSha256,
  };
  const catalogText = new TextDecoder().decode(catalogBytes);
  let catalog: unknown;
  try {
    catalog = parseStrictJSON(catalogText);
  } catch {
    throw new Error("marketplace-prepublication-rejected:marketplace-catalog-malformed");
  }
  const errors = validatePrepublicationCatalog(catalog, prepublication, repository);
  if (errors.length > 0) throw new Error(`marketplace-prepublication-rejected:${errors.join(",")}`);
  return {
    catalogBytes,
    evidence: {
      schemaVersion: 1, repository, tag, version, tagSha,
      releaseState: "draft", releaseRunId: source.runId, releaseRunAttempt: source.runAttempt, checkRunId: source.checkRunId,
      catalogSha256, archiveSha256: archive.sha256, sumsSha256, hostVersion: source.hostVersion,
    },
  };
}

/**
 * Seal the evidence only after the native distribution smoke succeeded.
 *
 * The receipt is written by the last prepublish step, so its presence means the smoke step
 * already ran and exited successfully. A failure report, a changed catalog or an untrusted
 * home state makes sealing impossible rather than producing a promotable receipt.
 */
export function sealPrepublishReceipt(rawEvidence: unknown, catalogBytes: Uint8Array, smokeRaw: unknown): PrepublishReceipt {
  const evidence = parsePrepublishEvidence(rawEvidence);
  if (sha256Bytes(catalogBytes) !== evidence.catalogSha256) throw new Error("prepublish-catalog-changed");
  const smoke = record(smokeRaw, "prepublish-smoke-unreadable");
  if (Object.hasOwn(smoke, "failed")) throw new Error("prepublish-smoke-failed");
  if (smoke.personalProfileChanged !== false) throw new Error("prepublish-smoke-untrusted");
  if (!Array.isArray(smoke.observations) || smoke.observations.length === 0) throw new Error("prepublish-smoke-unproven");
  return { ...evidence, smoke: "distribution-smoke", smokePassed: true };
}

export function parsePrepublishReceipt(raw: unknown): PrepublishReceipt {
  const row = record(raw, "prepublish-receipt-invalid");
  if (Object.keys(row).sort().join(",") !== RECEIPT_KEYS) throw new Error("prepublish-receipt-invalid");
  if (row.smoke !== "distribution-smoke" || row.smokePassed !== true) throw new Error("prepublish-smoke-unproven");
  return { ...evidenceFields(row), smoke: "distribution-smoke", smokePassed: true };
}

export interface PromotionExpectation {
  readonly repository: string;
  readonly tag: string;
  readonly tagSha: string;
  readonly releaseRunId: string;
  readonly releaseRunAttempt: string;
  readonly hostVersion: string;
}

/** Every identity the promotion job re-observed must equal the sealed receipt. */
export function promotionErrors(receipt: PrepublishReceipt, expected: PromotionExpectation): readonly string[] {
  const errors: string[] = [];
  if (receipt.repository !== expected.repository) errors.push("promotion-repository-mismatch");
  if (receipt.tag !== expected.tag) errors.push("promotion-tag-mismatch");
  if (receipt.tagSha !== expected.tagSha) errors.push("promotion-sha-mismatch");
  if (receipt.releaseRunId !== expected.releaseRunId || receipt.releaseRunAttempt !== expected.releaseRunAttempt) errors.push("promotion-release-run-mismatch");
  if (receipt.hostVersion !== expected.hostVersion) errors.push("promotion-host-version-mismatch");
  return errors;
}

export interface MarketplaceRunProof {
  readonly id: string;
  readonly attempt: string;
  readonly event: "workflow_run" | "workflow_dispatch";
  readonly headSha: string;
  readonly headBranch: string;
}

/**
 * Prove the current marketplace-index run's origin.
 *
 * A manual dispatch is only accepted from `main`; a `workflow_run` is accepted because the
 * tag is carried by the sealed receipt and re-proven against the release run. The receipt,
 * not the dispatch payload or this run's head fields, remains the tag binding.
 */
export function parseMarketplaceRunOrigin(raw: unknown, expected: { repository: string }): MarketplaceRunProof {
  const run = record(raw, "marketplace-run-unreadable");
  const id = runId(run.id, "marketplace-run-id-invalid");
  const attempt = runId(run.run_attempt, "marketplace-run-attempt-invalid");
  if (run.path !== MARKETPLACE_WORKFLOW) throw new Error("marketplace-run-workflow-mismatch");
  if (record(run.repository, "marketplace-run-repository-missing").full_name !== expected.repository) throw new Error("marketplace-run-repository-mismatch");
  if (run.event === "workflow_run") {
    // The tag binding is the sealed receipt plus the release run proven for that tag. This
    // run's own head follows the triggering-workflow rules, so it is not used as a tag proof.
    sha256(typeof run.head_sha === "string" ? run.head_sha : "", "marketplace-run-sha-invalid");
  } else if (run.event === "workflow_dispatch") {
    if (run.head_branch !== MAIN_BRANCH) throw new Error("marketplace-run-ref-invalid");
    sha256(typeof run.head_sha === "string" ? run.head_sha : "", "marketplace-run-sha-invalid");
  } else {
    throw new Error("marketplace-run-event-invalid");
  }
  return { id, attempt, event: run.event, headSha: String(run.head_sha), headBranch: String(run.head_branch) };
}

/**
 * Post-publication proof: the latest release serves exactly this tag's catalog bytes.
 *
 * This reads the public channel rather than the draft, so a successful promote is not the
 * evidence by itself. A stale tag (a newer release is latest) is refused honestly.
 */
export function servedProofErrors(raw: unknown, catalogBytes: Uint8Array, expected: { repository: string; tag: string; tagSha: string }): readonly string[] {
  const errors: string[] = [];
  const release = asRecord(raw);
  let tag: { tag: string; version: string } | undefined;
  try {
    tag = parseReleaseTag(expected.tag);
  } catch {
    tag = undefined;
  }
  if (!release) return ["marketplace-served-release-unreadable"];
  if (release.tag_name !== expected.tag) errors.push("marketplace-served-release-tag-mismatch");
  if (release.draft !== false) errors.push("marketplace-served-release-draft");
  if (release.prerelease !== false) errors.push("marketplace-served-release-prerelease");
  if (typeof release.published_at !== "string") errors.push("marketplace-served-release-unpublished");
  const assets = Array.isArray(release.assets) ? release.assets.flatMap(value => {
    const asset = asRecord(value);
    return asset && typeof asset.name === "string" ? [{ name: asset.name, digest: typeof asset.digest === "string" ? asset.digest : null }] : [];
  }) : [];
  const catalogAssets = assets.filter(asset => asset.name === CATALOG_ASSET);
  if (catalogAssets.length !== 1) errors.push("marketplace-served-catalog-ambiguous");
  const digest = sha256Bytes(catalogBytes);
  if (catalogAssets.length === 1 && catalogAssets[0]!.digest !== `sha256:${digest}`) errors.push("marketplace-served-catalog-digest-mismatch");
  if (tag && assets.filter(asset => asset.name === `omp-settings-ru-${tag.version}.tgz`).length !== 1) errors.push("marketplace-served-assets-ambiguous");
  if (assets.filter(asset => asset.name === SUMS_ASSET).length !== 1) errors.push("marketplace-served-assets-ambiguous");
  let parsed: unknown;
  try {
    parsed = parseStrictJSON(new TextDecoder().decode(catalogBytes));
  } catch {
    return [...errors, "marketplace-served-catalog-malformed"];
  }
  let identity: { version: string; sha: string };
  try {
    identity = catalogIdentity(parsed, "marketplace-served");
  } catch {
    return [...errors, "marketplace-served-catalog-malformed"];
  }
  const catalogObject = asRecord(parsed);
  const plugins = catalogObject?.plugins;
  const plugin = Array.isArray(plugins) && plugins.length === 1 ? asRecord(plugins[0]) : undefined;
  if (!plugin || plugin.name !== "omp-settings-ru") errors.push("marketplace-served-plugin-mismatch");
  if (catalogObject?.name !== "omp-settings-ru" || asRecord(catalogObject.owner)?.name !== "narimanisakhanov-creator") errors.push("marketplace-served-owner-mismatch");
  const source = asRecord(plugin?.source);
  if (source?.source !== "github" || source.repo !== expected.repository || source.ref !== expected.tag || source.sha !== expected.tagSha) errors.push("marketplace-served-source-mismatch");
  if (tag && identity.version !== tag.version) errors.push("marketplace-served-version-mismatch");
  if (identity.sha !== expected.tagSha) errors.push("marketplace-served-sha-mismatch");
  return errors;
}

export interface ReleaseRow {
  readonly tag: string;
  readonly draft: boolean;
  readonly published: boolean;
  readonly assets: readonly ExistingReleaseAsset[];
}

export function parseReleaseRow(raw: unknown, tag: string): ReleaseRow {
  const release = record(raw, "release-unreadable");
  if (release.tag_name !== tag) throw new Error("release-tag-mismatch");
  if (release.prerelease === true) throw new Error("release-prerelease");
  if (typeof release.draft !== "boolean") throw new Error("release-state-invalid");
  const published = typeof release.published_at === "string";
  if (!release.draft && !published) throw new Error("release-state-invalid");
  const values = release.assets;
  if (!Array.isArray(values)) throw new Error("release-assets-unreadable");
  const assets = values.flatMap(value => {
    const asset = asRecord(value);
    const id = asset?.id;
    if (!asset || typeof asset.name !== "string" || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return [];
    return [{ name: asset.name, digest: typeof asset.digest === "string" ? asset.digest : null }];
  });
  return { tag, draft: release.draft, published, assets };
}

/** A release may carry exactly the three assets this workflow builds, once each. */
export function releaseNamingErrors(release: ReleaseRow, expected: readonly string[]): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const asset of release.assets) {
    if (!expected.includes(asset.name)) errors.push(`release-asset-foreign:${asset.name}`);
    else if (seen.has(asset.name)) errors.push(`release-assets-ambiguous:${asset.name}`);
    seen.add(asset.name);
  }
  for (const name of expected) if (!seen.has(name)) errors.push(`release-asset-missing:${name}`);
  return errors;
}

export function releaseDigestMatches(release: ReleaseRow, wanted: readonly ReleaseAssetSpec[]): readonly string[] {
  const errors: string[] = [];
  for (const asset of wanted) {
    const row = release.assets.find(candidate => candidate.name === asset.name);
    if (!row) errors.push(`release-asset-missing:${asset.name}`);
    else if (typeof row.digest !== "string" || !DIGEST.test(row.digest) || row.digest.slice(7) !== asset.sha256) errors.push(`release-asset-conflict:${asset.name}`);
  }
  return errors;
}

export const DRAFT_OBSERVABILITY_TIMEOUT_MS = 60_000;
const DRAFT_OBSERVABILITY_INTERVAL_MS = 2_000;

/**
 * Prove the draft by reading it back, not by trusting the write's exit code.
 *
 * GitHub's release write is not immediately readable on the follow-up GET, so a single read
 * after `gh release create` reports a release that exists as missing. The re-read loop is
 * bounded: a draft that never becomes visible fails the job instead of hanging, a draft that
 * is still missing assets reports which ones, and a draft that is already published is a
 * foreign write rather than a slow read.
 */
export async function observeDraftRelease(
  read: () => ReleaseRow | undefined,
  wanted: readonly ReleaseAssetSpec[],
  timeoutMs: number = DRAFT_OBSERVABILITY_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms),
  now: () => number = Date.now,
): Promise<ReleaseRow> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("release-wait-invalid");
  const deadline = now() + timeoutMs;
  for (;;) {
    const release = read();
    if (release?.published) throw new Error("release-draft-not-observable");
    const remaining = release ? releaseDigestMatches(release, wanted) : [];
    if (release && remaining.length === 0) return release;
    if (now() >= deadline) throw new Error(release ? `release-resume-incomplete:${remaining.join(",")}` : "release-draft-not-observable");
    await sleep(Math.min(DRAFT_OBSERVABILITY_INTERVAL_MS, deadline - now()));
  }
}

// ---------------------------------------------------------------------------
// CLI

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`option-required:${name}`);
  return value;
}

function ghJson(args: readonly string[]): unknown {
  return JSON.parse(runGh([...args]));
}

function ghMutation(args: readonly string[]): string {
  const child = Bun.spawnSync(["gh", ...args], { env: process.env, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  if (child.exitCode !== 0) throw new Error(`release-github-command-failed:${new TextDecoder().decode(child.stderr).trim().slice(0, 300)}`);
  return new TextDecoder().decode(child.stdout);
}

async function jsonFile(path: string, reason: string): Promise<unknown> {
  try {
    return parseStrictJSON(await Bun.file(path).text());
  } catch {
    throw new Error(reason);
  }
}

function readRelease(tag: string, repository: string): ReleaseRow | undefined {
  try {
    return parseReleaseRow(findRelease(tag, repository), tag);
  } catch (error) {
    if (error instanceof Error && error.message === "marketplace-release-not-found") return undefined;
    throw error;
  }
}

function releaseRunPages(repository: string, sha: string): readonly unknown[] {
  const rows: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = ghJson([`repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`]);
    const runs = readField(payload, "workflow_runs");
    if (!Array.isArray(runs)) throw new Error("release-runs-unreadable");
    rows.push(...runs);
    if (runs.length < 100) break;
  }
  return rows;
}

export function findSuccessfulReleaseRun(repository: string, expected: { tag: string; tagSha: string }): Record<string, unknown> {
  return selectReleaseRun(releaseRunPages(repository, expected.tagSha), { repository, ...expected });
}

async function fetchCatalog(repository: string, tag: string): Promise<Uint8Array> {
  const response = await fetch(`https://github.com/${repository}/releases/download/${tag}/${CATALOG_ASSET}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`marketplace-catalog-download-failed:${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1024 * 1024) throw new Error("marketplace-catalog-too-large");
  return bytes;
}

/**
 * Prove the read-only release run that produced the artifact this job may trust.
 *
 * Nothing is downloaded or written: this is the read-only half of the prepublication proof,
 * and it exists so the parts of the job that open released bytes (native host, smoke) never
 * need a token that can see or write a draft release. A successful run for any other commit,
 * a failed or pending job, or an artifact this repository did not upload is not evidence.
 */
async function prepublishSourceCommand(args: readonly string[]): Promise<void> {
  const parsed = parseReleaseTag(option(args, "--tag"));
  const repository = repositoryName(option(args, "--repository"));
  const checkout = resolve(option(args, "--checkout"));
  assertTrustedMain(checkout);
  const tagSha = tagCommit(repository, parsed.tag);
  requireCommit(checkout, tagSha);
  assertReleaseAncestor(checkout, tagSha);
  const pkg = packageAtCommit(checkout, tagSha, parsed.version);
  const run = parseReleaseRun(findSuccessfulReleaseRun(repository, { tag: parsed.tag, tagSha }), {
    repository, tag: parsed.tag, tagSha, requireSuccess: true,
  });
  // The draft job that wrote this run's release must be green in the attempt this run is on.
  const currentJobs = ghJson([`repos/${repository}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`]);
  parseBuildJob(currentJobs, { runId: run.id, runAttempt: run.attempt, tagSha, name: "draft" });
  const artifact = selectReleaseArtifact(ghJson([`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`]), {
    tag: parsed.tag, runId: run.id, headSha: tagSha,
  });
  // A rerun of only the privileged job keeps the earlier build attempt, whose `verify` job
  // is the one that actually produced these bytes; prove that attempt, not the environment.
  if (artifact.attempt === run.attempt) {
    parseBuildJob(currentJobs, { runId: run.id, runAttempt: run.attempt, tagSha });
  } else {
    parseBuildJob(ghJson([`repos/${repository}/actions/runs/${run.id}/attempts/${artifact.attempt}/jobs?per_page=100`]), {
      runId: run.id, runAttempt: artifact.attempt, tagSha,
    });
  }
  const source = {
    tag: parsed.tag,
    releaseRunId: run.id,
    releaseRunAttempt: artifact.attempt,
    tagSha,
    artifactName: artifact.name,
    hostVersion: pkg.hostVersion,
  };
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, [
    `release-run-id=${run.id}`,
    `release-run-attempt=${artifact.attempt}`,
    `tag-sha=${tagSha}`,
    `artifact-id=${artifact.id}`,
    `artifact-name=${artifact.name}`,
    `host-version=${pkg.hostVersion}`,
  ].join("\n") + "\n");
  console.log(JSON.stringify({ ok: true, ...source }, null, 2));
}

async function draftCommand(args: readonly string[]): Promise<void> {
  const parsed = parseReleaseTag(option(args, "--tag"));
  const repository = repositoryName(option(args, "--repository"));
  const run = option(args, "--run-id");
  const artifactIdText = option(args, "--artifact-id");
  const artifactId = Number(artifactIdText);
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error("release-artifact-id-invalid");
  const artifactName = option(args, "--artifact-name");
  const assets = resolve(option(args, "--assets"));
  const checkout = resolve(option(args, "--checkout"));
  const waitMs = args.includes("--wait-ms") ? Number(option(args, "--wait-ms")) : DRAFT_OBSERVABILITY_TIMEOUT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error("release-wait-invalid");
  const tagSha = tagCommit(repository, parsed.tag);
  requireCommit(checkout, tagSha);
  assertTrustedMain(checkout);
  assertReleaseAncestor(checkout, tagSha);
  const pkg = packageAtCommit(checkout, tagSha, parsed.version);
  const manifest = bindReleaseArtifact(await jsonFile(join(assets, "release.json"), "release-manifest-invalid"), {
    repository, tag: parsed.tag, version: parsed.version, releaseSha: tagSha, runId: run, artifactName,
  });
  const files = new Map<string, Uint8Array>();
  for (const asset of manifest.assets) files.set(asset.name, new Uint8Array(await readFile(join(assets, asset.name))));
  verifyManifestAssets(manifest, files);
  const archive = manifest.assets.find(asset => asset.name === `omp-settings-ru-${parsed.version}.tgz`)!;
  const sums = files.get(SUMS_ASSET)!;
  if (archiveChecksumFromSums(sums, archive.name) !== archive.sha256) throw new Error("release-checksums-mismatch");
  parseReleaseRun(ghJson([`repos/${repository}/actions/runs/${run}`]), {
    repository, tag: parsed.tag, tagSha, runId: run, requireSuccess: false,
  });
  parseBuildJob(ghJson([`repos/${repository}/actions/runs/${run}/attempts/${manifest.runAttempt}/jobs?per_page=100`]), { runId: run, runAttempt: manifest.runAttempt, tagSha });
  parseArtifact(ghJson([`repos/${repository}/actions/artifacts/${artifactId}`]), {
    name: artifactName, id: artifactId, runId: run, headSha: tagSha,
  });
  const existing = readRelease(parsed.tag, repository);
  if (existing?.published) {
    const errors = [...releaseNamingErrors(existing, expectedAssetNames(parsed.version)), ...releaseDigestMatches(existing, manifest.assets)];
    if (errors.length > 0) throw new Error(`release-published-refusal:${errors.join(",")}`);
    console.log(JSON.stringify({ decision: "identical", tag: parsed.tag, releaseSha: tagSha, version: pkg.version }, null, 2));
    return;
  }
  const plan = planReleaseAssets(existing?.assets ?? [], manifest.assets, false, existing !== undefined);
  const notesPath = join(assets, "release-notes.md");
  const notes = (await Bun.file(notesPath).text().catch(() => "")).trim() || `${parsed.tag}`;
  if (plan.action === "create") {
    const notesFile = join(assets, ".release-notes.md");
    await writeFile(notesFile, notes + "\n", "utf8");
    ghMutation([
      "release", "create", parsed.tag,
      ...manifest.assets.map(asset => join(assets, asset.name)),
      "--repo", repository, "--draft", "--verify-tag", "--title", parsed.tag,
      "--notes-file", notesFile,
    ]);
  } else if (plan.upload.length > 0) {
    ghMutation(["release", "upload", parsed.tag, ...plan.upload.map(asset => join(assets, asset.name)), "--repo", repository]);
  }
  // The write just happened, but GitHub's read side is eventually consistent: prove the
  // draft (and every expected asset) by re-reading it within the bounded deadline.
  const settled = await observeDraftRelease(() => readRelease(parsed.tag, repository), manifest.assets, waitMs);
  console.log(JSON.stringify({ decision: plan.action, uploaded: plan.upload.map(asset => asset.name), skipped: plan.skip, observed: settled.assets.map(asset => asset.name), tag: parsed.tag, releaseSha: tagSha, version: pkg.version, artifactId, waitMs }, null, 2));
}

/**
 * Prove the draft from the release job's own artifact, never from the draft release API.
 *
 * A draft release is invisible to the read-only token this job holds, so the run-bound
 * artifact is the evidence: the manifest binds these bytes to the repository, tag, commit,
 * run and attempt, every asset is re-hashed here, the archive must equal SHA256SUMS, and the
 * catalog handed to the native smoke is the catalog those hashes describe.
 */
async function prepublishCommand(args: readonly string[]): Promise<void> {
  const parsed = parseReleaseTag(option(args, "--tag"));
  const repository = repositoryName(option(args, "--repository"));
  const checkout = resolve(option(args, "--checkout"));
  const assets = resolve(option(args, "--assets"));
  const releaseRunId = runId(option(args, "--run-id"), "release-run-id-invalid");
  const releaseRunAttempt = runId(option(args, "--run-attempt"), "release-run-attempt-invalid");
  const artifactName = option(args, "--artifact-name");
  const output = resolve(option(args, "--output"));
  if (!isAbsolute(output)) throw new Error("prepublish-output-not-absolute");
  const timeout = Number(option(args, "--timeout-ms"));
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error("prepublish-timeout-invalid");
  assertTrustedMain(checkout);
  const tagSha = tagCommit(repository, parsed.tag);
  requireCommit(checkout, tagSha);
  assertReleaseAncestor(checkout, tagSha);
  const pkg = packageAtCommit(checkout, tagSha, parsed.version);
  const releaseRun = parseReleaseRun(ghJson([`repos/${repository}/actions/runs/${releaseRunId}`]), {
    repository, tag: parsed.tag, tagSha, runId: releaseRunId, requireSuccess: true,
  });
  // The artifact's own name carries the attempt that produced these bytes. The caller's
  // attempt must be that same attempt, never the environment's current one.
  if (parseReleaseArtifactName(artifactName, parsed.tag, releaseRunId) !== releaseRunAttempt) throw new Error("release-run-attempt-mismatch");
  // Prove the `verify` job of exactly that attempt: it is the job whose upload these bytes
  // claim to be, so a manifest from another attempt can never be sealed as evidence.
  parseBuildJob(ghJson([`repos/${repository}/actions/runs/${releaseRunId}/attempts/${releaseRunAttempt}/jobs?per_page=100`]), {
    runId: releaseRunId, runAttempt: releaseRunAttempt, tagSha,
  });
  const manifest = bindReleaseArtifact(await jsonFile(join(assets, "release.json"), "release-manifest-invalid"), {
    repository, tag: parsed.tag, version: parsed.version, releaseSha: tagSha, runId: releaseRunId, artifactName,
  });
  const files = new Map<string, Uint8Array>();
  for (const asset of manifest.assets) {
    try {
      files.set(asset.name, new Uint8Array(await readFile(join(assets, asset.name))));
    } catch {
      throw new Error(`release-asset-missing:${asset.name}`);
    }
  }
  const checkRunId = await waitForCheckRun(repository, tagSha, timeout);
  const { evidence, catalogBytes } = artifactEvidence({
    repository, tag: parsed.tag, version: parsed.version, tagSha, checkRunId,
    runId: releaseRun.id, runAttempt: releaseRunAttempt, hostVersion: pkg.hostVersion, manifest, files,
  });
  const catalogPath = join(output, CATALOG_ASSET);
  await mkdir(output, { recursive: true });
  await writeFile(catalogPath, catalogBytes);
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, [
    `catalog=${catalogPath}`, `host-version=${evidence.hostVersion}`,
  ].join("\n") + "\n");
  console.log(JSON.stringify({ ok: true, evidence, hostVersion: evidence.hostVersion, catalog: catalogPath }, null, 2));
}

async function sealCommand(args: readonly string[]): Promise<void> {
  const directory = resolve(option(args, "--dir"));
  const smokePath = resolve(option(args, "--smoke-json"));
  const evidence = await jsonFile(join(directory, "evidence.json"), "prepublish-receipt-invalid");
  const catalogBytes = new Uint8Array(await readFile(join(directory, CATALOG_ASSET)));
  const smoke = await jsonFile(smokePath, "prepublish-smoke-unreadable");
  const receipt = sealPrepublishReceipt(evidence, catalogBytes, smoke);
  await writeFile(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, receipt }, null, 2));
}

async function verifyPromotionCommand(args: readonly string[]): Promise<void> {
  const parsed = parseReleaseTag(option(args, "--tag"));
  const repository = repositoryName(option(args, "--repository"));
  const checkout = resolve(option(args, "--checkout"));
  const receiptPath = resolve(option(args, "--receipt"));
  const artifactId = Number(option(args, "--artifact-id"));
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error("release-artifact-id-invalid");
  const receipt = parsePrepublishReceipt(await jsonFile(receiptPath, "prepublish-receipt-invalid"));
  if (receipt.repository !== repository || receipt.tag !== parsed.tag) throw new Error("prepublish-receipt-invalid");
  assertTrustedMain(checkout);
  const tagSha = tagCommit(repository, parsed.tag);
  requireCommit(checkout, tagSha);
  assertReleaseAncestor(checkout, tagSha);
  const pkg = packageAtCommit(checkout, tagSha, parsed.version);
  const releaseRun = parseReleaseRun(findSuccessfulReleaseRun(repository, { tag: parsed.tag, tagSha }), {
    repository, tag: parsed.tag, tagSha, requireSuccess: true,
  });
  const currentRunId = option(args, "--run-id");
  const currentAttempt = option(args, "--run-attempt");
  const current = ghJson([`repos/${repository}/actions/runs/${currentRunId}`]);
  const origin = parseMarketplaceRunOrigin(current, { repository });
  if (process.env.GITHUB_EVENT_NAME !== origin.event) throw new Error("marketplace-run-event-mismatch");
  if (origin.event === "workflow_dispatch" && process.env.GITHUB_REF !== `refs/heads/${MAIN_BRANCH}`) throw new Error("marketplace-run-ref-invalid");
  if (currentAttempt !== origin.attempt) throw new Error("marketplace-run-attempt-mismatch");
  // A rerun of only the promote job keeps the prepublish artifact and its attempt. The
  // attempt is read from the immutable artifact name, never from the rerun environment.
  const artifactName = option(args, "--artifact-name");
  const artifactAttempt = parsePrepublishArtifactName(artifactName, parsed.tag, currentRunId);
  parseArtifact(ghJson([`repos/${repository}/actions/artifacts/${artifactId}`]), {
    name: artifactName, id: artifactId, runId: currentRunId, headSha: origin.headSha,
  });
  const errors = promotionErrors(receipt, {
    repository, tag: parsed.tag, tagSha, releaseRunId: releaseRun.id, releaseRunAttempt: releaseRun.attempt, hostVersion: pkg.hostVersion,
  });
  if (errors.length > 0) throw new Error(`marketplace-promotion-rejected:${errors.join(",")}`);
  const release = readRelease(parsed.tag, repository);
  if (!release) throw new Error("marketplace-release-not-found");
  const naming = releaseNamingErrors(release, expectedAssetNames(parsed.version));
  if (naming.length > 0) throw new Error(`marketplace-promotion-rejected:${naming.join(",")}`);
  const assetErrors = releaseDigestMatches(release, [
    { name: `omp-settings-ru-${parsed.version}.tgz`, sha256: receipt.archiveSha256 },
    { name: SUMS_ASSET, sha256: receipt.sumsSha256 },
    { name: CATALOG_ASSET, sha256: receipt.catalogSha256 },
  ]);
  if (assetErrors.length > 0) throw new Error(`marketplace-promotion-rejected:${assetErrors.join(",")}`);
  console.log(JSON.stringify({ ok: true, decision: "verified", tag: parsed.tag, tagSha, releaseState: release.draft ? "draft" : "published", artifactId, artifactAttempt }, null, 2));
}

async function proveServedCommand(args: readonly string[]): Promise<void> {
  const parsed = parseReleaseTag(option(args, "--tag"));
  const repository = repositoryName(option(args, "--repository"));
  const tagSha = tagCommit(repository, parsed.tag);
  const release = ghJson([`repos/${repository}/releases/latest`]);
  const bytes = await fetchCatalog(repository, parsed.tag);
  // The public latest/download alias must serve the same bytes as the exact tag asset.
  const latest = await fetch(`https://github.com/${repository}/releases/latest/download/${CATALOG_ASSET}`, { signal: AbortSignal.timeout(120_000) });
  if (!latest.ok) throw new Error(`marketplace-latest-catalog-unavailable:${latest.status}`);
  const served = new Uint8Array(await latest.arrayBuffer());
  if (served.byteLength > 1024 * 1024) throw new Error("marketplace-catalog-too-large");
  if (sha256Bytes(served) !== sha256Bytes(bytes)) throw new Error("marketplace-latest-catalog-mismatch");
  const errors = servedProofErrors(release, served, { repository, tag: parsed.tag, tagSha });
  if (errors.length > 0) throw new Error(`marketplace-served-proof-failed:${errors.join(",")}`);
  console.log(JSON.stringify({ ok: true, identity: catalogIdentity(parseStrictJSON(new TextDecoder().decode(served)), "marketplace-served"), catalogSha256: sha256Bytes(served) }, null, 2));
}

async function manifestCommand(args: readonly string[]): Promise<void> {
  const parsed = parseReleaseTag(option(args, "--tag"));
  const repository = repositoryName(option(args, "--repository"));
  const directory = resolve(option(args, "--dir"));
  const releaseSha = sha256(option(args, "--release-sha"), "release-sha-invalid");
  const run = runId(option(args, "--run-id"), "release-run-id-invalid");
  const attempt = runId(option(args, "--run-attempt"), "release-run-attempt-invalid");
  if (option(args, "--version") !== parsed.version) throw new Error("release-package-version-mismatch");
  const assets = await Promise.all(expectedAssetNames(parsed.version).map(async name => ({
    name, sha256: sha256Bytes(new Uint8Array(await readFile(join(directory, name)))),
  })));
  const manifest: ReleaseManifest = { schemaVersion: 1, repository, tag: parsed.tag, version: parsed.version, releaseSha, runId: run, runAttempt: attempt, assets };
  await writeFile(join(directory, "release.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, manifest }, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const commands: Readonly<Record<string, (lines: readonly string[]) => Promise<void>>> = {
    manifest: manifestCommand,
    draft: draftCommand,
    "prepublish-source": prepublishSourceCommand,
    prepublish: prepublishCommand,
    seal: sealCommand,
    "verify-promotion": verifyPromotionCommand,
    "prove-served": proveServedCommand,
  };
  const handler = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!handler) throw new Error("usage: manifest|draft|prepublish-source|prepublish|seal|verify-promotion|prove-served");
  await handler(args.slice(1));
}

if (import.meta.main) await main();

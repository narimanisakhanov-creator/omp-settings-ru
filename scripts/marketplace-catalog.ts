import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface MarketplaceGithubSource {
  readonly source: "github";
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
}

export interface MarketplaceUrlSource {
  readonly source: "url";
  readonly url: string;
  readonly ref: string;
  readonly sha: string;
}

export type MarketplacePluginSource = MarketplaceGithubSource | MarketplaceUrlSource;

export interface MarketplaceCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly source: MarketplacePluginSource;
}

export interface MarketplaceCatalog {
  readonly name: string;
  readonly owner: { readonly name: string };
  readonly plugins: readonly MarketplaceCatalogEntry[];
}

export interface ReleaseAssetEvidence {
  readonly name: string;
  readonly digest: string | null;
  readonly browserDownloadUrl: string;
}

export interface ReleaseEvidence {
  readonly tag: string;
  readonly version: string;
  readonly targetCommitSha: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly published: boolean;
  readonly checksPassed: boolean;
  readonly checksHeadSha: string;
  readonly assets: readonly ReleaseAssetEvidence[];
  readonly archiveSha256: string;
  readonly sumsSha256: string;
  readonly sumsArchiveSha256: string;
}

export interface CatalogOptions {
  readonly version: string;
  readonly commitSha: string;
  readonly repository: string;
  readonly description: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const REPOSITORY = "narimanisakhanov-creator/omp-settings-ru";
/** The served marketplace catalog lives as a release asset under this exact name. */
export const CATALOG_ASSET = "marketplace.json";

export function buildMarketplaceCatalog(options: CatalogOptions): MarketplaceCatalog {
  if (!VERSION.test(options.version)) throw new Error("marketplace-version-invalid");
  if (!SHA.test(options.commitSha)) throw new Error("marketplace-commit-sha-invalid");
  if (!NAME.test(options.repository.split("/").at(-1) ?? "")) throw new Error("marketplace-repository-invalid");
  return {
    name: "omp-settings-ru",
    owner: { name: "narimanisakhanov-creator" },
    plugins: [{
      name: "omp-settings-ru",
      description: options.description,
      version: options.version,
      source: { source: "github", repo: options.repository, ref: `v${options.version}`, sha: options.commitSha },
    }],
  };
}

export function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) return undefined;
  return Reflect.get(value, key);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Evidence plus the digest of the catalog bytes that were actually downloaded and parsed. */
export interface PrepublicationEvidence extends ReleaseEvidence {
  readonly catalogSha256: string;
}

/**
 * The checks a catalog and its release evidence must satisfy in either state.
 *
 * `mode` keeps the two release states strictly apart: a published catalog must come
 * from a nondraft, non-prerelease, published release, and a prepublication catalog must
 * come from a draft release that is not published yet. Neither state is allowed to
 * accept the other one's evidence, so a draft can never be served as if it were live.
 */
function catalogErrors(catalog: unknown, evidence: ReleaseEvidence, repository: string, mode: "published" | "prepublication"): string[] {
  const errors: string[] = [];
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) return ["marketplace-catalog-object-required"];
  if (readField(catalog, "name") !== "omp-settings-ru") errors.push("marketplace-name-mismatch");
  if (readField(readField(catalog, "owner"), "name") !== "narimanisakhanov-creator") errors.push("marketplace-owner-mismatch");
  const plugins = readField(catalog, "plugins");
  if (!Array.isArray(plugins) || plugins.length !== 1) return [...errors, "marketplace-plugin-count-invalid"];
  const plugin = plugins[0];
  if (typeof plugin !== "object" || plugin === null || Array.isArray(plugin)) return [...errors, "marketplace-plugin-object-required"];
  if (readField(plugin, "name") !== "omp-settings-ru") errors.push("marketplace-plugin-name-mismatch");
  const version = readField(plugin, "version");
  if (typeof version !== "string" || !VERSION.test(version)) errors.push("marketplace-plugin-version-invalid");
  const source = readField(plugin, "source");
  if (typeof source !== "object" || source === null || Array.isArray(source)) return [...errors, "marketplace-source-github-required"];
  if (readField(source, "source") !== "github") errors.push("marketplace-source-github-required");
  if (readField(source, "repo") !== repository) errors.push("marketplace-source-repository-mismatch");
  if (typeof version === "string" && readField(source, "ref") !== `v${version}`) errors.push("marketplace-source-ref-mismatch");
  const sourceSha = readField(source, "sha");
  if (typeof sourceSha !== "string" || !SHA.test(sourceSha)) errors.push("marketplace-source-sha-required");
  if (mode === "published") {
    if (evidence.draft) errors.push("marketplace-release-draft");
    if (evidence.prerelease) errors.push("marketplace-release-prerelease");
    if (!evidence.published) errors.push("marketplace-release-unpublished");
  } else {
    if (!evidence.draft) errors.push("marketplace-release-not-draft");
    if (evidence.published) errors.push("marketplace-release-already-published");
    if (evidence.prerelease) errors.push("marketplace-release-prerelease");
  }
  if (!evidence.checksPassed || evidence.checksHeadSha !== evidence.targetCommitSha) errors.push("marketplace-release-checks-failed");
  if (evidence.tag !== `v${evidence.version}`) errors.push("marketplace-release-tag-mismatch");
  if (version !== evidence.version) errors.push("marketplace-release-version-mismatch");
  if (readField(source, "ref") !== evidence.tag) errors.push("marketplace-release-ref-mismatch");
  if (sourceSha !== evidence.targetCommitSha) errors.push("marketplace-release-sha-mismatch");
  if (!HASH.test(evidence.archiveSha256) || !HASH.test(evidence.sumsSha256) || evidence.sumsArchiveSha256 !== evidence.archiveSha256) errors.push("marketplace-release-archive-integrity-failed");
  if (evidence.assets.filter(asset => asset.name === `omp-settings-ru-${evidence.version}.tgz`).length !== 1 || evidence.assets.filter(asset => asset.name === "SHA256SUMS").length !== 1) errors.push("marketplace-release-assets-ambiguous");
  const archive = evidence.assets.find(asset => asset.name === `omp-settings-ru-${evidence.version}.tgz`);
  if (!archive || !archive.digest || !DIGEST.test(archive.digest) || archive.digest.slice(7) !== evidence.archiveSha256) errors.push("marketplace-release-archive-asset-invalid");
  const sums = evidence.assets.find(asset => asset.name === "SHA256SUMS");
  if (!sums || !sums.digest || !DIGEST.test(sums.digest) || sums.digest.slice(7) !== evidence.sumsSha256) errors.push("marketplace-release-checksums-asset-invalid");
  return errors;
}

/**
 * Verify a catalog that is already served to users. Unchanged behaviour: a draft,
 * prerelease or unpublished release is refused here.
 */
export function validateMarketplaceCatalog(catalog: unknown, evidence: ReleaseEvidence, repository = REPOSITORY): string[] {
  return catalogErrors(catalog, evidence, repository, "published");
}

/**
 * Verify a catalog that is still attached to a DRAFT release, before promotion.
 *
 * This is the pre-publication domain only: the release must still be a draft, and the
 * catalog asset must be the exact bytes that were downloaded (`catalogSha256` is
 * recomputed from those bytes by the caller, never taken from the release metadata).
 * It does not weaken `validateMarketplaceCatalog`: the published path never accepts
 * draft evidence, and this path never accepts published evidence.
 */
export function validatePrepublicationCatalog(catalog: unknown, evidence: PrepublicationEvidence, repository = REPOSITORY): string[] {
  const errors = catalogErrors(catalog, evidence, repository, "prepublication");
  if (!HASH.test(evidence.catalogSha256)) errors.push("marketplace-catalog-digest-required");
  const catalogs = evidence.assets.filter(asset => asset.name === CATALOG_ASSET);
  if (catalogs.length !== 1) return [...errors, "marketplace-catalog-asset-ambiguous"];
  const asset = catalogs[0]!;
  if (!asset.digest || !DIGEST.test(asset.digest) || asset.digest.slice(7) !== evidence.catalogSha256) errors.push("marketplace-catalog-asset-invalid");
  return errors;
}

export type IndexPublishDecision = "publish" | "identical";

export interface IndexPluginIdentity { readonly version: string; readonly sha: string }

/** The immutable identity a served catalog advertises: plugin version plus pinned commit. */
export function catalogIdentity(catalog: unknown, source: string): IndexPluginIdentity {
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) throw new Error(`${source}-index-object-required`);
  const plugins = readField(catalog, "plugins");
  if (!Array.isArray(plugins) || plugins.length !== 1) throw new Error(`${source}-index-plugin-count-invalid`);
  const plugin = plugins[0];
  const version = readField(plugin, "version");
  const sha = readField(readField(plugin, "source"), "sha");
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error(`${source}-index-version-invalid`);
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error(`${source}-index-sha-invalid`);
  return { version, sha };
}

/**
 * Decide what a marketplace publication must do against the identity the channel currently serves.
 *
 * Monotonic: a lower version is refused, so two racing releases cannot downgrade the channel.
 * Idempotent: republishing the same version at the same commit SHA is a no-op, so a retried
 * workflow cannot rewrite the served catalog. A same-version/different-SHA publish is refused
 * because an immutable release tag must always resolve to one commit.
 */
export function decideMarketplaceIndexPublish(current: IndexPluginIdentity | null, next: MarketplaceCatalog): IndexPublishDecision {
  if (current === null || current === undefined) return "publish";
  const nextPlugin = catalogIdentity(next, "marketplace-next");
  const order = Bun.semver.order(nextPlugin.version, current.version);
  if (order < 0) throw new Error("marketplace-index-downgrade");
  if (order === 0) {
    if (nextPlugin.sha !== current.sha) throw new Error("marketplace-index-conflict");
    return "identical";
  }
  return "publish";
}

/**
 * Load a catalog and prove it against the live published release before anything
 * mutates a remote. Both entry points (`--generate` and the publisher) use this, so a
 * hand-written catalog cannot bypass the release/check/asset proof.
 *
 * When a catalog file is supplied its exact bytes are hashed here and bound to the
 * `marketplace.json` asset digest of the release, so a local file cannot be accepted as
 * the served catalog unless it is byte-identical to the uploaded asset.
 */
export async function loadVerifiedCatalog(tag: string, runId: string, catalogPath?: string, repository = REPOSITORY): Promise<{catalog: MarketplaceCatalog; release: ReleaseEvidence}> {
  const release = await releaseEvidence(tag, runId, repository);
  if (catalogPath !== undefined) {
    const bytes = new Uint8Array(await Bun.file(catalogPath).arrayBuffer());
    const asset = release.assets.find(candidate => candidate.name === CATALOG_ASSET);
    if (!asset || !asset.digest || !DIGEST.test(asset.digest) || asset.digest.slice(7) !== sha256Bytes(bytes)) throw new Error("marketplace-catalog-asset-digest-mismatch");
    const catalog = JSON.parse(new TextDecoder().decode(bytes)) as MarketplaceCatalog;
    const errors = validateMarketplaceCatalog(catalog, release, repository);
    if (errors.length > 0) throw new Error(`marketplace-catalog-rejected:${errors.join(",")}`);
    return {catalog, release};
  }
  const catalog = buildMarketplaceCatalog({version: release.version, commitSha: release.targetCommitSha, repository, description: "Русский перевод панели /settings OMP"});
  const errors = validateMarketplaceCatalog(catalog, release, repository);
  if (errors.length > 0) throw new Error(`marketplace-catalog-rejected:${errors.join(",")}`);
  return {catalog, release};
}

/**
 * Pick the release row for a tag from a releases listing.
 *
 * `GET /releases/tags/{tag}` answers 404 for a DRAFT release even with push access, while the
 * releases listing does include drafts for that token. Selecting the row is kept separate from
 * the request so the draft-aware lookup is testable without network.
 */
export function selectRelease(rows: unknown, tag: string): unknown {
  if (!Array.isArray(rows)) throw new Error("marketplace-releases-unreadable");
  const found = rows.find(row => readField(row, "tag_name") === tag);
  if (found === undefined) throw new Error("marketplace-release-not-found");
  return found;
}

/** The release payload for a tag, drafts included. */
export function findRelease(tag: string, repository = REPOSITORY): unknown {
  return selectRelease(JSON.parse(runGh([`repos/${repository}/releases?per_page=100`])) as unknown, tag);
}

/**
 * Download a release asset through the authenticated API.
 *
 * A draft release has no public download path, so `browser_download_url` cannot be used
 * before promotion; the asset API with an octet-stream Accept header is the only route.
 */
export async function downloadReleaseAsset(repository: string, assetId: number): Promise<Uint8Array> {
  const result = Bun.spawnSync(["gh", "api", `repos/${repository}/releases/assets/${assetId}`, "-H", "Accept: application/octet-stream"], {stdout: "pipe", stderr: "pipe", timeout: 180_000});
  if (result.exitCode !== 0) throw new Error(`marketplace-asset-download-failed:${result.stderr.toString().trim()}`);
  return new Uint8Array(result.stdout);
}

interface RawRelease { readonly tag: string; readonly draft: boolean; readonly prerelease: boolean; readonly published: boolean; readonly assets: readonly {id: number; name: string; digest: string | null}[] }

/**
 * Read a release payload. The tag comes from the payload (`tag_name`) rather than from the
 * caller's argument, so the `/releases/latest` route reports the tag that is actually served.
 */
function readRelease(raw: unknown, repository: string): RawRelease {
  const tag = readField(raw, "tag_name");
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("marketplace-release-tag-invalid");
  const rawAssets = readField(raw, "assets");
  const assets = Array.isArray(rawAssets) ? rawAssets.flatMap(asset => {
    const id = readField(asset, "id");
    const name = readField(asset, "name");
    const digest = readField(asset, "digest");
    if (!Number.isSafeInteger(id) || typeof name !== "string") return [];
    return [{id: id as number, name, digest: typeof digest === "string" ? digest : null}];
  }) : [];
  return {tag, draft: readField(raw, "draft") === true, prerelease: readField(raw, "prerelease") === true, published: typeof readField(raw, "published_at") === "string", assets};
}

function requireCheckRun(repository: string, runId: string, targetCommitSha: string): void {
  const checks = JSON.parse(runGh([`repos/${repository}/actions/runs/${runId}`])) as unknown;
  const head = readField(checks, "head_sha");
  const passed = readField(checks, "status") === "completed" && readField(checks, "conclusion") === "success" && readField(checks, "path") === ".github/workflows/check.yml" && readField(readField(checks, "repository"), "full_name") === repository && head === targetCommitSha;
  if (!passed) throw new Error("marketplace-workflow-proof-invalid");
}

export type CheckRunOutcome = {kind: "succeeded"; id: string} | {kind: "failed"; conclusion: string} | {kind: "pending"};

/**
 * Read the exact tag-commit `check.yml` outcome from a run listing.
 *
 * A `check.yml` run that finished unsuccessfully is a refusal, never something to wait out;
 * only "no finished run yet" is pending. A run of another workflow, or one whose head does not
 * match, is not evidence about this commit at all.
 */
export function checkRunOutcome(rows: unknown, sha: string): CheckRunOutcome {
  if (!Array.isArray(rows)) return {kind: "pending"};
  const checks = rows.filter(row => readField(row, "path") === ".github/workflows/check.yml" && readField(row, "head_sha") === sha);
  const succeeded = checks.find(row => readField(row, "status") === "completed" && readField(row, "conclusion") === "success");
  if (succeeded) {
    const id = readField(succeeded, "id");
    if (!Number.isSafeInteger(id)) throw new Error("marketplace-check-run-id-invalid");
    return {kind: "succeeded", id: String(id)};
  }
  const failed = checks.find(row => readField(row, "status") === "completed");
  if (failed) return {kind: "failed", conclusion: String(readField(failed, "conclusion"))};
  return {kind: "pending"};
}

/**
 * Wait for the exact tag-commit `check.yml` run instead of querying once.
 *
 * A tag push starts its own check run, and `release.yml` finishes long before that run does;
 * a single `status=completed` query reproduces the observed v0.4.0 race. Polling keeps the
 * gate genuine: a failed or absent run still refuses, only the timing is patient.
 */
export async function waitForCheckRun(repository: string, sha: string, timeoutMs: number): Promise<string> {
  if (!SHA.test(sha)) throw new Error("marketplace-check-run-sha-invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("marketplace-check-run-timeout-invalid");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = JSON.parse(runGh([`repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`])) as unknown;
    const outcome = checkRunOutcome(readField(runs, "workflow_runs"), sha);
    if (outcome.kind === "succeeded") return outcome.id;
    if (outcome.kind === "failed") throw new Error(`marketplace-check-run-not-successful:${outcome.conclusion}`);
    if (Date.now() >= deadline) throw new Error("marketplace-check-run-timeout");
    await Bun.sleep(15_000);
  }
}

/**
 * Prove a catalog that is still attached to a draft release.
 *
 * Every byte is re-read through the authenticated asset API and re-hashed here, so the
 * receipt describes the downloaded assets rather than trusting release metadata.
 */
export async function draftCatalogEvidence(tag: string, runId: string, repository = REPOSITORY): Promise<{evidence: PrepublicationEvidence; catalogBytes: Uint8Array}> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^\d+$/.test(runId)) throw new Error("marketplace-release-reference-invalid");
  const release = readRelease(findRelease(tag, repository), repository);
  if (release.tag !== tag) throw new Error("marketplace-release-tag-mismatch");
  const version = tag.slice(1);
  const targetCommitSha = tagCommit(repository, tag);
  requireCheckRun(repository, runId, targetCommitSha);
  const archive = release.assets.find(asset => asset.name === `omp-settings-ru-${version}.tgz`);
  const sums = release.assets.find(asset => asset.name === "SHA256SUMS");
  const catalogAsset = release.assets.find(asset => asset.name === CATALOG_ASSET);
  if (!archive || !sums || !catalogAsset) throw new Error("marketplace-release-assets-missing");
  const [archiveBytes, sumsBytes, catalogBytes] = await Promise.all([
    downloadReleaseAsset(repository, archive.id),
    downloadReleaseAsset(repository, sums.id),
    downloadReleaseAsset(repository, catalogAsset.id),
  ]);
  const archiveSha256 = sha256Bytes(archiveBytes);
  const sumsSha256 = sha256Bytes(sumsBytes);
  const checksum = new TextDecoder().decode(sumsBytes).split(/\r?\n/).map(line => line.trim().split(/\s+/, 2)).find(parts => parts[1] === archive.name)?.[0] ?? "";
  return {
    catalogBytes,
    evidence: {
      tag,
      version,
      targetCommitSha,
      draft: release.draft,
      prerelease: release.prerelease,
      published: release.published,
      checksPassed: true,
      checksHeadSha: targetCommitSha,
      assets: release.assets.map(asset => ({name: asset.name, digest: asset.digest, browserDownloadUrl: `https://github.com/${repository}/releases/download/${tag}/${asset.name}`})),
      archiveSha256,
      sumsSha256,
      sumsArchiveSha256: checksum,
      catalogSha256: sha256Bytes(catalogBytes),
    },
  };
}

/**
 * The identity the channel currently serves, read from the latest published release.
 *
 * A release without a catalog asset is the legacy branch-published channel: its identity is
 * still well defined by the release tag and that tag's commit, so the monotonic comparison
 * stays honest instead of silently accepting an unknown channel. A catalog asset that exists
 * but cannot be parsed is a malformed channel and refuses here rather than being ignored.
 */
export async function servedChannelIdentity(repository = REPOSITORY): Promise<IndexPluginIdentity | null> {
  const listed = Bun.spawnSync(["gh", "api", `repos/${repository}/releases/latest`], {stdout: "pipe", stderr: "pipe", timeout: 30_000});
  if (listed.exitCode !== 0) {
    if (/HTTP 404/.test(listed.stderr.toString())) return null;
    throw new Error(`marketplace-served-release-unavailable:${listed.stderr.toString().trim()}`);
  }
  const release = readRelease(JSON.parse(listed.stdout.toString()) as unknown, repository);
  const catalogAsset = release.assets.find(asset => asset.name === CATALOG_ASSET);
  if (!catalogAsset) return {version: release.tag.slice(1), sha: tagCommit(repository, release.tag)};
  const bytes = await downloadReleaseAsset(repository, catalogAsset.id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("marketplace-served-catalog-malformed");
  }
  return catalogIdentity(parsed, "marketplace-served");
}

function usage(): never {
  throw new Error("usage: --build --version V --commit SHA --output FILE | --validate --catalog FILE --tag vVERSION --check-run RUN_ID | --generate --tag vVERSION --check-run RUN_ID --output FILE | --wait-check-run --tag vVERSION --timeout-ms N | --prepublication --tag vVERSION --check-run RUN_ID [--catalog FILE] | --served");
}

function arg(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) usage();
  return value;
}

export function runGh(args: string[]): string {
  const result = Bun.spawnSync(["gh", "api", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  if (result.exitCode !== 0) throw new Error(`marketplace-github-api-failed:${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

export function tagCommit(repository: string, tag: string): string {
  const ref = JSON.parse(runGh([`repos/${repository}/git/ref/tags/${tag}`])) as unknown;
  const object = readField(ref, "object");
  const sha = readField(object, "sha");
  const type = readField(object, "type");
  if (type === "commit" && typeof sha === "string" && SHA.test(sha)) return sha;
  if (type !== "tag" || typeof sha !== "string" || !SHA.test(sha)) throw new Error("marketplace-tag-target-invalid");
  const tagObject = JSON.parse(runGh([`repos/${repository}/git/tags/${sha}`])) as unknown;
  const target = readField(tagObject, "object");
  const targetSha = readField(target, "sha");
  if (readField(target, "type") !== "commit" || typeof targetSha !== "string" || !SHA.test(targetSha)) throw new Error("marketplace-annotated-tag-target-invalid");
  return targetSha;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`marketplace-release-asset-download-failed:${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function releaseEvidence(tag: string, runId: string, repository: string): Promise<ReleaseEvidence> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^\d+$/.test(runId)) throw new Error("marketplace-release-reference-invalid");
  const raw = JSON.parse(runGh([`repos/${repository}/releases/tags/${tag}`])) as unknown;
  const checks = JSON.parse(runGh([`repos/${repository}/actions/runs/${runId}`])) as unknown;
  if (readField(raw, "tag_name") !== tag || readField(raw, "draft") !== false || readField(raw, "prerelease") !== false || typeof readField(raw, "published_at") !== "string") throw new Error("marketplace-release-not-published");
  const rawAssets = readField(raw, "assets");
  const assets = Array.isArray(rawAssets) ? rawAssets.flatMap(asset => {
    const name = readField(asset, "name");
    const digest = readField(asset, "digest");
    const url = readField(asset, "browser_download_url");
    if (typeof name !== "string" || typeof url !== "string") return [];
    return [{ name, digest: typeof digest === "string" ? digest : null, browserDownloadUrl: url }];
  }) : [];
  const targetCommitSha = tagCommit(repository, tag);
  const checksHeadSha = readField(checks, "head_sha");
  const checksRepository = readField(checks, "repository");
  const checksPassed = readField(checks, "status") === "completed" && readField(checks, "conclusion") === "success" && readField(checks, "path") === ".github/workflows/check.yml" && readField(checksRepository, "full_name") === repository && checksHeadSha === targetCommitSha;
  if (!checksPassed) throw new Error("marketplace-workflow-proof-invalid");
  const archive = assets.find(asset => asset.name === `omp-settings-ru-${tag.slice(1)}.tgz`);
  const sums = assets.find(asset => asset.name === "SHA256SUMS");
  if (!archive || !sums) throw new Error("marketplace-release-assets-missing");
  for (const asset of [archive, sums]) if (asset.browserDownloadUrl !== `https://github.com/${repository}/releases/download/${tag}/${asset.name}`) throw new Error("marketplace-release-asset-url-invalid");
  const archiveBytes = await download(archive.browserDownloadUrl);
  const sumsBytes = await download(sums.browserDownloadUrl);
  const archiveSha256 = sha256Bytes(archiveBytes);
  const sumsSha256 = sha256Bytes(sumsBytes);
  const checksum = new TextDecoder().decode(sumsBytes).split(/\r?\n/).map(line => line.trim().split(/\s+/, 2)).find(parts => parts[1] === archive.name)?.[0] ?? "";
  return {
    tag,
    version: tag.slice(1),
    targetCommitSha,
    draft: readField(raw, "draft") === true,
    prerelease: readField(raw, "prerelease") === true,
    published: typeof readField(raw, "published_at") === "string",
    checksPassed,
    checksHeadSha: typeof checksHeadSha === "string" ? checksHeadSha : "",
    assets,
    archiveSha256,
    sumsSha256,
    sumsArchiveSha256: checksum,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--build")) {
    const catalog = buildMarketplaceCatalog({version: arg(args, "--version"), commitSha: arg(args, "--commit"), repository: REPOSITORY, description: "Русский перевод панели /settings OMP"});
    await writeFile(resolve(arg(args, "--output")), JSON.stringify(catalog, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ok: true, catalog}, null, 2));
    return;
  }
  if (args.includes("--served")) {
    console.log(JSON.stringify({ok: true, identity: await servedChannelIdentity()}, null, 2));
    return;
  }
  if (args.includes("--wait-check-run")) {
    const tag = arg(args, "--tag");
    const repository = REPOSITORY;
    const runId = await waitForCheckRun(repository, tagCommit(repository, tag), Number(arg(args, "--timeout-ms")));
    console.log(JSON.stringify({ok: true, checkRun: runId}, null, 2));
    return;
  }
  if (args.includes("--prepublication")) {
    const {evidence, catalogBytes} = await draftCatalogEvidence(arg(args, "--tag"), arg(args, "--check-run"));
    const catalogPath = args.includes("--catalog") ? arg(args, "--catalog") : undefined;
    const catalog = catalogPath === undefined ? JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown : await Bun.file(catalogPath).json() as unknown;
    const errors = validatePrepublicationCatalog(catalog, evidence);
    console.log(JSON.stringify({ok: errors.length === 0, errors, catalog, release: evidence}, null, 2));
    if (errors.length > 0) process.exit(1);
    return;
  }
  if (!args.includes("--generate") && !args.includes("--validate")) usage();
  const generate = args.includes("--generate");
  const { catalog, release } = await loadVerifiedCatalog(arg(args, "--tag"), arg(args, "--check-run"), generate ? undefined : arg(args, "--catalog"));
  console.log(JSON.stringify({ ok: true, errors: [], catalog, release }, null, 2));
  if (generate) await writeFile(resolve(arg(args, "--output")), JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

if (import.meta.main) await main();

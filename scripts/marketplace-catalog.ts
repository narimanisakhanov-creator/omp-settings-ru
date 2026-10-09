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

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) return undefined;
  return Reflect.get(value, key);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateMarketplaceCatalog(catalog: unknown, evidence: ReleaseEvidence, repository = REPOSITORY): string[] {
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
  if (evidence.draft) errors.push("marketplace-release-draft");
  if (evidence.prerelease) errors.push("marketplace-release-prerelease");
  if (!evidence.published) errors.push("marketplace-release-unpublished");
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

export type IndexPublishDecision = "publish" | "identical";

interface IndexPluginIdentity { readonly version: string; readonly sha: string }

function indexPluginIdentity(catalog: unknown, source: string): IndexPluginIdentity {
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
 * Decide what a marketplace-index publication must do against the currently served catalog.
 *
 * Monotonic: a lower version is refused, so two racing releases cannot downgrade the channel.
 * Idempotent: republishing the same version at the same commit SHA is a no-op, so a retried
 * workflow cannot rewrite the index. A same-version/different-SHA publish is refused because an
 * immutable release tag must always resolve to one commit.
 */
export function decideMarketplaceIndexPublish(current: unknown, next: MarketplaceCatalog): IndexPublishDecision {
  if (current === null || current === undefined) return "publish";
  const currentPlugin = indexPluginIdentity(current, "marketplace-current");
  const nextPlugin = indexPluginIdentity(next, "marketplace-next");
  const order = Bun.semver.order(nextPlugin.version, currentPlugin.version);
  if (order < 0) throw new Error("marketplace-index-downgrade");
  if (order === 0) {
    if (nextPlugin.sha !== currentPlugin.sha) throw new Error("marketplace-index-conflict");
    return "identical";
  }
  return "publish";
}

/**
 * Load a catalog and prove it against the live published release before anything
 * mutates a remote. Both entry points (`--generate` and the index publisher) use
 * this, so a hand-written catalog cannot bypass the release/check/asset proof.
 */
export async function loadVerifiedCatalog(tag: string, runId: string, catalogPath?: string, repository = REPOSITORY): Promise<{catalog: MarketplaceCatalog; release: ReleaseEvidence}> {
  const release = await releaseEvidence(tag, runId, repository);
  const catalog = catalogPath === undefined
    ? buildMarketplaceCatalog({version: release.version, commitSha: release.targetCommitSha, repository, description: "Русский перевод панели /settings OMP"})
    : await Bun.file(catalogPath).json() as MarketplaceCatalog;
  const errors = validateMarketplaceCatalog(catalog, release, repository);
  if (errors.length > 0) throw new Error(`marketplace-catalog-rejected:${errors.join(",")}`);
  return {catalog, release};
}

function usage(): never {
  throw new Error("usage: --generate --tag vVERSION --check-run RUN_ID --output FILE | --validate --catalog FILE --tag vVERSION --check-run RUN_ID | --decide --catalog FILE [--current FILE]");
}

function arg(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) usage();
  return value;
}

function runGh(args: string[]): string {
  const result = Bun.spawnSync(["gh", "api", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  if (result.exitCode !== 0) throw new Error(`marketplace-github-api-failed:${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

function tagCommit(repository: string, tag: string): string {
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
  const archiveSha256 = sha256(archiveBytes);
  const sumsSha256 = sha256(sumsBytes);
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
  if (args.includes("--decide")) {
    const next = await Bun.file(arg(args, "--catalog")).json();
    const currentIndex = args.indexOf("--current");
    const current = currentIndex >= 0 ? await Bun.file(args[currentIndex + 1]!).json() : null;
    const decision = decideMarketplaceIndexPublish(current, next);
    console.log(JSON.stringify({ decision, catalog: next }));
    return;
  }
  if (!args.includes("--generate") && !args.includes("--validate")) usage();
  const generate = args.includes("--generate");
  const { catalog, release } = await loadVerifiedCatalog(arg(args, "--tag"), arg(args, "--check-run"), generate ? undefined : arg(args, "--catalog"));
  console.log(JSON.stringify({ ok: true, errors: [], catalog, release }, null, 2));
  if (generate) await writeFile(resolve(arg(args, "--output")), JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

if (import.meta.main) await main();

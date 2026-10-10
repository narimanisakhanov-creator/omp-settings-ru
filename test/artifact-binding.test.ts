import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalContentHash, executableIdentity, extractPackageArchive, validateArtifactReceipt, verifyArtifactBinding } from "../scripts/installed-smoke";
import { buildMarketplaceCatalog, catalogIdentity, checkRunOutcome, decideMarketplaceIndexPublish, validateMarketplaceCatalog, validatePrepublicationCatalog, type MarketplaceCatalog, type PrepublicationEvidence, type ReleaseAssetEvidence, type ReleaseEvidence } from "../scripts/marketplace-catalog";
import type { ArtifactReceiptExpectation } from "../scripts/installed-smoke";

interface ArtifactFixture {directory: string; archivePath: string; headSha: string; treeHash: string; archiveSha256: string}

async function fixture(): Promise<ArtifactFixture> {
  const directory = await mkdtemp(join(tmpdir(), "omp-artifact-domain-"));
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "package.json"), JSON.stringify({name: "proof-plugin", version: "1.0.0", files: ["src"]}));
  await writeFile(join(directory, "src/index.ts"), "export const value = 1;\n");
  for (const args of [["init"], ["add", "."], ["-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-m", "fixture"]]) {
    if (Bun.spawnSync(["git", ...args], {cwd: directory, stdout: "pipe", stderr: "pipe"}).exitCode !== 0) throw new Error("fixture-git-failed");
  }
  const headSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {cwd: directory}).stdout.toString().trim();
  const treeHash = Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], {cwd: directory}).stdout.toString().trim();
  const archivePath = join(directory, "proof.tgz");
  await Bun.Archive.write(archivePath, {"package/package.json": await readFile(join(directory, "package.json")), "package/src/index.ts": await readFile(join(directory, "src/index.ts"))}, {compress: "gzip"});
  const archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  return {directory, archivePath, headSha, treeHash, archiveSha256};
}

type TarEntry = {name: string; type?: string; linkname?: string; data?: string};

/** Minimal ustar writer so adversarial archives (duplicates, dot segments, links) can be produced verbatim. */
function tarBytes(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = new TextEncoder().encode(entry.data ?? "");
    const header = new Uint8Array(512);
    const field = (text: string, offset: number) => header.set(new TextEncoder().encode(text), offset);
    field(entry.name.slice(0, 100), 0);
    field("0000644\0", 100);
    field("0000000\0", 108);
    field("0000000\0", 116);
    field((entry.type === "2" ? 0 : data.length).toString(8).padStart(11, "0") + "\0", 124);
    field("00000000000\0", 136);
    field("        ", 148);
    field(entry.type ?? "0", 156);
    if (entry.linkname) field(entry.linkname, 157);
    field("ustar\0", 257);
    field("00", 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    field(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const merged = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {merged.set(block, offset);offset += block.length;}
  return merged;
}

async function craftedArchive(entries: readonly TarEntry[]): Promise<{directory: string; archivePath: string; archiveSha256: string}> {
  const directory = await mkdtemp(join(tmpdir(), "omp-artifact-crafted-"));
  const archivePath = join(directory, "crafted.tgz");
  await writeFile(archivePath, gzipSync(tarBytes(entries)));
  const archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  return {directory, archivePath, archiveSha256};
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {await run();return "accepted";} catch (error) {return error instanceof Error ? error.message : String(error);}
}

test("accepts differing archive and canonical content hashes proven against one committed tree", async () => {
  const f = await fixture();
  try {
    const binding = await verifyArtifactBinding({sourceDirectory: f.directory, archivePath: f.archivePath, headSha: f.headSha, treeHash: f.treeHash, archiveSha256: f.archiveSha256});
    expect(binding.schemaVersion).toBe(1);
    expect(binding.extractionVerified).toBe(true);
    expect(binding.archiveSha256).toBe(f.archiveSha256);
    expect(binding.contentHash).not.toBe(f.archiveSha256);
    expect(binding.contentHash).toBe(await canonicalContentHash(f.directory));
    expect(binding.headSha).toBe(f.headSha);
    expect(binding.treeHash).toBe(f.treeHash);
    expect(binding.fileCount).toBe(2);
  } finally {await rm(f.directory, {recursive: true, force: true});}
});

for (const attack of ["archive", "content", "head", "tree"] as const) test(`refuses mismatched ${attack} binding`, async () => {
  const f = await fixture();
  try {
    let archivePath = f.archivePath;
    if (attack === "archive") f.archiveSha256 = "0".repeat(64);
    if (attack === "head") f.headSha = "0".repeat(40);
    if (attack === "tree") f.treeHash = "0".repeat(40);
    if (attack === "content") {
      await Bun.Archive.write(f.archivePath, {"package/package.json": await readFile(join(f.directory, "package.json")), "package/src/index.ts": "export const value = 2;\n"}, {compress: "gzip"});
      f.archiveSha256 = createHash("sha256").update(await readFile(f.archivePath)).digest("hex");
    }
    const reason = await refusal(() => verifyArtifactBinding({sourceDirectory: f.directory, archivePath, headSha: f.headSha, treeHash: f.treeHash, archiveSha256: f.archiveSha256}));
    expect(reason).toBe(({archive: "archive-sha256-mismatch", content: "archive-source-content-mismatch", head: "source-head-mismatch", tree: "source-tree-mismatch"})[attack]);
  } finally {await rm(f.directory, {recursive: true, force: true});}
});

test("extraction refuses a pre-existing target and a linked target instead of writing through it", async () => {
  const f = await fixture();
  const target = await mkdtemp(join(tmpdir(), "omp-artifact-extract-"));
  const external = await mkdtemp(join(tmpdir(), "omp-artifact-external-"));
  try {
    await writeFile(join(external, "sentinel.txt"), "external\n");
    // An existing target is refused rather than reused.
    expect(await refusal(() => extractPackageArchive({archivePath: f.archivePath, targetDirectory: target}))).toBe("extraction-target-conflict");
    // A junction pointing at another directory is refused, and nothing is written through it.
    const link = join(target, "linked");
    await symlink(external, link, "junction");
    expect(await refusal(() => extractPackageArchive({archivePath: f.archivePath, targetDirectory: link}))).toBe("extraction-target-conflict");
    expect(await readdir(external)).toEqual(["sentinel.txt"]);
  } finally {await rm(f.directory, {recursive: true, force: true});await rm(target, {recursive: true, force: true});await rm(external, {recursive: true, force: true});}
});

test("extraction validates the package allowlist before writing any file", async () => {
  const packageJson = JSON.stringify({name: "proof-plugin", version: "1.0.0"});
  const crafted = await craftedArchive([
    {name: "package/package.json", data: packageJson},
    {name: "package/src/index.ts", data: "export const value = 1;\n"},
  ]);
  const target = await mkdtemp(join(tmpdir(), "omp-artifact-extract-"));
  try {
    expect(await refusal(() => extractPackageArchive({archivePath: crafted.archivePath, targetDirectory: join(target, "package")}))).toBe("package-allowlist-invalid");
    expect(await readdir(target)).toEqual([]);
  } finally {await rm(crafted.directory, {recursive: true, force: true});await rm(target, {recursive: true, force: true});}
});

test("refuses duplicate file entries whose extraction would be ambiguous", async () => {
  const f = await fixture();
  const crafted = await craftedArchive([
    {name: "package/package.json", data: await readFile(join(f.directory, "package.json"), "utf8")},
    {name: "package/src/index.ts", data: "export const value = 1;\n"},
    {name: "package/src/index.ts", data: "export const value = 9;\n"},
  ]);
  try {
    const reason = await refusal(() => verifyArtifactBinding({sourceDirectory: f.directory, archivePath: crafted.archivePath, headSha: f.headSha, treeHash: f.treeHash}));
    expect(reason).toBe("artifact-archive-duplicate-entry");
  } finally {await rm(f.directory, {recursive: true, force: true});await rm(crafted.directory, {recursive: true, force: true});}
});

test("refuses raw archive names with dot segments or links before any extraction", async () => {
  const f = await fixture();
  const packageJson = await readFile(join(f.directory, "package.json"), "utf8");
  const dotSegment = await craftedArchive([{name: "package/package.json", data: packageJson}, {name: "package/./src/index.ts", data: "export const value = 1;\n"}]);
  const parentSegment = await craftedArchive([{name: "package/package.json", data: packageJson}, {name: "package/a/../b.ts", data: "export const value = 1;\n"}]);
  const symlink = await craftedArchive([{name: "package/package.json", data: packageJson}, {name: "package/src/index.ts", data: "export const value = 1;\n"}, {name: "package/src/link.ts", type: "2", linkname: "../../package.json"}]);
  try {
    expect(await refusal(() => verifyArtifactBinding({sourceDirectory: f.directory, archivePath: dotSegment.archivePath, headSha: f.headSha, treeHash: f.treeHash}))).toBe("artifact-archive-unsafe");
    expect(await refusal(() => verifyArtifactBinding({sourceDirectory: f.directory, archivePath: parentSegment.archivePath, headSha: f.headSha, treeHash: f.treeHash}))).toBe("artifact-archive-unsafe");
    expect(await refusal(() => verifyArtifactBinding({sourceDirectory: f.directory, archivePath: symlink.archivePath, headSha: f.headSha, treeHash: f.treeHash}))).toBe("artifact-archive-unsafe");
  } finally {await rm(f.directory, {recursive: true, force: true});for (const crafted of [dotSegment, parentSegment, symlink]) await rm(crafted.directory, {recursive: true, force: true});}
});

test("extraction proves on-disk bytes equal the verified archive identity", async () => {
  const f = await fixture();
  const target = await mkdtemp(join(tmpdir(), "omp-artifact-extract-"));
  try {
    const binding = await verifyArtifactBinding({sourceDirectory: f.directory, archivePath: f.archivePath, headSha: f.headSha, treeHash: f.treeHash, archiveSha256: f.archiveSha256});
    const extracted = await extractPackageArchive({archivePath: f.archivePath, targetDirectory: join(target, "package"), archiveSha256: f.archiveSha256, contentHash: binding.contentHash});
    expect(extracted.archiveSha256).toBe(f.archiveSha256);
    expect(extracted.contentHash).toBe(binding.contentHash);
    expect(extracted.fileCount).toBe(binding.fileCount);
    expect(extracted.extractionVerified).toBe(true);
    expect(await canonicalContentHash(extracted.directory)).toBe(binding.contentHash);
    expect(await readFile(join(extracted.directory, "src/index.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {await rm(f.directory, {recursive: true, force: true});await rm(target, {recursive: true, force: true});}
});

test("extraction refuses a mismatched expected identity", async () => {
  const f = await fixture();
  const target = await mkdtemp(join(tmpdir(), "omp-artifact-extract-"));
  try {
    const reason = await refusal(() => extractPackageArchive({archivePath: f.archivePath, targetDirectory: join(target, "package"), contentHash: "0".repeat(64)}));
    expect(reason).toBe("extraction-content-mismatch");
  } finally {await rm(f.directory, {recursive: true, force: true});await rm(target, {recursive: true, force: true});}
});

test("extraction refuses unsafe archives without writing any file", async () => {
  const f = await fixture();
  const crafted = await craftedArchive([{name: "package/package.json", data: await readFile(join(f.directory, "package.json"), "utf8")}, {name: "package/src/index.ts", data: "export const value = 1;\n"}, {name: "package/src/index.ts", data: "export const value = 9;\n"}]);
  const target = await mkdtemp(join(tmpdir(), "omp-artifact-extract-"));
  try {
    const reason = await refusal(() => extractPackageArchive({archivePath: crafted.archivePath, targetDirectory: join(target, "package")}));
    expect(reason).toBe("artifact-archive-duplicate-entry");
    expect(await readdir(target)).toEqual([]);
  } finally {await rm(f.directory, {recursive: true, force: true});await rm(crafted.directory, {recursive: true, force: true});await rm(target, {recursive: true, force: true});}
});

test("executable identity hashes the actual executable bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-artifact-executable-"));
  try {
    const binary = join(directory, "omp");
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254]);
    await writeFile(binary, bytes);
    expect(await executableIdentity(binary)).toBe(createHash("sha256").update(bytes).digest("hex"));
  } finally {await rm(directory, {recursive: true, force: true});}
});

interface CiReceiptFixture {
  schemaVersion: number;
  version: string;
  platform: string;
  native: boolean;
  passed: boolean;
  checkRunId: number;
  workflowRunId: string;
  runAttempt: string;
  checkName: string;
  executable: {name: string; assetId: number; sha256: string; releaseTag: string};
  binding: {schemaVersion: number; headSha: string; treeHash: string; archiveSha256: string; contentHash: string; fileCount: number; extractionVerified: boolean};
  smoke: {
    hostVersion: string;
    platform: string;
    contentHash: string;
    executableSha256: string;
    passed: boolean;
    installedPanel: boolean;
    observations: {kind: string; output: string}[];
    isolation: {ambientCredentialInherited: boolean; homeIsolated: boolean; providerRoundTrip: boolean};
  };
}

function validReceipt(): CiReceiptFixture {
  const sha40 = "a".repeat(40);
  const sha64 = "b".repeat(64);
  return {
    schemaVersion: 1,
    version: "18.8.4",
    platform: "win32",
    native: true,
    passed: true,
    checkRunId: 42,
    workflowRunId: "123456",
    runAttempt: "1",
    checkName: "check (windows-2022, 18.8.4)",
    executable: {name: "omp-windows-x64.exe", assetId: 7, sha256: sha64, releaseTag: "v18.8.4"},
    binding: {schemaVersion: 1, headSha: sha40, treeHash: sha40, archiveSha256: sha64, contentHash: "c".repeat(64), fileCount: 25, extractionVerified: true},
    smoke: {
      hostVersion: "18.8.4",
      platform: "win32",
      contentHash: "c".repeat(64),
      executableSha256: sha64,
      passed: true,
      installedPanel: true,
      observations: [{kind: "ru-panel", output: "observed"}],
      isolation: {ambientCredentialInherited: false, homeIsolated: true, providerRoundTrip: false},
    },
  };
}
const expectation: ArtifactReceiptExpectation = {version: "18.8.4", platform: "win32", headSha: "a".repeat(40), treeHash: "a".repeat(40), archiveSha256: "b".repeat(64), contentHash: "c".repeat(64), executableSha256: "b".repeat(64), checkRunId: 42, workflowRunId: "123456"};

test("validates a receipt whose binding carries the expected exact source and artifact identity", () => {
  expect(validateArtifactReceipt(validReceipt(), expectation)).toEqual({ok: true});
});

test("refuses a receipt whose source, archive or content binding was tampered with or missing", () => {
  const cases: readonly [string, (receipt: CiReceiptFixture) => void][] = [
    ["receipt-headSha-mismatch", receipt => {receipt.binding.headSha = "d".repeat(40);}],
    ["receipt-treeHash-mismatch", receipt => {receipt.binding.treeHash = "d".repeat(40);}],
    ["receipt-archiveSha256-mismatch", receipt => {receipt.binding.archiveSha256 = "d".repeat(64);}],
    ["receipt-contentHash-mismatch", receipt => {receipt.binding.contentHash = "d".repeat(64);}],
    ["receipt-missing-headSha", receipt => {delete (receipt.binding as Partial<CiReceiptFixture["binding"]>).headSha;}],
    ["receipt-missing-contentHash", receipt => {delete (receipt.binding as Partial<CiReceiptFixture["binding"]>).contentHash;}],
    ["receipt-version-mismatch", receipt => {receipt.version = "18.8.0";}],
    ["receipt-missing-version", receipt => {delete (receipt as Partial<CiReceiptFixture>).version;}],
    ["receipt-platform-mismatch", receipt => {receipt.platform = "linux";}],
  ];
  for (const [reason, tamper] of cases) {
    const receipt = validReceipt();
    tamper(receipt);
    expect(validateArtifactReceipt(receipt, expectation)).toEqual({ok: false, reason});
  }
});

test("refuses receipts with unverified extraction, weak run identity or unmatched smoke evidence", () => {
  const cases: readonly [string, (receipt: CiReceiptFixture) => void][] = [
    ["receipt-extraction-unverified", receipt => {receipt.binding.extractionVerified = false;}],
    ["receipt-fileCount-invalid", receipt => {receipt.binding.fileCount = 0;}],
    ["receipt-check-run-missing", receipt => {delete (receipt as Partial<CiReceiptFixture>).checkRunId;}],
    ["receipt-workflow-missing", receipt => {delete (receipt as Partial<CiReceiptFixture>).workflowRunId;}],
    ["receipt-not-native", receipt => {receipt.native = false;}],
    ["receipt-smoke-failed", receipt => {receipt.passed = false;}],
    ["receipt-executable-unverified", receipt => {receipt.executable.sha256 = "short";}],
    ["receipt-executable-mismatch", receipt => {receipt.executable.sha256 = "d".repeat(64);receipt.smoke.executableSha256 = "d".repeat(64);}],
    ["receipt-executable-mismatch", receipt => {receipt.smoke.executableSha256 = "d".repeat(64);}],
    ["receipt-smoke-content-mismatch", receipt => {receipt.smoke.contentHash = "d".repeat(64);}],
    ["receipt-smoke-missing", receipt => {delete (receipt as Partial<CiReceiptFixture>).smoke;}],
    ["receipt-binding-missing", receipt => {delete (receipt as Partial<CiReceiptFixture>).binding;}],
    ["receipt-schema", receipt => {receipt.schemaVersion = 2;}],
  ];
  for (const [reason, tamper] of cases) {
    const receipt = validReceipt();
    tamper(receipt);
    expect(validateArtifactReceipt(receipt, expectation)).toEqual({ok: false, reason});
  }
  expect(validateArtifactReceipt(null, expectation)).toEqual({ok: false, reason: "receipt-invalid"});
});

test("refuses a wrapper that claims success over a failed, non-panel or foreign inner smoke", () => {
  const cases: readonly [string, (receipt: CiReceiptFixture) => void][] = [
    ["receipt-smoke-failed", receipt => {receipt.smoke.passed = false;}],
    ["receipt-smoke-not-panel", receipt => {receipt.smoke.installedPanel = false;}],
    ["receipt-smoke-host-version-mismatch", receipt => {receipt.smoke.hostVersion = "18.8.0";}],
    ["receipt-smoke-platform-mismatch", receipt => {receipt.smoke.platform = "linux";}],
    ["receipt-smoke-isolation-invalid", receipt => {receipt.smoke.isolation.ambientCredentialInherited = true;}],
    ["receipt-smoke-isolation-invalid", receipt => {receipt.smoke.isolation.homeIsolated = false;}],
    ["receipt-smoke-isolation-invalid", receipt => {receipt.smoke.isolation.providerRoundTrip = true;}],
    ["receipt-smoke-unobserved", receipt => {receipt.smoke.observations = [];}],
  ];
  for (const [reason, tamper] of cases) {
    const receipt = validReceipt();
    tamper(receipt);
    expect(validateArtifactReceipt(receipt, expectation)).toEqual({ok: false, reason});
  }
});

test("refuses receipts whose run or check identity does not match the trusted GitHub source", () => {
  expect(validateArtifactReceipt(validReceipt(), {...expectation, checkRunId: 43})).toEqual({ok: false, reason: "receipt-check-run-mismatch"});
  expect(validateArtifactReceipt(validReceipt(), {...expectation, workflowRunId: "999"})).toEqual({ok: false, reason: "receipt-workflow-mismatch"});
  expect(validateArtifactReceipt(validReceipt(), {...expectation, runAttempt: "2"})).toEqual({ok: false, reason: "receipt-workflow-mismatch"});
  expect(validateArtifactReceipt(validReceipt(), {...expectation, workflowRunId: "123456", runAttempt: "1"})).toEqual({ok: true});
});

test("marketplace release gate rejects each unproven release dimension with its exact reason", () => {
  const sha = "a".repeat(40);
  const hash = "b".repeat(64);
  const catalog = buildMarketplaceCatalog({version: "0.3.1", commitSha: sha, repository: "narimanisakhanov-creator/omp-settings-ru", description: "Русский перевод /settings"});
  const asset = (name: string): ReleaseAssetEvidence => ({name, digest: `sha256:${hash}`, browserDownloadUrl: `https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/download/v0.3.1/${name}`});
  const assetsFor = (version: string): ReleaseAssetEvidence[] => [{...asset(`omp-settings-ru-${version}.tgz`), browserDownloadUrl: `https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/download/v0.3.1/omp-settings-ru-${version}.tgz`}, asset("SHA256SUMS")];
  const evidence: ReleaseEvidence = {
    tag: "v0.3.1", version: "0.3.1", targetCommitSha: sha, draft: false, prerelease: false, published: true,
    checksPassed: true, checksHeadSha: sha, archiveSha256: hash, sumsSha256: hash, sumsArchiveSha256: hash,
    assets: assetsFor("0.3.1"),
  };
  expect(validateMarketplaceCatalog(catalog, evidence)).toEqual([]);
  const cases: readonly [readonly string[], (value: ReleaseEvidence) => ReleaseEvidence][] = [
    [["marketplace-release-draft"], value => ({...value, draft: true})],
    [["marketplace-release-prerelease"], value => ({...value, prerelease: true})],
    [["marketplace-release-unpublished"], value => ({...value, published: false})],
    [["marketplace-release-checks-failed"], value => ({...value, checksHeadSha: "c".repeat(40)})],
    [["marketplace-release-checks-failed"], value => ({...value, checksPassed: false})],
    [["marketplace-release-tag-mismatch", "marketplace-release-ref-mismatch"], value => ({...value, tag: "v0.3.0"})],
    [["marketplace-release-tag-mismatch", "marketplace-release-version-mismatch"], value => ({...value, version: "0.3.2", assets: assetsFor("0.3.2")})],
    [["marketplace-release-sha-mismatch"], value => ({...value, targetCommitSha: "e".repeat(40), checksHeadSha: "e".repeat(40)})],
    [["marketplace-release-archive-integrity-failed"], value => ({...value, sumsArchiveSha256: "d".repeat(64)})],
    [["marketplace-release-archive-integrity-failed", "marketplace-release-archive-asset-invalid"], value => ({...value, archiveSha256: "not-a-hash"})],
    [["marketplace-release-assets-ambiguous"], value => ({...value, assets: [...value.assets, asset("omp-settings-ru-0.3.1.tgz")]})],
    [["marketplace-release-assets-ambiguous", "marketplace-release-checksums-asset-invalid"], value => ({...value, assets: [asset("omp-settings-ru-0.3.1.tgz")]})],
    [["marketplace-release-archive-asset-invalid"], value => ({...value, assets: [{...asset("omp-settings-ru-0.3.1.tgz"), digest: `sha256:${"d".repeat(64)}`}, asset("SHA256SUMS")]})],
    [["marketplace-release-checksums-asset-invalid"], value => ({...value, assets: [asset("omp-settings-ru-0.3.1.tgz"), {...asset("SHA256SUMS"), digest: null}]})],
  ];
  for (const [reasons, change] of cases) expect(validateMarketplaceCatalog(catalog, change(evidence))).toEqual([...reasons]);
  const entry = catalog.plugins[0]!;
  const githubSource = {source: "github" as const, repo: "narimanisakhanov-creator/omp-settings-ru", ref: "v0.3.1", sha};
  expect(validateMarketplaceCatalog({...catalog, plugins: [{...entry, source: {...githubSource, sha: ""}}]}, evidence)).toEqual(["marketplace-source-sha-required", "marketplace-release-sha-mismatch"]);
  expect(validateMarketplaceCatalog({...catalog, plugins: [{...entry, source: {...githubSource, ref: "main"}}]}, evidence)).toEqual(["marketplace-source-ref-mismatch", "marketplace-release-ref-mismatch"]);
  expect(validateMarketplaceCatalog({...catalog, plugins: [{...entry, source: {...githubSource, repo: "someone/else"}}]}, evidence)).toEqual(["marketplace-source-repository-mismatch"]);
  expect(validateMarketplaceCatalog({...catalog, plugins: []}, evidence)).toEqual(["marketplace-plugin-count-invalid"]);
});

test("tag-commit check run is waited for, never accepted from a single completed query", () => {
  const sha = "a".repeat(40);
  const row = (patch: Record<string, unknown>): Record<string, unknown> => ({id: 7, path: ".github/workflows/check.yml", head_sha: sha, status: "completed", conclusion: "success", ...patch});
  // The observed v0.4.0 race: the release finished while the tag run was still in progress.
  expect(checkRunOutcome([row({status: "in_progress", conclusion: null})], sha)).toEqual({kind: "pending"});
  expect(checkRunOutcome([], sha)).toEqual({kind: "pending"});
  expect(checkRunOutcome(undefined, sha)).toEqual({kind: "pending"});
  // A finished but unsuccessful run is a refusal, not something to wait out.
  expect(checkRunOutcome([row({conclusion: "failure"})], sha)).toEqual({kind: "failed", conclusion: "failure"});
  expect(checkRunOutcome([row({conclusion: "cancelled"})], sha)).toEqual({kind: "failed", conclusion: "cancelled"});
  // Only the exact workflow at the exact commit is evidence; a green run elsewhere is not.
  expect(checkRunOutcome([row({path: ".github/workflows/release.yml"})], sha)).toEqual({kind: "pending"});
  expect(checkRunOutcome([row({head_sha: "b".repeat(40)})], sha)).toEqual({kind: "pending"});
  expect(checkRunOutcome([row({path: ".github/workflows/release.yml"}), row({id: 9})], sha)).toEqual({kind: "succeeded", id: "9"});
  expect(() => checkRunOutcome([row({id: "not-a-number"})], sha)).toThrow("marketplace-check-run-id-invalid");
});

test("marketplace promotion is monotonic, idempotent and conflict-refusing", () => {
  const catalog = (version: string, sha: string): MarketplaceCatalog => buildMarketplaceCatalog({version, commitSha: sha, repository: "narimanisakhanov-creator/omp-settings-ru", description: "Русский перевод /settings"});
  const older = catalog("0.3.1", "a".repeat(40));
  const newer = catalog("0.3.2", "b".repeat(40));
  expect(decideMarketplaceIndexPublish(null, older)).toBe("publish");
  expect(decideMarketplaceIndexPublish(catalogIdentity(older, "served"), older)).toBe("identical");
  expect(decideMarketplaceIndexPublish(catalogIdentity(older, "served"), newer)).toBe("publish");
  expect(() => decideMarketplaceIndexPublish(catalogIdentity(newer, "served"), older)).toThrow("marketplace-index-downgrade");
  expect(() => decideMarketplaceIndexPublish(catalogIdentity(older, "served"), catalog("0.3.1", "c".repeat(40)))).toThrow("marketplace-index-conflict");
  expect(() => catalogIdentity({name: "omp-settings-ru"}, "marketplace-served")).toThrow("marketplace-served-index-plugin-count-invalid");
  expect(catalogIdentity(older, "served")).toEqual({version: "0.3.1", sha: "a".repeat(40)});
});

test("draft catalog is bound to the uploaded asset bytes and cannot be served as published", () => {
  const sha = "a".repeat(40);
  const hash = "b".repeat(64);
  const catalog = buildMarketplaceCatalog({version: "0.3.1", commitSha: sha, repository: "narimanisakhanov-creator/omp-settings-ru", description: "Русский перевод /settings"});
  const bytes = new TextEncoder().encode(JSON.stringify(catalog, null, 2));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = (name: string, value: string): ReleaseAssetEvidence => ({name, digest: `sha256:${value}`, browserDownloadUrl: `https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/download/v0.3.1/${name}`});
  const archive = asset("omp-settings-ru-0.3.1.tgz", hash);
  const sums = asset("SHA256SUMS", hash);
  const catalogAsset = asset("marketplace.json", digest);
  const evidence: PrepublicationEvidence = {
    tag: "v0.3.1", version: "0.3.1", targetCommitSha: sha, draft: true, prerelease: false, published: false,
    checksPassed: true, checksHeadSha: sha, archiveSha256: hash, sumsSha256: hash, sumsArchiveSha256: hash,
    catalogSha256: digest, assets: [archive, sums, catalogAsset],
  };
  expect(validatePrepublicationCatalog(catalog, evidence)).toEqual([]);
  // The catalog is accepted only as the exact bytes that were downloaded: a digest that does not
  // match the uploaded asset is refused even when the JSON content satisfies every other binding.
  expect(validatePrepublicationCatalog(catalog, {...evidence, catalogSha256: "c".repeat(64)}).length).toBeGreaterThan(0);
  expect(validatePrepublicationCatalog(catalog, {...evidence, catalogSha256: "not-a-hash"}).length).toBeGreaterThan(0);
  // A missing or duplicated catalog asset is ambiguous, never resolved by picking one.
  expect(validatePrepublicationCatalog(catalog, {...evidence, assets: [archive, sums]}).length).toBeGreaterThan(0);
  expect(validatePrepublicationCatalog(catalog, {...evidence, assets: [archive, sums, catalogAsset, catalogAsset]}).length).toBeGreaterThan(0);
  // The two release states never accept each other's evidence, in either direction.
  expect(validatePrepublicationCatalog(catalog, {...evidence, draft: false}).length).toBeGreaterThan(0);
  expect(validatePrepublicationCatalog(catalog, {...evidence, published: true}).length).toBeGreaterThan(0);
  expect(validateMarketplaceCatalog(catalog, {...evidence, draft: false, published: true})).toEqual([]);
  expect(validateMarketplaceCatalog(catalog, evidence).length).toBeGreaterThan(0);
});

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface InstalledSmokeOptions {
  readonly executable: string;
  readonly pluginPath: string;
  readonly ownedProfile: string;
  readonly isolatedCwd?: string;
  readonly mode: "pre-activation" | "post-activation";
  readonly startupOnly?: boolean;
}
export interface InstalledSmokeReceipt {
  readonly hostVersion: string;
  readonly platform: string;
  readonly contentHash: string;
  readonly executableSha256: string;
  readonly pluginPath: string;
  readonly observations: readonly {kind: string;output: string}[];
  readonly passed: boolean;
  readonly installedPanel: boolean;
  readonly startupPassed?: boolean;
  readonly isolation: {ambientCredentialInherited: boolean;homeIsolated: boolean;providerRoundTrip: boolean};
  readonly pixelPath?: string;
  readonly pixelSha256?: string;
}
export interface ArtifactBinding {
  readonly schemaVersion: 1;
  readonly headSha: string;
  readonly treeHash: string;
  readonly archiveSha256: string;
  readonly contentHash: string;
  readonly fileCount: number;
  readonly extractionVerified: true;
}
export interface ArtifactBindingOptions {
  readonly sourceDirectory: string;
  readonly archivePath: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly archiveSha256?: string;
}
export interface ExtractionOptions {
  readonly archivePath: string;
  readonly targetDirectory: string;
  readonly archiveSha256?: string;
  readonly contentHash?: string;
}
export interface PackageExtraction {
  readonly directory: string;
  readonly archiveSha256: string;
  readonly contentHash: string;
  readonly fileCount: number;
  readonly extractionVerified: true;
}
export interface ArtifactReceiptExpectation {
  readonly version: string;
  readonly platform: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly archiveSha256: string;
  readonly contentHash: string;
  readonly executableSha256: string;
  readonly checkRunId: number;
  readonly workflowRunId: string;
  readonly runAttempt?: string;
}
export type ArtifactReceiptVerdict = {ok: true} | {ok: false; reason: string};

async function packageEntries(directory: string): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  const bytes = await readFile(join(directory, "package.json"));
  const metadata: unknown = JSON.parse(bytes.toString());
  if (!metadata || typeof metadata !== "object" || !("files" in metadata) || !Array.isArray(metadata.files) || metadata.files.some(path => typeof path !== "string" || !/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split("/").includes(".."))) throw new Error("package-allowlist-invalid");
  entries.set("package.json", bytes);
  async function visit(path: string) {
    const stat = await lstat(join(directory, path));
    if (stat.isDirectory()) for (const entry of await readdir(join(directory, path))) await visit(path + "/" + entry);
    else if (stat.isFile()) entries.set(path, await readFile(join(directory, path)));
    else throw new Error("unsafe-plugin-artifact-entry");
  }
  for (const path of metadata.files) await visit(path);
  return entries;
}
function contentIdentity(entries: ReadonlyMap<string, Uint8Array>): string {
  const hasher = createHash("sha256").update("omp-package-content-v1\0");
  for (const path of [...entries.keys()].sort()) {
    const bytes = entries.get(path)!;
    hasher.update(path + "\0" + bytes.length + "\0");
    hasher.update(bytes);
  }
  return hasher.digest("hex");
}
export async function canonicalContentHash(directory: string): Promise<string> {
  return contentIdentity(await packageEntries(directory));
}
export async function executableIdentity(executable: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(executable).arrayBuffer())).digest("hex");
}

/** Validate that a member set is exactly what the package allowlist permits. */
function assertAllowlisted(entries: ReadonlyMap<string, Uint8Array>): void {
  const bytes = entries.get("package.json");
  if (!bytes) throw new Error("package-allowlist-invalid");
  let metadata: unknown;
  try {metadata = JSON.parse(new TextDecoder().decode(bytes));} catch {throw new Error("package-allowlist-invalid");}
  if (!metadata || typeof metadata !== "object" || !("files" in metadata) || !Array.isArray(metadata.files) || metadata.files.some(path => typeof path !== "string" || !/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split("/").includes(".."))) throw new Error("package-allowlist-invalid");
  const files = metadata.files as string[];
  for (const path of entries.keys()) {
    if (path === "package.json") continue;
    if (!files.some(file => path === file || path.startsWith(file + "/"))) throw new Error("package-allowlist-invalid");
  }
}

/** Read one archive: hash the real bytes, cross-check both raw tar views against one immutable snapshot, then parse validated members. */
async function readPackageArchive(archivePath: string): Promise<{archiveSha256: string; contentHash: string; entries: Map<string, Uint8Array>}> {
  const bytes = await readFile(archivePath);
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  // Both tar listings run against a private copy of the exact bytes read above, so all three views describe one snapshot.
  const snapshotDirectory = await mkdtemp(join(tmpdir(), "omp-archive-snapshot-"));
  const snapshotPath = join(snapshotDirectory, "archive.tgz");
  await writeFile(snapshotPath, bytes);
  let typeRows: string[];
  let nameRows: string[];
  try {
    const verbose = Bun.spawnSync(["tar", "-tvzf", snapshotPath], {stdout: "pipe", stderr: "pipe", timeout: 30000});
    const names = Bun.spawnSync(["tar", "-tzf", snapshotPath], {stdout: "pipe", stderr: "pipe", timeout: 30000});
    if (verbose.exitCode !== 0 || names.exitCode !== 0) throw new Error("artifact-archive-unsafe");
    typeRows = verbose.stdout.toString().split(/\r?\n/).filter(Boolean);
    nameRows = names.stdout.toString().split(/\r?\n/).filter(Boolean);
  } finally {
    await rm(snapshotDirectory, {recursive: true, force: true});
  }
  if (typeRows.length !== nameRows.length || typeRows.length === 0) throw new Error("artifact-archive-unsafe");
  const listed = new Set<string>();
  for (const [index, raw] of nameRows.entries()) {
    const name = raw.replace(/\/+$/, "");
    const type = typeRows[index]![0]!;
    // The verbose listing must name the same member; the raw name is its trailing token.
    if (type !== "-" && type !== "d") throw new Error("artifact-archive-unsafe");
    if (!typeRows[index]!.trimEnd().endsWith(name)) throw new Error("artifact-archive-unsafe");
    const parts = name.split("/");
    const directoryEntry = type === "d";
    const insidePackage = directoryEntry ? name === "package" || name.startsWith("package/") : name.startsWith("package/");
    if (name.includes("\\") || /\s/.test(name) || !insidePackage || parts.some(part => part === "" || part === "." || part === "..")) throw new Error("artifact-archive-unsafe");
    if (directoryEntry) continue;
    if (listed.has(name)) throw new Error("artifact-archive-duplicate-entry");
    listed.add(name);
  }
  const entries = new Map<string, Uint8Array>();
  for (const [name, file] of await new Bun.Archive(bytes).files()) {
    const parts = name.split("/");
    if (name.includes("\\") || /\s/.test(name) || !name.startsWith("package/") || parts.some(part => part === "" || part === "." || part === "..") || !listed.has(name)) throw new Error("artifact-archive-unsafe");
    entries.set(name.slice("package/".length), new Uint8Array(await file.arrayBuffer()));
  }
  if (entries.size !== listed.size) throw new Error("artifact-archive-listing-mismatch");
  if (!entries.has("package.json")) throw new Error("artifact-archive-unsafe");
  return {archiveSha256, contentHash: contentIdentity(entries), entries};
}

/** Verify the actual archive and every package byte against the exact Git object, then prove a real extraction. */
export async function verifyArtifactBinding(options: ArtifactBindingOptions): Promise<ArtifactBinding> {
  function git(args: string[]) {
    const result = Bun.spawnSync(["git", ...args], {cwd: options.sourceDirectory, stdout: "pipe", stderr: "pipe", timeout: 30000});
    if (result.exitCode !== 0) throw new Error("source-object-unavailable");
    return result.stdout;
  }
  if (!/^[a-f0-9]{40}$/.test(options.headSha) || git(["rev-parse", "HEAD"]).toString().trim() !== options.headSha) throw new Error("source-head-mismatch");
  if (!/^[a-f0-9]{40}$/.test(options.treeHash) || git(["rev-parse", `${options.headSha}^{tree}`]).toString().trim() !== options.treeHash) throw new Error("source-tree-mismatch");
  const archive = await readPackageArchive(options.archivePath);
  if (options.archiveSha256 !== undefined && archive.archiveSha256 !== options.archiveSha256) throw new Error("archive-sha256-mismatch");
  assertAllowlisted(archive.entries);
  const source = await packageEntries(options.sourceDirectory);
  if (source.size !== archive.entries.size) throw new Error("archive-source-content-mismatch");
  const committed = new Map<string, Uint8Array>();
  for (const [path, data] of source) {
    // A packaged path absent from the committed tree, or with different bytes, is a dirty source.
    const object = Bun.spawnSync(["git", "show", `${options.headSha}:${path}`], {cwd: options.sourceDirectory, stdout: "pipe", stderr: "pipe", timeout: 30000});
    if (object.exitCode !== 0) throw new Error("source-package-dirty");
    const bytes = new Uint8Array(object.stdout);
    if (!Buffer.from(data).equals(Buffer.from(bytes))) throw new Error("source-package-dirty");
    committed.set(path, bytes);
  }
  for (const [path, data] of archive.entries) {
    const expected = committed.get(path);
    if (!expected || !Buffer.from(data).equals(Buffer.from(expected))) throw new Error("archive-source-content-mismatch");
  }
  // extractionVerified is earned only by a real extraction whose on-disk bytes re-hash to the same identity.
  const extractionRoot = await mkdtemp(join(tmpdir(), "omp-archive-verify-"));
  try {
    const extracted = await extractProvenArchive(archive, join(extractionRoot, "package"));
    if (extracted.contentHash !== archive.contentHash || extracted.fileCount !== archive.entries.size) throw new Error("extraction-unverifiable");
  } finally {
    await rm(extractionRoot, {recursive: true, force: true});
  }
  return {schemaVersion: 1, headSha: options.headSha, treeHash: options.treeHash, archiveSha256: archive.archiveSha256, contentHash: archive.contentHash, fileCount: archive.entries.size, extractionVerified: true};
}

/** Refuse an existing or linked target so extraction cannot follow a junction/symlink out of the confined root. */
async function prepareExclusiveTarget(targetDirectory: string): Promise<void> {
  const existing = await lstat(targetDirectory).catch(() => undefined);
  if (existing) throw new Error("extraction-target-conflict");
  const parent = await lstat(dirname(targetDirectory)).catch(() => undefined);
  if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error("extraction-target-conflict");
  await mkdir(targetDirectory);
  const created = await lstat(targetDirectory);
  if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("extraction-target-conflict");
}

async function extractProvenArchive(archive: {archiveSha256: string; contentHash: string; entries: Map<string, Uint8Array>}, targetDirectory: string): Promise<PackageExtraction> {
  assertAllowlisted(archive.entries);
  await prepareExclusiveTarget(targetDirectory);
  for (const [path, data] of archive.entries) {
    let current = targetDirectory;
    for (const part of path.split("/").slice(0, -1)) {
      current = join(current, part);
      if (!(await lstat(current).catch(() => undefined))) await mkdir(current);
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("extraction-target-conflict");
    }
    const target = join(targetDirectory, ...path.split("/"));
    await writeFile(target, data, {flag: "wx"});
    const written = await lstat(target);
    if (!written.isFile() || written.isSymbolicLink()) throw new Error("extraction-target-conflict");
  }
  let contentHash: string;
  try {
    contentHash = await canonicalContentHash(targetDirectory);
  } catch {
    throw new Error("extraction-unverifiable");
  }
  if (contentHash !== archive.contentHash) throw new Error("extraction-unverifiable");
  return {directory: targetDirectory, archiveSha256: archive.archiveSha256, contentHash, fileCount: archive.entries.size, extractionVerified: true};
}

/** Extract only members proven safe into a fresh, exclusively created directory, then re-hash the written bytes. */
export async function extractPackageArchive(options: ExtractionOptions): Promise<PackageExtraction> {
  const archive = await readPackageArchive(options.archivePath);
  if (options.archiveSha256 !== undefined && archive.archiveSha256 !== options.archiveSha256) throw new Error("archive-sha256-mismatch");
  if (options.contentHash !== undefined && archive.contentHash !== options.contentHash) throw new Error("extraction-content-mismatch");
  return extractProvenArchive(archive, options.targetDirectory);
}

/** Validate one CI receipt against the exact expected source and artifact identity. */
export function validateArtifactReceipt(receipt: unknown, expected: ArtifactReceiptExpectation): ArtifactReceiptVerdict {
  if (!receipt || typeof receipt !== "object") return {ok: false, reason: "receipt-invalid"};
  const record = receipt as Record<string, unknown>;
  if (record.schemaVersion !== 1) return {ok: false, reason: "receipt-schema"};
  const binding = record.binding;
  if (!binding || typeof binding !== "object") return {ok: false, reason: "receipt-binding-missing"};
  const bound = binding as Record<string, unknown>;
  for (const field of ["headSha", "treeHash", "archiveSha256", "contentHash"] as const) {
    const value = bound[field];
    if (typeof value !== "string" || value === "") return {ok: false, reason: `receipt-missing-${field}`};
    if (value !== expected[field]) return {ok: false, reason: `receipt-${field}-mismatch`};
  }
  if (bound.extractionVerified !== true) return {ok: false, reason: "receipt-extraction-unverified"};
  if (!Number.isSafeInteger(bound.fileCount) || (bound.fileCount as number) <= 0) return {ok: false, reason: "receipt-fileCount-invalid"};
  for (const field of ["version", "platform"] as const) {
    const value = record[field];
    if (typeof value !== "string" || value === "") return {ok: false, reason: `receipt-missing-${field}`};
    if (value !== expected[field]) return {ok: false, reason: `receipt-${field}-mismatch`};
  }
  if (record.native !== true) return {ok: false, reason: "receipt-not-native"};
  if (record.passed !== true) return {ok: false, reason: "receipt-smoke-failed"};
  if (!Number.isSafeInteger(record.checkRunId) || (record.checkRunId as number) <= 0) return {ok: false, reason: "receipt-check-run-missing"};
  if (record.checkRunId !== expected.checkRunId) return {ok: false, reason: "receipt-check-run-mismatch"};
  if (typeof record.workflowRunId !== "string" || record.workflowRunId === "") return {ok: false, reason: "receipt-workflow-missing"};
  if (record.workflowRunId !== expected.workflowRunId) return {ok: false, reason: "receipt-workflow-mismatch"};
  if (typeof record.runAttempt !== "string" || record.runAttempt === "") return {ok: false, reason: "receipt-workflow-missing"};
  if (expected.runAttempt !== undefined && record.runAttempt !== expected.runAttempt) return {ok: false, reason: "receipt-workflow-mismatch"};
  const executable = record.executable as Record<string, unknown> | undefined;
  if (!executable || typeof executable !== "object" || typeof executable.name !== "string" || executable.name === "" || typeof executable.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(executable.sha256)) return {ok: false, reason: "receipt-executable-unverified"};
  if (executable.sha256 !== expected.executableSha256) return {ok: false, reason: "receipt-executable-mismatch"};
  const smoke = record.smoke as Record<string, unknown> | undefined;
  if (!smoke || typeof smoke !== "object") return {ok: false, reason: "receipt-smoke-missing"};
  if (smoke.passed !== true) return {ok: false, reason: "receipt-smoke-failed"};
  if (smoke.installedPanel !== true) return {ok: false, reason: "receipt-smoke-not-panel"};
  if (smoke.hostVersion !== expected.version) return {ok: false, reason: "receipt-smoke-host-version-mismatch"};
  if (smoke.platform !== expected.platform) return {ok: false, reason: "receipt-smoke-platform-mismatch"};
  const isolation = smoke.isolation as Record<string, unknown> | undefined;
  if (!isolation || isolation.ambientCredentialInherited !== false || isolation.homeIsolated !== true || isolation.providerRoundTrip !== false) return {ok: false, reason: "receipt-smoke-isolation-invalid"};
  if (!Array.isArray(smoke.observations) || smoke.observations.length === 0) return {ok: false, reason: "receipt-smoke-unobserved"};
  if (smoke.contentHash !== bound.contentHash) return {ok: false, reason: "receipt-smoke-content-mismatch"};
  if (smoke.executableSha256 !== executable.sha256) return {ok: false, reason: "receipt-executable-mismatch"};
  return {ok: true};
}

/** Real executable/PTY driver shared by local smoke, updater and CI; no provider call or Orca dependency. */
export async function runInstalledSmoke(options: InstalledSmokeOptions): Promise<InstalledSmokeReceipt> {
  if (!/^omp-settings-ru-proof-[a-zA-Z0-9-]+$/.test(options.ownedProfile)) throw new Error("refusing-unowned-profile");
  const pluginPath = resolve(options.pluginPath);
  const contentHash = await canonicalContentHash(pluginPath);
  const executableSha256 = await executableIdentity(options.executable);
  const home=options.isolatedCwd ?? await mkdtemp(join(tmpdir(),"omp-settings-ru-smoke-"));
  const environment: Record<string,string> = {};
  for (const key of ["PATH","PATHEXT","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP"]) if(process.env[key])environment[key]=process.env[key]!;
  Object.assign(environment,{HOME:home,USERPROFILE:home,APPDATA:join(home,"appdata"),LOCALAPPDATA:join(home,"localappdata")});
  const version=Bun.spawnSync([options.executable,"--version"],{env:environment,stdout:"pipe",stderr:"pipe",timeout:30000});
  const hostVersion=/^omp\/(\d+\.\d+\.\d+)$/.exec(version.stdout.toString().trim())?.[1];
  if(version.exitCode!==0||!hostVersion)throw new Error("installed-host-unavailable");
  const prior=process.env.OMP_SMOKE_PRIVATE_SENTINEL;
  process.env.OMP_SMOKE_PRIVATE_SENTINEL="must-not-inherit";
  let result;
  try {
    result=Bun.spawnSync([process.execPath,resolve("scripts/smoke-installed-worker.ts"),options.executable,options.ownedProfile,pluginPath,home,...(options.startupOnly?["--startup-only"]:[])],{env:environment,stdout:"pipe",stderr:"pipe",timeout:180000});
  } finally {
    if(prior===undefined)delete process.env.OMP_SMOKE_PRIVATE_SENTINEL;else process.env.OMP_SMOKE_PRIVATE_SENTINEL=prior;
  }
  if(result.exitCode!==0)throw new Error("installed-panel-smoke-failed:"+result.stderr.toString().replaceAll(home,"[owned-home]").replaceAll(pluginPath,"[plugin]").slice(-4000));
  const observed=JSON.parse(result.stdout.toString());
  if(!(options.startupOnly ? observed.startupPassed : observed.installedPanel)||observed.isolation.ambientCredentialInherited)throw new Error("installed-panel-proof-invalid");
  return {hostVersion,platform:process.platform,contentHash,executableSha256,pluginPath:"[verified-plugin-artifact]",...observed,passed:true};
}

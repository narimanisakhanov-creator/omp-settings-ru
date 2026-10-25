import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { computeSourceHash } from "../../src/source";
import type { BaselineSnapshot } from "../../src/report";
import { asRecord, parseStrictJSON } from "./json";
import { parseCatalogJSON, CATALOG_PATH } from "./catalog";
import { SNAPSHOT_PLATFORMS, SUPPORTED_HOSTS, snapshotPath } from "./paths";
import { candidatePaths, git, stableVersion, validateBundle, validateCandidateTree, writeBundleManifest, type Candidate } from "./actions-bundle";
import { secretFreeEnvironment } from "./actions-github";
import { approvedDelta, hostAliasOf } from "./measurement-environment";
import { catalogEntries, identitiesOf, translationIdentitiesOf, markerPairsOf, validateSemantic, type SemanticEvidence } from "./semantic";
import type { ControllerPolicy } from "./contracts";

const platforms = SNAPSHOT_PLATFORMS;
export interface SupportedHosts { schemaVersion: number; versions: { version: string; package: string; platforms: string[]; baselines: Record<string, string> }[]; [key: string]: unknown }
export async function runTrusted(cwd: string, args: readonly string[], timeout: number, environment: Record<string, string | undefined> = {}): Promise<string> {
  const child = Bun.spawn([...args], { cwd, env: { ...secretFreeEnvironment(), ...environment }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`trusted-command-failed:${args.slice(0, 2).join(":")}`);
    if (stdout.length > 32 * 1024 * 1024) throw new Error("trusted-output-too-large");
    return stdout;
  } finally { clearTimeout(timer); }
}
export function snapshotValue(value: unknown, version?: string, platform?: string): BaselineSnapshot {
  const snapshot = asRecord(value);
  if (!snapshot || Object.keys(snapshot).sort().join(",") !== "platform,settings,version" || typeof snapshot.version !== "string" || !stableVersion.test(snapshot.version) || !platforms.includes(snapshot.platform as typeof platforms[number]) || (version && snapshot.version !== version) || (platform && snapshot.platform !== platform)) throw new Error("snapshot-identity-invalid");
  const settings = asRecord(snapshot.settings);
  if (!settings || !Object.keys(settings).length || Object.keys(settings).length > 10000) throw new Error("snapshot-settings-invalid");
  for (const [path, raw] of Object.entries(settings)) {
    const source = asRecord(raw);
    if (!path || !source || Object.keys(source).sort().join(",") !== "description,group,label,options,sourceHash,tab,warning" || typeof source.tab !== "string" || (source.group !== null && typeof source.group !== "string") || typeof source.label !== "string" || typeof source.description !== "string" || (source.warning !== null && typeof source.warning !== "string") || !(source.options === null || source.options === "runtime" || Array.isArray(source.options))) throw new Error("snapshot-source-invalid");
    if (Array.isArray(source.options)) {
      const values = new Set<string>();
      for (const rawOption of source.options) {
        const option = asRecord(rawOption);
        if (!option || Object.keys(option).sort().join(",") !== "description,label,value" || typeof option.value !== "string" || typeof option.label !== "string" || (option.description !== null && typeof option.description !== "string") || values.has(option.value)) throw new Error("snapshot-option-invalid");
        values.add(option.value);
      }
    }
    const { sourceHash, ...metadata } = source;
    if (sourceHash !== computeSourceHash(metadata as unknown as BaselineSnapshot["settings"][string])) throw new Error("snapshot-source-hash-mismatch");
  }
  return snapshot as unknown as BaselineSnapshot;
}
export async function saveCandidateData(worktree: string, output: string, candidate: Candidate): Promise<void> {
  for (const path of candidatePaths(candidate.upstreamVersion)) {
    const file = Bun.file(join(worktree, path));
    if (!await file.exists()) continue;
    await mkdir(dirname(join(output, "data", path)), { recursive: true });
    await Bun.write(join(output, "data", path), await file.arrayBuffer());
  }
  await writeBundleManifest(output, candidate);
}
export async function createCandidateWorktree(checkout: string, baseSha: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-actions-worktree-"));
  const worktree = join(root, "candidate");
  git(checkout, ["worktree", "add", "--detach", worktree, baseSha]);
  return worktree;
}
export async function removeCandidateWorktree(checkout: string, worktree: string): Promise<void> {
  git(checkout, ["worktree", "remove", "--force", worktree]);
  await rm(dirname(worktree), { recursive: true, force: true });
}
export async function applyCandidateData(root: string, worktree: string, candidate: Candidate): Promise<void> {
  for (const file of candidate.files.filter(file => file.path.startsWith("data/"))) {
    const path = file.path.slice(5);
    if (!candidatePaths(candidate.upstreamVersion).includes(path)) throw new Error("candidate-data-path-forbidden");
    await mkdir(dirname(join(worktree, path)), { recursive: true });
    await Bun.write(join(worktree, path), await Bun.file(join(root, file.path)).arrayBuffer());
  }
}
export async function prepareCandidate(checkout: string, output: string, candidate: Candidate, policy: ControllerPolicy): Promise<void> {
  if (!isAbsolute(output)) throw new Error("output-must-be-absolute");
  await mkdir(output, { recursive: false });
  const worktree = await createCandidateWorktree(checkout, candidate.baseSha);
  try {
    await runTrusted(worktree, ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], policy.deadlinesMs.verification);
    await runTrusted(worktree, ["bun", "scripts/upgrade-host.ts", candidate.upstreamVersion], policy.deadlinesMs.verification);
    const manifest = JSON.parse(await Bun.file(join(worktree, "package.json")).text()) as { version: string };
    manifest.version = candidate.releaseVersion;
    await Bun.write(join(worktree, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    const snapshots: BaselineSnapshot[] = [];
    for (const platform of platforms) {
      const text = await runTrusted(worktree, ["bun", "scripts/matrix-registry-worker.ts", hostAliasOf(candidate.upstreamVersion), candidate.upstreamVersion, platform], policy.deadlinesMs.verification);
      const snapshot = snapshotValue(parseStrictJSON(text), candidate.upstreamVersion, platform);
      const bytes = JSON.stringify(snapshot, null, 2) + "\n";
      await Bun.write(join(worktree, snapshotPath(candidate.upstreamVersion, platform)), bytes);
      snapshots.push(snapshot);
    }
    const supported = parseStrictJSON(await Bun.file(join(worktree, SUPPORTED_HOSTS)).text()) as SupportedHosts;
    if (supported.versions.some(row => row.version === candidate.upstreamVersion || row.package === hostAliasOf(candidate.upstreamVersion))) throw new Error("candidate-already-supported-or-alias-conflict");
    for (const row of supported.versions) for (const platform of platforms) snapshots.push(snapshotValue(parseStrictJSON(await Bun.file(join(worktree, snapshotPath(row.version, platform))).text()), row.version, platform));
    await Bun.write(join(output, "input.json"), JSON.stringify({ snapshots }) + "\n");
    await saveCandidateData(worktree, output, candidate);
  } finally { await removeCandidateWorktree(checkout, worktree); }
}
export async function completeSupport(worktree: string, candidate: Candidate): Promise<readonly string[]> {
  const supported = parseStrictJSON(await Bun.file(join(worktree, SUPPORTED_HOSTS)).text()) as SupportedHosts;
  const baselines: Record<string, string> = {};
  for (const platform of platforms) baselines[platform] = createHash("sha256").update(await Bun.file(join(worktree, snapshotPath(candidate.upstreamVersion, platform))).bytes()).digest("hex");
  supported.versions.push({ version: candidate.upstreamVersion, package: hostAliasOf(candidate.upstreamVersion), platforms: [...platforms], baselines });
  await Bun.write(join(worktree, SUPPORTED_HOSTS), JSON.stringify(supported, null, 2) + "\n");
  const versions = supported.versions.map(row => row.version);
  const manifest = parseStrictJSON(await Bun.file(join(worktree, "package.json")).text()) as { version: string; peerDependencies: Record<string, string> };
  manifest.version = candidate.releaseVersion;
  for (const name of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-utils"]) {
    if (!Object.hasOwn(manifest.peerDependencies, name)) throw new Error("accepted-peer-missing");
    manifest.peerDependencies[name] = versions.join(" || ");
  }
  await Bun.write(join(worktree, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return versions;
}
export async function validatePublishedCandidate(checkout: string, root: string, policy: ControllerPolicy): Promise<Candidate> {
  const candidate = await validateBundle(root);
  if (candidate.repository !== policy.repository) throw new Error("candidate-repository-mismatch");
  const paths = validateCandidateTree(checkout, root, candidate);
  for (const path of paths) {
    const committed = Bun.spawnSync(["git", "show", `${candidate.headSha}:${path}`], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    const artifact = Bun.file(join(root, "data", path));
    if (committed.exitCode || !await artifact.exists() || !Buffer.from(committed.stdout).equals(Buffer.from(await artifact.arrayBuffer()))) throw new Error(`candidate-data-commit-mismatch:${path}`);
  }
  const before = parseStrictJSON(git(checkout, ["show", `${candidate.baseSha}:package.json`]));
  const after = parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:package.json`]));
  const approved = approvedDelta(before, after, candidate.upstreamVersion);
  if ("failure" in approved) throw new Error(approved.failure);
  const oldVersion = String(asRecord(before)?.version).split(".").map(Number);
  if (candidate.releaseVersion !== `${oldVersion[0]}.${oldVersion[1]! + 1}.0` || asRecord(after)?.version !== candidate.releaseVersion) throw new Error("candidate-release-version-mismatch");
  const supportedBefore = asRecord(parseStrictJSON(git(checkout, ["show", `${candidate.baseSha}:${SUPPORTED_HOSTS}`])));
  const supportedAfter = asRecord(parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:${SUPPORTED_HOSTS}`])));
  if (!supportedBefore || !supportedAfter || !Array.isArray(supportedBefore.versions) || !Array.isArray(supportedAfter.versions) || supportedAfter.versions.length !== supportedBefore.versions.length + 1) throw new Error("candidate-support-delta-invalid");
  const added = supportedAfter.versions.at(-1) as Record<string, unknown>;
  if (JSON.stringify(supportedAfter.versions.slice(0, -1)) !== JSON.stringify(supportedBefore.versions) || added.version !== candidate.upstreamVersion || added.package !== hostAliasOf(candidate.upstreamVersion) || JSON.stringify(added.platforms) !== JSON.stringify(platforms)) throw new Error("candidate-support-delta-invalid");
  const { versions: _old, ...oldSupport } = supportedBefore; const { versions: _new, ...newSupport } = supportedAfter;
  if (JSON.stringify(oldSupport) !== JSON.stringify(newSupport)) throw new Error("candidate-support-history-changed");
  const versions = supportedAfter.versions.map(row => String(asRecord(row)?.version));
  const peers = asRecord(asRecord(after)?.peerDependencies);
  for (const name of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-utils"]) if (peers?.[name] !== versions.join(" || ")) throw new Error("candidate-peer-union-invalid");
  for (const platform of platforms) {
    const path = snapshotPath(candidate.upstreamVersion, platform);
    const bytes = await Bun.file(join(root, "data", path)).bytes();
    snapshotValue(parseStrictJSON(new TextDecoder().decode(bytes)), candidate.upstreamVersion, platform);
    if (asRecord(added.baselines)?.[platform] !== createHash("sha256").update(bytes).digest("hex")) throw new Error("candidate-baseline-hash-mismatch");
  }
  const currentEntries = catalogEntries(parseCatalogJSON(git(checkout, ["show", `${candidate.headSha}:${CATALOG_PATH}`])));
  const baseEntries = catalogEntries(parseCatalogJSON(git(checkout, ["show", `${candidate.baseSha}:${CATALOG_PATH}`])));
  const proof = asRecord(parseStrictJSON(await Bun.file(join(root, "proof.json")).text()));
  if (!proof || proof.baseSha !== candidate.baseSha || proof.upstreamVersion !== candidate.upstreamVersion || proof.releaseVersion !== candidate.releaseVersion || proof.semanticReview !== "disabled" || proof.nativeSmoke !== "passed" || !asRecord(proof.semantic)) throw new Error("candidate-verification-proof-invalid");
  const evidence = proof.semantic as unknown as SemanticEvidence;
  if (evidence.reviewRows.length !== 0) throw new Error("candidate-verification-reviews-unexpected");
  if ([...evidence.changedPaths].sort().join("\0") !== [...paths].sort().join("\0") || evidence.candidateVersion !== candidate.upstreamVersion) throw new Error("candidate-verification-paths-mismatch");
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(evidence.identities, identitiesOf(currentEntries)) || !same(evidence.identitiesBefore, identitiesOf(baseEntries)) || !same(evidence.translationIdentities, translationIdentitiesOf(currentEntries)) || !same(evidence.translationIdentitiesBefore, translationIdentitiesOf(baseEntries))) throw new Error("candidate-semantic-identities-mismatch");
  const snapshots: BaselineSnapshot[] = [];
  for (const version of versions) for (const platform of platforms) snapshots.push(snapshotValue(parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:${snapshotPath(version, platform)}`])), version, platform));
  if (!same(evidence.markerPairs, markerPairsOf(currentEntries, snapshots)) || !same(evidence.supportedVersions, versions)) throw new Error("candidate-semantic-source-mismatch");
  const requirements = currentEntries.filter(entry => !baseEntries.some(old => old.path === entry.path && old.sourceHash === entry.sourceHash && old.translationHash === entry.translationHash && entry.platforms.every(platform => old.platforms.includes(platform)))).map(entry => ({ path: entry.path, sourceHash: entry.sourceHash, translationHash: entry.translationHash, platforms: [...entry.platforms].sort() }));
  if (!same(evidence.changedCatalogVariants, requirements)) throw new Error("candidate-semantic-delta-mismatch");
  const manifest = asRecord(parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:src/translations/variant-review.json`])));
  const oldManifest = asRecord(parseStrictJSON(git(checkout, ["show", `${candidate.baseSha}:src/translations/variant-review.json`])));
  if (!manifest || !oldManifest || manifest.semanticReview !== "disabled" || !Array.isArray(manifest.variants) || !Array.isArray(oldManifest.variants)) throw new Error("candidate-review-manifest-invalid");
  if (JSON.stringify(manifest.variants) !== JSON.stringify(oldManifest.variants)) throw new Error("candidate-review-history-changed");
  const verdict = validateSemantic(evidence, policy, undefined, true);
  if (!verdict.ok) throw new Error(verdict.reason);
  const digest = (path: string) => createHash("sha256").update(git(checkout, ["show", `${candidate.headSha}:${path}`]) + "\n").digest("hex");
  if (proof.catalogSha256 !== digest(CATALOG_PATH) || proof.manifestSha256 !== digest("src/translations/variant-review.json")) throw new Error("candidate-verification-data-mismatch");
  return candidate;
}

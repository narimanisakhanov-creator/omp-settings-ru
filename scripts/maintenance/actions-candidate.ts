import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { BaselineSnapshot } from "../../src/report";
import { asRecord, parseStrictJSON } from "./json";
import { parseCatalogJSON, CATALOG_PATH } from "./catalog";
import { SNAPSHOT_PLATFORMS, SUPPORTED_HOSTS, snapshotPath, supportWindow, evidenceHosts, validateSupportedHostsManifest } from "./paths";
import { compareVersions } from "./policy";
import { candidatePaths, git, validateBundle, validateCandidateTree, writeBundleManifest, type Candidate } from "./actions-bundle";
import { verifyReleaseDocuments } from "./release-documents";
import { secretFreeEnvironment } from "./actions-github";
import { approvedDelta, dispose, exportHostSnapshot, hostAliasOf, lockVerdict, prepareToolRoot } from "./measurement-environment";
import { catalogEntries, catalogDelta, identitiesOf, markerPairsOf, translationIdentitiesOf, validateSemantic, type SemanticEvidence } from "./semantic";
import { snapshotValue } from "./snapshots";
import type { ControllerPolicy } from "./contracts";

const platforms = SNAPSHOT_PLATFORMS;
export interface SupportedHosts { schemaVersion: number; versions: { version: string; package: string; platforms: string[]; baselines: Record<string, string> }[]; historical?: { version: string; package: string; platforms: string[]; baselines: Record<string, string> }[]; [key: string]: unknown }
export async function runTrusted(cwd: string, args: readonly string[], timeout: number, environment: Record<string, string | undefined> = {}): Promise<string> {
  const child = Bun.spawn([...args], { cwd, env: { ...secretFreeEnvironment(), ...environment }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) {
      // A failure must be diagnosable. The raw tail goes to the job log, and a charset-safe form
      // rides in the error so the bounded outcome artifact keeps a usable reason instead of a bare
      // command name.
      const tail = (stderr.trim() || stdout.trim()).split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
      if (tail) console.error(`trusted-command-failed:${args.slice(0, 2).join(":")}\n${tail}`);
      const safe = tail.replace(/[^A-Za-z0-9:._/-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
      throw new Error(`trusted-command-failed:${args.slice(0, 2).join(":")}${safe ? `:${safe}` : ""}`);
    }
    if (stdout.length > 32 * 1024 * 1024) throw new Error("trusted-output-too-large");
    return stdout;
  } finally { clearTimeout(timer); }
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
    const supported = validateSupportedHostsManifest(parseStrictJSON(await Bun.file(join(worktree, SUPPORTED_HOSTS)).text())) as SupportedHosts;
    if (supported.versions.some(row => row.version === candidate.upstreamVersion || row.package === hostAliasOf(candidate.upstreamVersion)) || (supported.historical ?? []).some(row => row.version === candidate.upstreamVersion || row.package === hostAliasOf(candidate.upstreamVersion))) throw new Error("candidate-already-supported-or-alias-conflict");
    const target = supportWindow([...supported.versions.map(row => row.version), candidate.upstreamVersion]);
    if (!target.includes(candidate.upstreamVersion)) throw new Error("candidate-support-window-invalid");
    for (const platform of platforms) {
      const text = await runTrusted(worktree, ["bun", "scripts/matrix-registry-worker.ts", hostAliasOf(candidate.upstreamVersion), candidate.upstreamVersion, platform], policy.deadlinesMs.verification);
      const snapshot = snapshotValue(parseStrictJSON(text), candidate.upstreamVersion, platform);
      const bytes = JSON.stringify(snapshot, null, 2) + "\n";
      await Bun.write(join(worktree, snapshotPath(candidate.upstreamVersion, platform)), bytes);
    }
    for (const version of target) for (const platform of platforms) snapshots.push(snapshotValue(parseStrictJSON(await Bun.file(join(worktree, snapshotPath(version, platform))).text()), version, platform));
    await Bun.write(join(output, "input.json"), JSON.stringify({ snapshots }) + "\n");
    await saveCandidateData(worktree, output, candidate);
  } finally { await removeCandidateWorktree(checkout, worktree); }
}
export async function completeSupport(worktree: string, candidate: Candidate): Promise<readonly string[]> {
  const supported = validateSupportedHostsManifest(parseStrictJSON(await Bun.file(join(worktree, SUPPORTED_HOSTS)).text())) as SupportedHosts;
  const active = [...supported.versions];
  if (active.some(row => row.version === candidate.upstreamVersion || row.package === hostAliasOf(candidate.upstreamVersion)) || (supported.historical ?? []).some(row => row.version === candidate.upstreamVersion || row.package === hostAliasOf(candidate.upstreamVersion))) throw new Error("candidate-already-supported-or-alias-conflict");
  const target = supportWindow([...active.map(row => row.version), candidate.upstreamVersion]);
  if (!target.includes(candidate.upstreamVersion)) throw new Error("candidate-support-window-invalid");
  const overflow = active.filter(row => !target.includes(row.version));
  const retained = active.filter(row => target.includes(row.version));
  const baselines: Record<string, string> = {};
  for (const platform of platforms) {
    const file = Bun.file(join(worktree, snapshotPath(candidate.upstreamVersion, platform)));
    if (!await file.exists()) throw new Error(`candidate-snapshot-missing:${candidate.upstreamVersion}-${platform}`);
    const bytes = await file.bytes();
    snapshotValue(parseStrictJSON(new TextDecoder().decode(bytes)), candidate.upstreamVersion, platform);
    baselines[platform] = createHash("sha256").update(bytes).digest("hex");
  }
  const added = { version: candidate.upstreamVersion, package: hostAliasOf(candidate.upstreamVersion), platforms: [...platforms], baselines };
  supported.versions = [...retained, added].sort((left, right) => compareVersions(left.version, right.version));
  supported.historical = [...(supported.historical ?? []), ...overflow].sort((left, right) => compareVersions(left.version, right.version));
  await Bun.write(join(worktree, SUPPORTED_HOSTS), JSON.stringify(supported, null, 2) + "\n");
  const versions = supported.versions.map(row => row.version);
  const manifest = parseStrictJSON(await Bun.file(join(worktree, "package.json")).text()) as { version: string; peerDependencies: Record<string, string>; devDependencies: Record<string, string> };
  manifest.version = candidate.releaseVersion;
  for (const name of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-utils"]) {
    if (!Object.hasOwn(manifest.peerDependencies, name)) throw new Error("accepted-peer-missing");
    manifest.peerDependencies[name] = versions.join(" || ");
  }
  for (const row of overflow) delete manifest.devDependencies[row.package];
  await Bun.write(join(worktree, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return versions;
}
/** Байты артефакта обязаны совпасть с коммитом: манифест артефакта сверяет хэши, а не смысл файла. */
export async function verifyCommittedArtifacts(checkout: string, root: string, candidate: Candidate, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const committed = Bun.spawnSync(["git", "show", `${candidate.headSha}:${path}`], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    const artifact = Bun.file(join(root, "data", path));
    if (committed.exitCode || !await artifact.exists() || !Buffer.from(committed.stdout).equals(Buffer.from(await artifact.arrayBuffer()))) throw new Error(`candidate-data-commit-mismatch:${path}`);
  }
}
export async function validatePublishedCandidate(checkout: string, root: string, policy: ControllerPolicy, registry?: string): Promise<Candidate> {
  const candidate = await validateBundle(root);
  if (candidate.repository !== policy.repository) throw new Error("candidate-repository-mismatch");
  const paths = validateCandidateTree(checkout, root, candidate);
  await verifyCommittedArtifacts(checkout, root, candidate, paths);
  const before = parseStrictJSON(git(checkout, ["show", `${candidate.baseSha}:package.json`])) as Record<string, unknown>;
  const after = parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:package.json`])) as Record<string, unknown>;
  const supportedBefore = validateSupportedHostsManifest(parseStrictJSON(git(checkout, ["show", `${candidate.baseSha}:${SUPPORTED_HOSTS}`])));
  const supportedAfter = validateSupportedHostsManifest(parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:${SUPPORTED_HOSTS}`])));
  const activeBefore = [...supportedBefore.versions];
  const expectedVersions = supportWindow([...activeBefore.map(row => row.version), candidate.upstreamVersion]);
  if (!expectedVersions.includes(candidate.upstreamVersion)) throw new Error("candidate-support-window-invalid");
  const overflow = activeBefore.filter(row => !expectedVersions.includes(row.version));
  const retained = activeBefore.filter(row => expectedVersions.includes(row.version));
  const added = supportedAfter.versions.find(row => row.version === candidate.upstreamVersion);
  if (!added) throw new Error("candidate-support-candidate-missing");
  const expectedActive = [...retained, added].sort((left, right) => compareVersions(left.version, right.version));
  const expectedHistorical = [...(supportedBefore.historical ?? []), ...overflow].sort((left, right) => compareVersions(left.version, right.version));
  if (JSON.stringify(supportedAfter.versions) !== JSON.stringify(expectedActive) || JSON.stringify(supportedAfter.historical ?? []) !== JSON.stringify(expectedHistorical)) throw new Error("candidate-support-delta-invalid");
  const supportKeys = new Set([...Object.keys(supportedBefore), ...Object.keys(supportedAfter)]);
  for (const key of supportKeys) if (key !== "versions" && key !== "historical" && JSON.stringify(supportedBefore[key]) !== JSON.stringify(supportedAfter[key])) throw new Error("candidate-support-field-changed");
  if (added.package !== hostAliasOf(candidate.upstreamVersion) || JSON.stringify(added.platforms) !== JSON.stringify([...platforms])) throw new Error("candidate-support-candidate-invalid");
  const acceptedAliases = supportedBefore.versions.map(row => row.package);
  const baseDev = asRecord(before.devDependencies);
  if (!baseDev || acceptedAliases.some(alias => {
    const row = activeBefore.find(item => item.package === alias);
    return !row || baseDev[alias] !== `npm:@oh-my-pi/pi-coding-agent@${row.version}`;
  }) || Object.keys(baseDev).filter(alias => alias.startsWith("omp-host-")).sort().join("\0") !== [...acceptedAliases].sort().join("\0")) throw new Error("accepted-alias-manifest-mismatch");
  const approved = approvedDelta(before, after, candidate.upstreamVersion);
  if ("failure" in approved) throw new Error(approved.failure);
  const oldVersion = String(asRecord(before)?.version).split(".").map(Number);
  if (candidate.releaseVersion !== `${oldVersion[0]}.${oldVersion[1]! + 1}.0` || asRecord(after)?.version !== candidate.releaseVersion) throw new Error("candidate-release-version-mismatch");
  const versions = supportedAfter.versions.map(row => row.version);
  const peers = asRecord(asRecord(after)?.peerDependencies);
  for (const name of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-utils"]) if (peers?.[name] !== versions.join(" || ")) throw new Error("candidate-peer-union-invalid");
  const addedAfter = supportedAfter.versions.at(-1)!;
  for (const platform of platforms) {
    const path = snapshotPath(candidate.upstreamVersion, platform);
    const bytes = await Bun.file(join(root, "data", path)).bytes();
    snapshotValue(parseStrictJSON(new TextDecoder().decode(bytes)), candidate.upstreamVersion, platform);
    if (addedAfter.baselines?.[platform] !== createHash("sha256").update(bytes).digest("hex")) throw new Error("candidate-baseline-hash-mismatch");
  }
  const measurementCheckout = await createCandidateWorktree(checkout, candidate.headSha!);
  const measurementRoot = join(root, "trusted-measurement");
  const prepared = await prepareToolRoot({ checkout: measurementCheckout, baseSha: candidate.baseSha, root: measurementRoot, delta: approved.delta, deadlineMs: policy.deadlinesMs.verification, registry });
  if ("failure" in prepared) { await removeCandidateWorktree(checkout, measurementCheckout); throw new Error(prepared.failure); }
  try {
    const lock = lockVerdict(prepared.lock, git(checkout, ["show", `${candidate.headSha}:bun.lock`]), Bun.version);
    if ("failure" in lock) throw new Error(lock.failure);
    for (const platform of platforms) {
      const exported = await exportHostSnapshot({ root: prepared.root, alias: hostAliasOf(candidate.upstreamVersion), version: candidate.upstreamVersion, platform, lock: prepared.lock, deadlineMs: policy.deadlinesMs.verification });
      if ("failure" in exported) throw new Error(exported.failure);
      const file = await Bun.file(join(root, "data", snapshotPath(candidate.upstreamVersion, platform))).json();
      if (JSON.stringify(snapshotValue(file, candidate.upstreamVersion, platform)) !== JSON.stringify(snapshotValue(exported.snapshot, candidate.upstreamVersion, platform))) throw new Error(`candidate-snapshot-source-mismatch:${candidate.upstreamVersion}-${platform}`);
    }
  } finally { await dispose(prepared.root); await removeCandidateWorktree(checkout, measurementCheckout); }
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
  for (const row of evidenceHosts(supportedAfter)) for (const platform of row.platforms) snapshots.push(snapshotValue(parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:${snapshotPath(row.version, platform)}`])), row.version, platform));
  const baseSnapshots: BaselineSnapshot[] = [];
  for (const row of evidenceHosts(supportedBefore)) for (const platform of row.platforms) baseSnapshots.push(snapshotValue(parseStrictJSON(git(checkout, ["show", `${candidate.baseSha}:${snapshotPath(row.version, platform)}`])), row.version, platform));
  if (!same(evidence.markerPairs, markerPairsOf(currentEntries, snapshots)) || !same(evidence.supportedVersions, versions)) throw new Error("candidate-semantic-source-mismatch");
  await verifyReleaseDocuments(checkout, candidate, versions, evidence.coverage);
  const requirements = catalogDelta(currentEntries, baseEntries, snapshots, baseSnapshots);
  if ("failure" in requirements || !same(evidence.changedCatalogVariants, requirements.variants)) throw new Error("candidate-semantic-delta-mismatch");
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

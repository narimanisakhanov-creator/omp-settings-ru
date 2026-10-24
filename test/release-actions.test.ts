import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMarketplaceCatalog, sha256Bytes } from "../scripts/marketplace-catalog";
import {
  archiveChecksumFromSums,
  assertReleaseAncestor,
  assertTrustedMain,
  bindReleaseArtifact,
  DRAFT_OBSERVABILITY_TIMEOUT_MS,
  observeDraftRelease,
  packageAtCommit,
  packageIdentity,
  parseArtifact,
  parseBuildJob,
  parseMarketplaceRunOrigin,
  parsePrepublishEvidence,
  parsePrepublishReceipt,
  parseReleaseManifest,
  parseReleaseArtifactName,
  parseReleaseRow,
  parseReleaseRun,
  releaseNamingErrors,
  parseReleaseTag,
  planReleaseAssets,
  parsePrepublishArtifactName,
  promotionErrors,
  sealPrepublishReceipt,
  selectReleaseRun,
  servedProofErrors,
  verifyManifestAssets,
  type PrepublishEvidence,
  type ReleaseManifest,
  type ReleaseRow,
} from "../scripts/release-actions";

const REPOSITORY = "narimanisakhanov-creator/omp-settings-ru";
const TAG_SHA = "a".repeat(40);
const MAIN_SHA = "b".repeat(40);
const HASH = "c".repeat(64);
const OTHER_HASH = "d".repeat(64);

function refusal(run: () => unknown): string {
  try {
    run();
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function releaseRun(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1234, run_attempt: 2, path: ".github/workflows/release.yml", event: "push",
    head_branch: "v1.2.3", head_sha: TAG_SHA, status: "completed", conclusion: "success",
    repository: { full_name: REPOSITORY }, ...patch,
  };
}

function artifact(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 77, name: "release-v1.2.3-1234-2", expired: false, size_in_bytes: 4096,
    digest: `sha256:${HASH}`,
    workflow_run: { id: 1234, head_sha: TAG_SHA, head_branch: "v1.2.3" },
    ...patch,
  };
}

function manifest(assets: readonly { name: string; sha256: string }[]): ReleaseManifest {
  return { schemaVersion: 1, repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", releaseSha: TAG_SHA, runId: "1234", runAttempt: "2", assets };
}

const wanted = [
  { name: "omp-settings-ru-1.2.3.tgz", sha256: HASH },
  { name: "SHA256SUMS", sha256: OTHER_HASH },
  { name: "marketplace.json", sha256: HASH },
];

function evidence(catalogBytes: Uint8Array): PrepublishEvidence {
  return {
    schemaVersion: 1, repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", tagSha: TAG_SHA,
    releaseState: "draft", releaseRunId: "1234", releaseRunAttempt: "2", checkRunId: "99",
    catalogSha256: sha256Bytes(catalogBytes), archiveSha256: HASH, sumsSha256: OTHER_HASH,
  };
}

const successfulSmoke = { observations: [{ kind: "ru-panel", output: "observed" }], personalProfileChanged: false, profile: "proof", home: "/tmp/proof" };

test("a release tag is exactly stable vX.Y.Z and nothing else", () => {
  expect(parseReleaseTag("v1.2.3")).toEqual({ tag: "v1.2.3", version: "1.2.3" });
  for (const invalid of ["1.2.3", "v01.2.3", "v1.02.3", "v1.2", "v1.2.3-rc.1", "v1.2.3+build", "v1.2.3\n", " v1.2.3", "V1.2.3", "v1..3"]) {
    expect(refusal(() => parseReleaseTag(invalid))).toBe("release-tag-invalid");
  }
});

test("release run proof rejects every foreign workflow, event, ref or attempt dimension", () => {
  const expected = { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA, requireSuccess: true };
  expect(parseReleaseRun(releaseRun(), expected)).toEqual({ id: "1234", attempt: "2", event: "push", headSha: TAG_SHA, headBranch: "v1.2.3" });
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ repository: { full_name: "someone/else" } }, "release-run-repository-mismatch"],
    [{ path: ".github/workflows/check.yml" }, "release-run-workflow-mismatch"],
    [{ event: "pull_request" }, "release-run-event-invalid"],
    [{ event: "workflow_run" }, "release-run-event-invalid"],
    [{ head_branch: "main" }, "release-run-tag-mismatch"],
    [{ head_sha: MAIN_SHA }, "release-run-sha-mismatch"],
    [{ conclusion: "failure" }, "release-run-not-successful"],
    [{ status: "in_progress", conclusion: null }, "release-run-not-successful"],
  ];
  for (const [patch, reason] of cases) expect(refusal(() => parseReleaseRun(releaseRun(patch), expected))).toBe(reason);
  expect(refusal(() => parseReleaseRun(releaseRun(), { ...expected, runId: "9999" }))).toBe("release-run-id-mismatch");
  expect(refusal(() => parseReleaseRun(releaseRun(), { ...expected, runAttempt: "1" }))).toBe("release-run-attempt-mismatch");
  // The draft job runs inside its own open run; an unfinished run is not automatically a failure.
  expect(parseReleaseRun(releaseRun({ status: "in_progress", conclusion: null }), { ...expected, requireSuccess: false }).id).toBe("1234");
});

test("successful release run selection ignores foreign runs and prefers the newest attempt", () => {
  const foreign = releaseRun({ id: 1, head_sha: MAIN_SHA });
  const failed = releaseRun({ id: 2, conclusion: "failure" });
  const older = releaseRun({ id: 3, run_attempt: 1 });
  const newer = releaseRun({ id: 3, run_attempt: 3 });
  expect(selectReleaseRun([foreign, failed, older, newer], { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA }).run_attempt).toBe(3);
  expect(refusal(() => selectReleaseRun([], { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA }))).toBe("release-run-missing");
  expect(refusal(() => selectReleaseRun([foreign], { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA }))).toBe("release-run-missing");
  expect(refusal(() => selectReleaseRun([failed], { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA }))).toBe("release-run-not-successful");
  expect(refusal(() => selectReleaseRun([releaseRun({ status: "in_progress", conclusion: null })], { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA }))).toBe("release-run-pending");
  expect(refusal(() => selectReleaseRun({}, { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA }))).toBe("release-runs-unreadable");
});

test("the draft job reads only a successful build job from this exact attempt", () => {
  const job = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 55, name: "verify", run_id: 1234, run_attempt: 2, head_sha: TAG_SHA, status: "completed", conclusion: "success", ...patch });
  const expected = { runId: "1234", runAttempt: "2", tagSha: TAG_SHA };
  expect(parseBuildJob({ jobs: [job()] }, expected)).toEqual({ id: "55", name: "verify", conclusion: "success" });
  expect(parseBuildJob([job()], expected).id).toBe("55");
  expect(refusal(() => parseBuildJob({ jobs: [job({ conclusion: "failure" })] }, expected))).toBe("release-build-job-not-successful");
  expect(refusal(() => parseBuildJob({ jobs: [job({ status: "in_progress", conclusion: null })] }, expected))).toBe("release-build-job-pending");
  expect(refusal(() => parseBuildJob({ jobs: [job({ run_attempt: 1 })] }, expected))).toBe("release-build-job-missing");
  expect(refusal(() => parseBuildJob({ jobs: [job({ head_sha: MAIN_SHA })] }, expected))).toBe("release-build-job-missing");
  expect(refusal(() => parseBuildJob({ jobs: [job({ name: "draft" })] }, expected))).toBe("release-build-job-missing");
  expect(refusal(() => parseBuildJob({ jobs: [job(), job({ id: 56 })] }, expected))).toBe("release-build-job-ambiguous");
  expect(refusal(() => parseBuildJob({}, expected))).toBe("release-build-jobs-unreadable");
});

test("prepublish artifact identity keeps the attempt that uploaded it, not the rerun attempt", () => {
  expect(parsePrepublishArtifactName("prepublish-v1.2.3-1234-1", "v1.2.3", "1234")).toBe("1");
  // The promote job's own attempt may be higher after `rerun --failed`; the artifact name is
  // the only durable record of the attempt that actually sealed the receipt.
  expect(parsePrepublishArtifactName("prepublish-v1.2.3-1234-2", "v1.2.3", "1234")).toBe("2");
  for (const invalid of ["release-v1.2.3-1234-1", "prepublish-v1.2.3-9999-1", "prepublish-v1.2.4-1234-1", "prepublish-v1.2.3-1234-", "prepublish-v1.2.3-1234-0", ""]) {
    expect(refusal(() => parsePrepublishArtifactName(invalid, "v1.2.3", "1234"))).toBe("release-artifact-name-mismatch");
  }
  expect(refusal(() => parsePrepublishArtifactName("1.2.3", "1.2.3", "1234"))).toBe("release-tag-invalid");
});

test("the build attempt is derived from the artifact name and must match the manifest", () => {
  expect(parseReleaseArtifactName("release-v1.2.3-1234-2", "v1.2.3", "1234")).toBe("2");
  // A rerun of only the privileged job increments the run attempt; the artifact keeps the
  // attempt that produced it, so the name is the only durable source of that number.
  expect(parseReleaseArtifactName("release-v1.2.3-1234-1", "v1.2.3", "1234")).toBe("1");
  for (const invalid of ["release-v1.2.3-9999-2", "prepublish-v1.2.3-1234-2", "release-v1.2.4-1234-2", "release-v1.2.3-1234-", "release-v1.2.3-1234-0", "release-v1.2.3-1234-2x", ""]) {
    expect(refusal(() => parseReleaseArtifactName(invalid, "v1.2.3", "1234"))).toBe("release-artifact-name-mismatch");
  }
  const good = manifest([
    { name: "omp-settings-ru-1.2.3.tgz", sha256: HASH },
    { name: "SHA256SUMS", sha256: OTHER_HASH },
    { name: "marketplace.json", sha256: HASH },
  ]);
  const expected = { repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", releaseSha: TAG_SHA, runId: "1234" };
  expect(bindReleaseArtifact(good, { ...expected, artifactName: "release-v1.2.3-1234-2" }).runAttempt).toBe("2");
  // The pair is refused in both directions: an artifact from another attempt and a manifest
  // whose run/attempt disagrees with the artifact that carried it.
  expect(refusal(() => bindReleaseArtifact(good, { ...expected, artifactName: "release-v1.2.3-1234-1" }))).toBe("release-manifest-run");
  expect(refusal(() => bindReleaseArtifact({ ...good, runAttempt: "3" }, { ...expected, artifactName: "release-v1.2.3-1234-2" }))).toBe("release-manifest-run");
  expect(refusal(() => bindReleaseArtifact({ ...good, runId: "9999" }, { ...expected, artifactName: "release-v1.2.3-1234-2" }))).toBe("release-manifest-run");
  expect(refusal(() => bindReleaseArtifact(good, { ...expected, artifactName: "release-v1.2.3-9999-2" }))).toBe("release-artifact-name-mismatch");
  expect(refusal(() => bindReleaseArtifact(good, { ...expected, artifactName: undefined as unknown as string }))).toBe("release-artifact-name-mismatch");
});

test("artifact proof binds immutable id, attempt-bearing name, run and head", () => {
  const expected = { name: "release-v1.2.3-1234-2", id: 77, runId: "1234", headSha: TAG_SHA };
  expect(parseArtifact(artifact(), expected)).toMatchObject({ id: 77, name: expected.name, runId: "1234" });
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ id: 78 }, "release-artifact-id-mismatch"],
    [{ name: "release-v1.2.3-1234-1" }, "release-artifact-name-mismatch"],
    [{ name: "prepublish-v1.2.3-1234-2" }, "release-artifact-name-mismatch"],
    [{ expired: true }, "release-artifact-expired"],
    [{ size_in_bytes: 0 }, "release-artifact-size-invalid"],
    [{ digest: "sha256:not-a-digest" }, "release-artifact-digest-invalid"],
    [{ workflow_run: { id: 9999, head_sha: TAG_SHA } }, "release-artifact-run-mismatch"],
    [{ workflow_run: { id: 1234, head_sha: MAIN_SHA } }, "release-artifact-head-mismatch"],
  ];
  for (const [patch, reason] of cases) expect(refusal(() => parseArtifact(artifact(patch), expected))).toBe(reason);
  expect(parseArtifact(artifact({ digest: null }), expected).id).toBe(77);
  expect(refusal(() => parseArtifact({}, expected))).toBe("release-artifact-id-invalid");
});

test("asset manifest hashes are checked against the downloaded bytes, including SHA256SUMS", () => {
  const archiveHash = sha256Bytes(new TextEncoder().encode("archive"));
  const bytes = new Map([
    ["omp-settings-ru-1.2.3.tgz", new TextEncoder().encode("archive")],
    ["SHA256SUMS", new TextEncoder().encode(`${archiveHash}  omp-settings-ru-1.2.3.tgz\n`)],
    ["marketplace.json", new TextEncoder().encode("{}")],
  ]);
  const sumsHash = sha256Bytes(bytes.get("SHA256SUMS")!);
  const catalogHash = sha256Bytes(bytes.get("marketplace.json")!);
  const good = manifest([
    { name: "omp-settings-ru-1.2.3.tgz", sha256: archiveHash },
    { name: "SHA256SUMS", sha256: sumsHash },
    { name: "marketplace.json", sha256: catalogHash },
  ]);
  expect(archiveChecksumFromSums(bytes.get("SHA256SUMS")!, "omp-settings-ru-1.2.3.tgz")).toBe(archiveHash);
  expect(refusal(() => verifyManifestAssets(good, bytes))).toBe("accepted");
  expect(refusal(() => verifyManifestAssets(good, new Map([...bytes].filter(([name]) => name !== "SHA256SUMS"))))).toBe("release-asset-missing:SHA256SUMS");
  const tampered = new Map(bytes);
  tampered.set("marketplace.json", new TextEncoder().encode("{\"tampered\":true}"));
  expect(refusal(() => verifyManifestAssets(good, tampered))).toBe("release-asset-hash-mismatch:marketplace.json");
  const parsed = parseReleaseManifest(JSON.parse(JSON.stringify(good)), { repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", releaseSha: TAG_SHA, runId: "1234", runAttempt: "2" });
  expect(parsed.assets.map(asset => asset.name)).toEqual(["omp-settings-ru-1.2.3.tgz", "SHA256SUMS", "marketplace.json"]);
  const expectedManifest = { repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", releaseSha: TAG_SHA, runId: "1234", runAttempt: "2" };
  expect(refusal(() => parseReleaseManifest({ ...good, runAttempt: "1" }, expectedManifest))).toBe("release-manifest-run");
  expect(refusal(() => parseReleaseManifest({ ...good, runId: "9999" }, expectedManifest))).toBe("release-manifest-run");
  expect(refusal(() => parseReleaseManifest({ ...good, releaseSha: MAIN_SHA }, expectedManifest))).toBe("release-manifest-sha");
  expect(refusal(() => parseReleaseManifest({ ...good, repository: "someone/else" }, expectedManifest))).toBe("release-manifest-repository");
  expect(refusal(() => parseReleaseManifest({ ...good, assets: [good.assets[0]!, good.assets[0]!, good.assets[1]!] }, expectedManifest))).toBe("release-manifest-assets");
  expect(refusal(() => parseReleaseManifest({ ...good, version: "1.2.4" }, { repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", releaseSha: TAG_SHA, runId: "1234", runAttempt: "2" }))).toBe("release-manifest-tag");
  expect(refusal(() => parseReleaseManifest({ ...good, assets: good.assets.map(asset => asset.name === "SHA256SUMS" ? { ...asset, sha256: "short" } : asset) }, { repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", releaseSha: TAG_SHA, runId: "1234", runAttempt: "2" }))).toBe("release-manifest-asset-hash");
  expect(refusal(() => parseReleaseManifest({ ...good, assets: [...good.assets, { name: "foreign.txt", sha256: HASH }] }, { repository: REPOSITORY, tag: "v1.2.3", version: "1.2.3", releaseSha: TAG_SHA, runId: "1234", runAttempt: "2" }))).toBe("release-manifest-assets");
});

test("a partial draft uploads only the missing assets and never rewrites a matching one", () => {
  const existing = [{ name: "omp-settings-ru-1.2.3.tgz", digest: `sha256:${HASH}` }, { name: "SHA256SUMS", digest: null }, { name: "marketplace.json", digest: null }].filter(asset => asset.digest !== null);
  const plan = planReleaseAssets(existing, wanted, false, true);
  expect(plan.action).toBe("resume");
  expect(plan.upload.map(asset => asset.name)).toEqual(["SHA256SUMS", "marketplace.json"]);
  expect(plan.skip).toEqual(["omp-settings-ru-1.2.3.tgz"]);
  expect(planReleaseAssets([], wanted, false, false)).toEqual({ action: "create", upload: wanted, skip: [] });
  // A draft created by an interrupted attempt is resumed, never re-created.
  expect(planReleaseAssets([], wanted, false, true)).toEqual({ action: "resume", upload: wanted, skip: [] });
  const complete = wanted.map(asset => ({ name: asset.name, digest: `sha256:${asset.sha256}` }));
  expect(planReleaseAssets(complete, wanted, false, true)).toEqual({ action: "identical", upload: [], skip: wanted.map(asset => asset.name) });
});

test("conflicting, foreign, ambiguous and published assets are refused before any write", () => {
  const complete = wanted.map(asset => ({ name: asset.name, digest: `sha256:${asset.sha256}` }));
  expect(refusal(() => planReleaseAssets([{ name: "omp-settings-ru-1.2.3.tgz", digest: `sha256:${"e".repeat(64)}` }], wanted, false, true))).toBe("release-asset-conflict:omp-settings-ru-1.2.3.tgz");
  expect(refusal(() => planReleaseAssets([...complete, { name: "foreign.txt", digest: `sha256:${HASH}` }], wanted, false, true))).toBe("release-asset-foreign:foreign.txt");
  expect(refusal(() => planReleaseAssets([complete[0]!, complete[0]!], wanted, false, true))).toBe("release-assets-ambiguous:omp-settings-ru-1.2.3.tgz");
  expect(refusal(() => planReleaseAssets([{ name: "SHA256SUMS", digest: null }], wanted, false, true))).toBe("release-asset-digest-unavailable:SHA256SUMS");
  expect(refusal(() => planReleaseAssets([], wanted, true, true))).toBe("release-published-asset-missing:omp-settings-ru-1.2.3.tgz");
  expect(planReleaseAssets(complete, wanted, true, true)).toEqual({ action: "identical", upload: [], skip: wanted.map(asset => asset.name) });
});

test("the tag package identity must match the tag version and carry an exact host pin", () => {
  expect(packageIdentity({ version: "1.2.3", devDependencies: { "@oh-my-pi/pi-coding-agent": "18.8.7" } }, "1.2.3")).toEqual({ version: "1.2.3", hostVersion: "18.8.7" });
  expect(refusal(() => packageIdentity({ version: "1.2.4", devDependencies: { "@oh-my-pi/pi-coding-agent": "18.8.7" } }, "1.2.3"))).toBe("release-package-version-mismatch");
  expect(refusal(() => packageIdentity({ version: "1.2.3", devDependencies: { "@oh-my-pi/pi-coding-agent": "^18.8.7" } }, "1.2.3"))).toBe("release-host-version-invalid");
  expect(refusal(() => packageIdentity({}, "1.2.3"))).toBe("release-package-version-invalid");
});

function git(directory: string, args: readonly string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git failed: ${args.join(" ")}`);
  return new TextDecoder().decode(child.stdout).trim();
}

test("the release commit must sit on trusted main and its package identity is read from git objects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-release-git-"));
  try {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", devDependencies: { "@oh-my-pi/pi-coding-agent": "18.8.7" } }));
    git(directory, ["init", "-b", "main"]);
    git(directory, ["config", "user.name", "Proof"]);
    git(directory, ["config", "user.email", "proof@example.invalid"]);
    git(directory, ["add", "."]);
    git(directory, ["commit", "-m", "release"]);
    const releaseSha = git(directory, ["rev-parse", "HEAD"]);
    await writeFile(join(directory, "src", "later.ts"), "export const later = true;\n");
    git(directory, ["add", "."]);
    git(directory, ["commit", "-m", "later"]);
    git(directory, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(assertTrustedMain(directory)).toBe(git(directory, ["rev-parse", "HEAD"]));
    expect(refusal(() => assertReleaseAncestor(directory, releaseSha))).toBe("accepted");
    expect(packageAtCommit(directory, releaseSha, "1.2.3")).toEqual({ version: "1.2.3", hostVersion: "18.8.7" });
    // A commit that is not on the checked-out main is refused even when a tag points at it.
    git(directory, ["checkout", "--orphan", "detached"]);
    git(directory, ["rm", "-rf", "."]);
    await writeFile(join(directory, "only.txt"), "orphan\n");
    git(directory, ["add", "."]);
    git(directory, ["commit", "-m", "orphan"]);
    expect(refusal(() => assertReleaseAncestor(directory, releaseSha))).toBe("release-sha-not-on-main");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the seal exists only after a successful distribution smoke and proofs the exact catalog", () => {
  const catalog = new TextEncoder().encode("{\"catalog\":true}");
  const sealed = sealPrepublishReceipt(evidence(catalog), catalog, successfulSmoke);
  expect(sealed.smoke).toBe("distribution-smoke");
  expect(parsePrepublishReceipt(sealed)).toEqual(sealed);
  // Evidence alone is not a receipt: the smoke step has not sealed it yet.
  expect(refusal(() => parsePrepublishReceipt(evidence(catalog)))).toBe("prepublish-receipt-invalid");
  expect(refusal(() => parsePrepublishReceipt(parsePrepublishEvidence(evidence(catalog))))).toBe("prepublish-receipt-invalid");
  expect(refusal(() => sealPrepublishReceipt(evidence(catalog), catalog, { ...successfulSmoke, failed: "native-command-failed" }))).toBe("prepublish-smoke-failed");
  expect(refusal(() => sealPrepublishReceipt(evidence(catalog), catalog, { ...successfulSmoke, personalProfileChanged: true }))).toBe("prepublish-smoke-untrusted");
  expect(refusal(() => sealPrepublishReceipt(evidence(catalog), catalog, { ...successfulSmoke, observations: [] }))).toBe("prepublish-smoke-unproven");
  expect(refusal(() => sealPrepublishReceipt(evidence(catalog), new TextEncoder().encode("changed"), successfulSmoke))).toBe("prepublish-catalog-changed");
  expect(refusal(() => parsePrepublishReceipt({ ...sealed, smokePassed: false }))).toBe("prepublish-smoke-unproven");
  const expected = { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA, releaseRunId: "1234", releaseRunAttempt: "2" };
  expect(promotionErrors(sealed, expected)).toEqual([]);
  expect(promotionErrors(sealed, { ...expected, tagSha: MAIN_SHA })).toEqual(["promotion-sha-mismatch"]);
  expect(promotionErrors(sealed, { ...expected, releaseRunAttempt: "1" })).toEqual(["promotion-release-run-mismatch"]);
});

test("marketplace promotion run origin distinguishes a tag-triggered run from a main dispatch", () => {
  const expected = { repository: REPOSITORY };
  const triggered = { id: 88, run_attempt: 1, path: ".github/workflows/marketplace-index.yml", event: "workflow_run", head_sha: TAG_SHA, head_branch: "v1.2.3", repository: { full_name: REPOSITORY } };
  expect(parseMarketplaceRunOrigin(triggered, expected)).toMatchObject({ event: "workflow_run", headSha: TAG_SHA, headBranch: "v1.2.3" });
  // A workflow_run run's own head follows the default-branch rules, so it is not a tag proof;
  // the sealed receipt and the separately proven release run carry the tag binding.
  expect(parseMarketplaceRunOrigin({ ...triggered, head_sha: MAIN_SHA, head_branch: "main" }, expected)).toMatchObject({ event: "workflow_run", headSha: MAIN_SHA });
  expect(refusal(() => parseMarketplaceRunOrigin({ ...triggered, event: "push" }, expected))).toBe("marketplace-run-event-invalid");
  expect(refusal(() => parseMarketplaceRunOrigin({ ...triggered, path: ".github/workflows/release.yml" }, expected))).toBe("marketplace-run-workflow-mismatch");
  expect(refusal(() => parseMarketplaceRunOrigin({ ...triggered, repository: { full_name: "someone/else" } }, expected))).toBe("marketplace-run-repository-mismatch");
  const manual = { ...triggered, event: "workflow_dispatch", head_sha: MAIN_SHA, head_branch: "main" };
  expect(parseMarketplaceRunOrigin(manual, expected)).toMatchObject({ event: "workflow_dispatch", headBranch: "main" });
  // A manual dispatch from the tag itself is not the documented main+tag recovery path.
  expect(refusal(() => parseMarketplaceRunOrigin({ ...manual, head_branch: "v1.2.3" }, expected))).toBe("marketplace-run-ref-invalid");
});

test("post-publication proof requires the latest release to serve exactly the tag catalog", () => {
  const catalog = buildMarketplaceCatalog({ version: "1.2.3", commitSha: TAG_SHA, repository: REPOSITORY, description: "Русский перевод /settings" });
  const bytes = new TextEncoder().encode(JSON.stringify(catalog, null, 2));
  const digest = sha256Bytes(bytes);
  const release = {
    tag_name: "v1.2.3", draft: false, prerelease: false, published_at: "2026-10-24T00:00:00Z",
    assets: [
      { name: "omp-settings-ru-1.2.3.tgz", digest: `sha256:${HASH}` },
      { name: "SHA256SUMS", digest: `sha256:${OTHER_HASH}` },
      { name: "marketplace.json", digest: `sha256:${digest}` },
    ],
  };
  expect(servedProofErrors(release, bytes, { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA })).toEqual([]);
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ tag_name: "v1.2.4" }, "marketplace-served-release-tag-mismatch"],
    [{ draft: true }, "marketplace-served-release-draft"],
    [{ prerelease: true }, "marketplace-served-release-prerelease"],
    [{ published_at: null }, "marketplace-served-release-unpublished"],
    [{ assets: [] }, "marketplace-served-catalog-ambiguous"],
    [{ assets: release.assets.map(asset => asset.name === "marketplace.json" ? { ...asset, digest: `sha256:${HASH}` } : asset) }, "marketplace-served-catalog-digest-mismatch"],
  ];
  for (const [patch, reason] of cases) expect(servedProofErrors({ ...release, ...patch }, bytes, { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA })).toContain(reason);
  expect(servedProofErrors(null, bytes, { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA })).toEqual(["marketplace-served-release-unreadable"]);
  expect(servedProofErrors({}, bytes, { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA })).toContain("marketplace-served-release-tag-mismatch");
  expect(servedProofErrors(release, new TextEncoder().encode("not json"), { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA })).toContain("marketplace-served-catalog-digest-mismatch");
  const wrong = { ...catalog, plugins: [{ ...catalog.plugins[0]!, source: { ...catalog.plugins[0]!.source, sha: MAIN_SHA } }] };
  const wrongBytes = new TextEncoder().encode(JSON.stringify(wrong, null, 2));
  const wrongDigest = sha256Bytes(wrongBytes);
  const wrongRelease = { ...release, assets: [...release.assets.slice(0, 2), { name: "marketplace.json", digest: `sha256:${wrongDigest}` }] };
  expect(servedProofErrors(wrongRelease, wrongBytes, { repository: REPOSITORY, tag: "v1.2.3", tagSha: TAG_SHA })).toContain("marketplace-served-sha-mismatch");
});

test("a release row keeps the draft/published distinction and exposes asset digests", () => {
  const draft = parseReleaseRow({ tag_name: "v1.2.3", draft: true, published_at: null, assets: [{ id: 1, name: "marketplace.json", digest: `sha256:${HASH}` }] }, "v1.2.3");
  expect(draft).toMatchObject({ draft: true, published: false });
  expect(draft.assets).toEqual([{ name: "marketplace.json", digest: `sha256:${HASH}` }]);
  expect(parseReleaseRow({ tag_name: "v1.2.3", draft: false, published_at: "2026-10-24T00:00:00Z", assets: [] }, "v1.2.3").published).toBe(true);
  expect(refusal(() => parseReleaseRow({ tag_name: "v1.2.3", draft: false, published_at: null, assets: [] }, "v1.2.3"))).toBe("release-state-invalid");
  expect(refusal(() => parseReleaseRow({ tag_name: "v1.2.4", draft: true, published_at: null, assets: [] }, "v1.2.3"))).toBe("release-tag-mismatch");
  expect(refusal(() => parseReleaseRow({ tag_name: "v1.2.3", draft: true, prerelease: true, published_at: null, assets: [] }, "v1.2.3"))).toBe("release-prerelease");
});

test("a release row refuses foreign and duplicate assets by name", () => {
  const names = ["omp-settings-ru-1.2.3.tgz", "SHA256SUMS", "marketplace.json"];
  const row = (assets: readonly string[]): ReleaseRow => parseReleaseRow({
    tag_name: "v1.2.3", draft: true, published_at: null,
    assets: assets.map((name, index) => ({ id: index + 1, name, digest: `sha256:${HASH}` })),
  }, "v1.2.3");
  expect(releaseNamingErrors(row(names), names)).toEqual([]);
  expect(releaseNamingErrors(row([...names, "foreign.txt"]), names)).toEqual(["release-asset-foreign:foreign.txt"]);
  expect(releaseNamingErrors(row(["SHA256SUMS", "SHA256SUMS"]), names)).toEqual(["release-assets-ambiguous:SHA256SUMS", "release-asset-missing:omp-settings-ru-1.2.3.tgz", "release-asset-missing:marketplace.json"]);
  expect(releaseNamingErrors(row([]), names)).toEqual(names.map(name => `release-asset-missing:${name}`));
});

function draftRow(assets: readonly { name: string; digest: string | null }[], patch: Record<string, unknown> = {}): ReleaseRow {
  return parseReleaseRow({
    tag_name: "v1.2.3", draft: true, published_at: null,
    assets: assets.map((asset, index) => ({ id: index + 1, ...asset })), ...patch,
  }, "v1.2.3");
}

const completeDraft = () => draftRow(wanted.map(asset => ({ name: asset.name, digest: `sha256:${asset.sha256}` })));

/** A deterministic clock: `sleep` advances time, so the bounded wait never sleeps for real. */
function fakeClock(start = 1_000) {
  let time = start;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    elapsed: () => time - start,
    sleeps,
  };
}

test("a draft that GitHub only reports on a later read is accepted within the bound", async () => {
  expect(DRAFT_OBSERVABILITY_TIMEOUT_MS).toBe(60_000);
  const complete = completeDraft();
  const reads: (ReleaseRow | undefined)[] = [undefined, undefined, complete];
  let calls = 0;
  const clock = fakeClock();
  const settled = await observeDraftRelease(() => reads[Math.min(calls++, reads.length - 1)], wanted, DRAFT_OBSERVABILITY_TIMEOUT_MS, clock.sleep, clock.now);
  expect(settled).toEqual(complete);
  expect(calls).toBe(3);
  expect(clock.elapsed()).toBeLessThanOrEqual(DRAFT_OBSERVABILITY_TIMEOUT_MS);
  // A draft whose assets lag behind the release itself is the same slow read, not a failure.
  const assetsLag = fakeClock();
  const lagging: (ReleaseRow | undefined)[] = [draftRow([{ name: "SHA256SUMS", digest: `sha256:${OTHER_HASH}` }]), complete];
  let laggedCalls = 0;
  expect(await observeDraftRelease(() => lagging[Math.min(laggedCalls++, 1)], wanted, 60_000, assetsLag.sleep, assetsLag.now)).toEqual(complete);
  expect(laggedCalls).toBe(2);
});

test("a draft that never becomes observable fails inside the bound instead of hanging", async () => {
  const missing = fakeClock();
  let calls = 0;
  const read = () => { calls += 1; return undefined; };
  await expect(observeDraftRelease(read, wanted, 30_000, missing.sleep, missing.now)).rejects.toThrow("release-draft-not-observable");
  expect(missing.elapsed()).toBeLessThanOrEqual(30_000);
  expect(calls).toBeGreaterThan(1);
  // A visible draft that permanently misses assets reports exactly which ones.
  const partial = fakeClock();
  const short = () => draftRow([{ name: "SHA256SUMS", digest: null }]);
  await expect(observeDraftRelease(short, wanted, 10_000, partial.sleep, partial.now)).rejects.toThrow("release-resume-incomplete:release-asset-missing:omp-settings-ru-1.2.3.tgz,release-asset-conflict:SHA256SUMS,release-asset-missing:marketplace.json");
  expect(partial.elapsed()).toBeLessThanOrEqual(10_000);
  // A release that is already published was written by someone else: waiting cannot fix it.
  const published = fakeClock();
  let publishedCalls = 0;
  const readPublished = () => { publishedCalls += 1; return draftRow([], { draft: false, published_at: "2026-10-24T00:00:00Z" }); };
  await expect(observeDraftRelease(readPublished, wanted, 60_000, published.sleep, published.now)).rejects.toThrow("release-draft-not-observable");
  expect(publishedCalls).toBe(1);
  expect(published.sleeps).toEqual([]);
  for (const invalid of [-1, 1.5, Number.NaN]) {
    await expect(observeDraftRelease(() => completeDraft(), wanted, invalid, published.sleep, published.now)).rejects.toThrow("release-wait-invalid");
  }
});

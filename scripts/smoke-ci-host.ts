import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPackageArchive, runInstalledSmoke, validateArtifactReceipt, verifyArtifactBinding } from "./installed-smoke";

/** npm emits either an array envelope or a package-name keyed object for pack listings. */
export function parsePackFilename(payload: unknown): string {
  const candidates = Array.isArray(payload) ? payload : payload && typeof payload === "object" ? Object.values(payload as Record<string, unknown>) : [];
  for (const candidate of candidates) {
    const filename = (candidate as {filename?: unknown} | null)?.filename;
    if (typeof filename === "string" && /^[A-Za-z0-9_.-]+\.tgz$/.test(filename)) return filename;
  }
  throw new Error("pack-listing-invalid");
}

/** Select this job's own in-progress check run; never guess, and refuse ambiguous, truncated or foreign listings.
 *  `commitSha` is the commit the workflow actually runs against (GITHUB_SHA), which on pull_request is the
 *  synthetic merge commit - not the reviewed PR head the receipt binds as its source identity. */
export function selectCheckRun(payload: unknown, expected: {repository: string; commitSha: string; runId: string; jobName: string}): number {
  const rows = (payload as {check_runs?: unknown} | null)?.check_runs;
  const total = (payload as {total_count?: unknown} | null)?.total_count;
  if (!Array.isArray(rows)) throw new Error("check-run-payload-invalid");
  // A complete listing is required: an absent or inconsistent total cannot prove we saw this job's row.
  if (!Number.isSafeInteger(total) || total !== rows.length) throw new Error("check-run-listing-truncated");
  const matches = rows.filter(row => {
    const details = (row as {details_url?: unknown}).details_url;
    const expectedUrl = `/actions/runs/${expected.runId}/job/`;
    return (row as {status?: unknown}).status === "in_progress" && (row as {head_sha?: unknown}).head_sha === expected.commitSha && (row as {name?: unknown}).name === expected.jobName && typeof details === "string" && details.startsWith(`https://github.com/${expected.repository}${expectedUrl}`);
  });
  if (matches.length === 0) throw new Error("check-run-unavailable");
  if (matches.length > 1) throw new Error("check-run-ambiguous");
  const id = (matches[0] as {id?: unknown}).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("check-run-unavailable");
  return id;
}

async function main(): Promise<void> {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("exact-host-version-required");
  // The reviewed source head is the artifact identity; never the synthetic pull-request merge commit.
  const sourceHead = process.env.OMP_SOURCE_HEAD ?? "";
  // The workflow commit is what this job's own check run is attached to (on pull_request, the merge commit).
  const workflowHead = process.env.OMP_WORKFLOW_HEAD ?? process.env.GITHUB_SHA ?? "";
  const workflowRunId = process.env.GITHUB_RUN_ID ?? "";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
  const checkName = process.env.OMP_CHECK_NAME ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error("source-head-unavailable");
  if (!/^[a-f0-9]{40}$/.test(workflowHead)) throw new Error("workflow-head-unavailable");
  if (!workflowRunId || !runAttempt) throw new Error("github-run-unavailable");
  if (!checkName || !repository) throw new Error("github-check-context-unavailable");
  const sourceDirectory = process.cwd();
  const treeHash = Bun.spawnSync(["git", "rev-parse", `${sourceHead}^{tree}`], {cwd: sourceDirectory, stdout: "pipe", stderr: "pipe", timeout: 30000}).stdout.toString().trim();
  if (!/^[a-f0-9]{40}$/.test(treeHash)) throw new Error("source-tree-unavailable");
  const workspace = await mkdtemp(join(tmpdir(), "omp-ci-smoke-"));
  // Windows needs cmd for npm.cmd; forward-slash paths avoid cmd quote mangling (a backslash path with quotes breaks npm).
  const packCommand = process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", `npm.cmd pack --ignore-scripts --json --pack-destination ${workspace.replaceAll("\\", "/")}`]
    : ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", workspace];
  const packed = Bun.spawnSync(packCommand, {cwd: sourceDirectory, stdout: "pipe", stderr: "pipe", timeout: 120000});
  if (packed.exitCode !== 0) throw new Error("package-pack-failed:" + packed.stderr.toString().slice(-2000));
  const archivePath = join(workspace, parsePackFilename(JSON.parse(packed.stdout.toString())));
  const archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  const verified = await verifyArtifactBinding({sourceDirectory, archivePath, headSha: sourceHead, treeHash, archiveSha256});
  // The receipt binding is composed from the extraction that actually re-hashed the written package bytes.
  const extracted = await extractPackageArchive({archivePath, targetDirectory: join(workspace, "package"), archiveSha256, contentHash: verified.contentHash});
  const binding = {...verified, contentHash: extracted.contentHash, fileCount: extracted.fileCount, extractionVerified: extracted.extractionVerified};
  const executableDirectory = await mkdtemp(join(tmpdir(), "omp-fixed-host-"));
  const name = process.platform === "win32" ? `omp-windows-${process.arch}.exe` : `omp-${process.platform}-${process.arch}`;
  const release = Bun.spawnSync(["gh", "api", `repos/can1357/oh-my-pi/releases/tags/v${version}`], {stdout: "pipe", stderr: "pipe", timeout: 30000});
  if (release.exitCode !== 0) throw new Error("fixed-host-release-unavailable");
  const metadata = JSON.parse(release.stdout.toString());
  const asset = metadata.assets.find((entry: {name: string}) => entry.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error("fixed-host-asset-digest-unavailable");
  const response = await fetch(asset.browser_download_url, {signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error("fixed-host-download-failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const executableSha256 = createHash("sha256").update(bytes).digest("hex");
  if (executableSha256 !== asset.digest.slice(7)) throw new Error("fixed-host-integrity-failed");
  const executable = join(executableDirectory, name);
  await writeFile(executable, bytes);
  if (process.platform !== "win32") await chmod(executable, 0o700);
  // Check runs bind to the commit the workflow ran against; the workflow run must be this run.
  const checks = Bun.spawnSync(["gh", "api", `repos/${repository}/commits/${workflowHead}/check-runs?per_page=100`], {stdout: "pipe", stderr: "pipe", timeout: 30000});
  if (checks.exitCode !== 0) throw new Error("check-run-lookup-failed");
  const checkRunId = selectCheckRun(JSON.parse(checks.stdout.toString()), {repository, commitSha: workflowHead, runId: workflowRunId, jobName: checkName});
  const smoke = await runInstalledSmoke({executable, pluginPath: extracted.directory, ownedProfile: `omp-settings-ru-proof-ci-${version.replaceAll(".", "-")}`, mode: "pre-activation"});
  const receipt = {
    schemaVersion: 1,
    version,
    platform: process.platform,
    native: true,
    passed: smoke.passed,
    checkRunId,
    checkRunHeadSha: workflowHead,
    workflowRunId,
    runAttempt,
    checkName,
    executable: {name, assetId: asset.id, sha256: executableSha256, releaseTag: `v${version}`},
    binding,
    smoke,
  };
  const verdict = validateArtifactReceipt(receipt, {version, platform: process.platform, headSha: sourceHead, treeHash, archiveSha256, contentHash: binding.contentHash, executableSha256, checkRunId, workflowRunId, runAttempt});
  if (!verdict.ok) throw new Error(verdict.reason);
  await Bun.write(`installed-smoke-${version}-${process.platform}.json`, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}

if (import.meta.main) await main();

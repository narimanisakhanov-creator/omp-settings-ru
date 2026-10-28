import { ensureCheckRun } from "./check-recovery";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { asRecord, parseStrictJSON } from "./json";
import { git, stableVersion, validateBundle } from "./actions-bundle";
import { HostedGitHub, maintenanceBody, type MaintenanceIdentity } from "./actions-github";
import { SUPPORTED_HOSTS } from "./paths";
import { validatePublishedCandidate } from "./actions-candidate";
import { parseArtifact, parseMarketplaceRunOrigin, parsePrepublishArtifactName, parsePrepublishReceipt } from "../release-actions";

export async function publishCandidate(checkout: string, root: string, github: HostedGitHub, artifactId: string): Promise<void> {
  const candidate = await validateBundle(root);
  if (candidate.runId !== process.env.GITHUB_RUN_ID || candidate.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error("publish-run-mismatch");
  await github.origin(candidate, artifactId);
  await validatePublishedCandidate(checkout, root, github.policy);
  const identity: MaintenanceIdentity = { schemaVersion: 1, repository: candidate.repository, upstreamVersion: candidate.upstreamVersion, releaseVersion: candidate.releaseVersion, baseSha: candidate.baseSha, headSha: candidate.headSha!, runId: candidate.runId, runAttempt: candidate.runAttempt, artifactId, manifestSha256: createHash("sha256").update(await readFile(join(root, "candidate.json"))).digest("hex") };
  const branch = `upgrade/omp-${candidate.upstreamVersion}`;
  const prs = await github.ownedPulls();
  const own = prs.find(row => row.identity.upstreamVersion === candidate.upstreamVersion);
  if (prs.some(row => row.pr.state === "open" && row !== own)) throw new Error("multiple-maintenance-prs");
  if (own) {
    if (JSON.stringify(own.identity) !== JSON.stringify(identity)) throw new Error("existing-pr-proof-conflict");
    if (own.pr.merged_at) return;
    if (await github.checks.remoteBranchHead(branch) !== candidate.headSha) throw new Error("existing-branch-conflict");
    if (own.pr.draft) await github.checks.markReady(Number(own.pr.number), candidate.headSha!);
    return;
  }
  if (await github.checks.mainSha() !== candidate.baseSha) throw new Error("candidate-base-drift");
  const remote = await github.checks.remoteBranchHead(branch);
  if (remote && remote !== candidate.headSha) throw new Error("unowned-upgrade-branch");
  // The authenticated exact artifact head can be this generation's completed push before PR creation.
  if (!remote) await github.push(checkout, candidate.headSha!, branch);
  if (await github.checks.remoteBranchHead(branch) !== candidate.headSha) throw new Error("candidate-push-not-observed");
  const created = asRecord(await github.api(`repos/${candidate.repository}/pulls`, { head: branch, base: "main", title: `Поддержка OMP ${candidate.upstreamVersion}`, body: maintenanceBody(identity), draft: true }));
  if (!created || typeof created.number !== "number" || asRecord(created.head)?.sha !== candidate.headSha || asRecord(created.base)?.sha !== candidate.baseSha) throw new Error("candidate-pr-not-observed");
  await github.checks.markReady(created.number, candidate.headSha!);
}
async function waitChecks(github: HostedGitHub, sha: string, versions: readonly string[], branch: string): Promise<void> {
  await ensureCheckRun(github, sha, versions, branch);
}
export async function workflowRecovery(github: HostedGitHub, path: "release.yml" | "marketplace-index.yml", tag: string, sha: string, recovered: Set<string>): Promise<boolean> {
  const root = `repos/${github.policy.repository}`;
  const query = path === "release.yml" ? `head_sha=${sha}` : "";
  const listed = await github.list(`${root}/actions/workflows/${path}/runs${query ? `?${query}` : ""}`, "workflow_runs");
  const tagBound = new Set<string>();
  let unknownBinding = false;
  let newestUnknownRun = 0;
  if (path === "marketplace-index.yml") for (const run of listed) {
    if (run.path !== ".github/workflows/marketplace-index.yml" || asRecord(run.repository)?.full_name !== github.policy.repository) continue;
    const origin = parseMarketplaceRunOrigin(run, { repository: github.policy.repository });
    const artifacts = await github.list(`${root}/actions/runs/${run.id}/artifacts`, "artifacts");
    const matching = artifacts.filter(artifact => typeof artifact.name === "string" && artifact.name.startsWith(`prepublish-${tag}-${origin.id}-`));
    for (const artifact of matching) {
      const attempt = parsePrepublishArtifactName(String(artifact.name), tag, origin.id);
      if (Number(attempt) > Number(origin.attempt)) throw new Error("publisher-artifact-attempt-invalid");
      parseArtifact(artifact, { name: String(artifact.name), id: Number(artifact.id), runId: origin.id, headSha: origin.headSha });
      const producer = asRecord(await github.api(`${root}/actions/runs/${origin.id}/attempts/${attempt}`));
      const producerOrigin = parseMarketplaceRunOrigin(producer, { repository: github.policy.repository });
      if (producerOrigin.id !== origin.id || producerOrigin.attempt !== attempt || producerOrigin.event !== origin.event
        || producerOrigin.headSha !== origin.headSha || producerOrigin.headBranch !== origin.headBranch) throw new Error("publisher-artifact-origin-invalid");
      const jobs = await github.list(`${root}/actions/runs/${origin.id}/attempts/${attempt}/jobs?filter=all`, "jobs");
      const prepublish = jobs.filter(job => job.name === "prepublish" && String(job.run_id) === origin.id
        && String(job.run_attempt) === attempt && job.head_sha === origin.headSha);
      const producerJob = prepublish[0];
      if (prepublish.length !== 1 || typeof producerJob?.id !== "number" || !Number.isSafeInteger(producerJob.id) || producerJob.id <= 0
        || producerJob.status !== "completed" || producerJob.conclusion !== "success") throw new Error("publisher-prepublish-job-not-successful");
      const directory = await mkdtemp(join(tmpdir(), "omp-prepublish-proof-"));
      try {
        await github.command(["run", "download", origin.id, "--repo", github.policy.repository, "--name", String(artifact.name), "--dir", directory]);
        const receipt = parsePrepublishReceipt(parseStrictJSON(await readFile(join(directory, "receipt.json"), "utf8")));
        if (receipt.repository !== github.policy.repository || receipt.tag !== tag || receipt.tagSha !== sha) throw new Error("publisher-receipt-binding-invalid");
        const release = asRecord(await github.api(`${root}/actions/runs/${receipt.releaseRunId}/attempts/${receipt.releaseRunAttempt}`));
        if (!release || String(release.id) !== receipt.releaseRunId || String(release.run_attempt) !== receipt.releaseRunAttempt
          || release.path !== ".github/workflows/release.yml" || asRecord(release.repository)?.full_name !== github.policy.repository
          || release.head_sha !== sha || release.head_branch !== tag || !["push", "workflow_dispatch"].includes(String(release.event))
          || release.status !== "completed" || release.conclusion !== "success") throw new Error("publisher-receipt-release-invalid");
      } finally { await rm(directory, { recursive: true, force: true }); }
      tagBound.add(origin.id);
    }
    // A title is only a deduplication hint. Missing proof is never permission to replace
    // a possibly related run with a fresh dispatch and thereby reset its durable budget.
    if (!tagBound.has(origin.id) && (run.display_title === `marketplace-index ${tag}` || artifacts.length === 0)) {
      unknownBinding = true;
      newestUnknownRun = Math.max(newestUnknownRun, Number(origin.id));
    }
  }
  const runs = listed.filter(run => {
    if (run.path !== `.github/workflows/${path}` || asRecord(run.repository)?.full_name !== github.policy.repository || !["push", "workflow_dispatch", "workflow_run"].includes(String(run.event))) return false;
    if (path === "release.yml") return run.head_sha === sha && run.head_branch === tag;
    return tagBound.has(String(run.id));
  });
  runs.sort((a, b) => Number(b.id) - Number(a.id));
  const run = runs[0];
  if (run && newestUnknownRun > Number(run.id)) return false;
  if (!run) {
    const title = path === "marketplace-index.yml" ? `marketplace-index ${tag}` : undefined;
    const duplicate = title && listed.some(row => row.display_title === title && row.status !== "completed");
    if (!recovered.has(path) && !duplicate && !unknownBinding) {
      await github.command(path === "release.yml" ? ["workflow", "run", path, "--repo", github.policy.repository, "--ref", tag] : ["workflow", "run", path, "--repo", github.policy.repository, "--ref", "main", "-f", `tag=${tag}`], true);
      recovered.add(path);
    }
    return false;
  }
  if (run.status !== "completed") return false;
  if (run.conclusion !== "success") {
    if (!["failure", "cancelled", "timed_out"].includes(String(run.conclusion))) throw new Error(`publisher-checks-blocked:${run.id}`);
    const attempt = Number(run.run_attempt);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt >= 3) throw new Error(`publisher-checks-retries-exhausted:${run.id}`);
    const key = `${path}:${run.id}:${attempt}`;
    if (!recovered.has(key)) {
      await github.command(["run", "rerun", String(run.id), "--repo", github.policy.repository, "--failed"], true);
      recovered.add(key);
    }
    return false;
  }
  if (path === "marketplace-index.yml") throw new Error("publisher-success-without-published-proof");
  return true;
}
export async function finalizeCandidate(checkout: string, version: string, github: HostedGitHub): Promise<"released" | "retired"> {
  if (!stableVersion.test(version)) throw new Error("finalize-version-invalid");
  const rows = await github.ownedPulls();
  const relevant = rows.filter(row => row.identity.upstreamVersion === version);
  if (relevant.length !== 1 || rows.filter(row => row.pr.state === "open").length > 1) throw new Error("maintenance-candidate-ambiguous");
  const { pr, identity } = relevant[0]!;
  let mergeSha = typeof pr.merge_commit_sha === "string" && pr.merged_at ? pr.merge_commit_sha : undefined;
  let versions: readonly string[];
  if (!mergeSha) {
    const artifact = asRecord(await github.api(`repos/${identity.repository}/actions/artifacts/${identity.artifactId}`));
    if (await github.checks.mainSha() !== identity.baseSha || artifact?.expired === true) {
      const run = asRecord(await github.api(`repos/${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`));
      if (!run || String(run.run_attempt) !== identity.runAttempt || run.path !== ".github/workflows/upstream-watch.yml" || run.head_sha !== identity.baseSha || run.head_branch !== "main" || asRecord(run.repository)?.full_name !== identity.repository) throw new Error("retirement-origin-invalid");
      if (await github.checks.remoteBranchHead(`upgrade/omp-${version}`) !== identity.headSha) throw new Error("retirement-head-conflict");
      await github.api(`repos/${identity.repository}/pulls/${pr.number}`, { state: "closed" }, "PATCH");
      await github.checks.deleteBranch(`upgrade/omp-${version}`);
      return "retired";
    }
  }
  if (!mergeSha) {
    const root = await github.download(identity);
    try {
      const candidate = await validatePublishedCandidate(checkout, root, github.policy);
      if (candidate.headSha !== identity.headSha || candidate.baseSha !== identity.baseSha || candidate.releaseVersion !== identity.releaseVersion) throw new Error("resume-candidate-conflict");
      const manifest = asRecord(parseStrictJSON(git(checkout, ["show", `${candidate.headSha}:${SUPPORTED_HOSTS}`])));
      if (!Array.isArray(manifest?.versions)) throw new Error("candidate-support-invalid");
      versions = manifest.versions.map(row => String(asRecord(row)?.version));
      await waitChecks(github, identity.headSha, versions, `upgrade/omp-${version}`);
      if (await github.checks.mainSha() !== identity.baseSha || await github.checks.remoteBranchHead(`upgrade/omp-${version}`) !== identity.headSha) throw new Error("candidate-base-or-head-drift");
      if (pr.draft) await github.checks.markReady(Number(pr.number), identity.headSha);
      mergeSha = (await github.checks.merge(Number(pr.number), identity.headSha)).mergeSha;
    } finally { await rm(dirname(root), { recursive: true, force: true }); }
  } else {
    const run = asRecord(await github.api(`repos/${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`));
    if (!run || String(run.run_attempt) !== identity.runAttempt || run.path !== ".github/workflows/upstream-watch.yml" || run.head_sha !== identity.baseSha || run.head_branch !== "main" || !["schedule", "workflow_dispatch"].includes(String(run.event)) || asRecord(run.repository)?.full_name !== identity.repository) throw new Error("resume-origin-invalid");
    git(checkout, ["fetch", "--no-tags", "origin", mergeSha]);
    const parents = git(checkout, ["rev-list", "--parents", "-n", "1", mergeSha]).split(" ");
    if (parents.length !== 3 || parents[1] !== identity.baseSha || parents[2] !== identity.headSha || git(checkout, ["rev-parse", `${mergeSha}^{tree}`]) !== git(checkout, ["rev-parse", `${identity.headSha}^{tree}`])) throw new Error("merged-candidate-ancestry-mismatch");
    const pkg = asRecord(parseStrictJSON(git(checkout, ["show", `${mergeSha}:package.json`])));
    const manifest = asRecord(parseStrictJSON(git(checkout, ["show", `${mergeSha}:${SUPPORTED_HOSTS}`])));
    if (pkg?.version !== identity.releaseVersion || !Array.isArray(manifest?.versions)) throw new Error("merged-release-identity-mismatch");
    versions = manifest.versions.map(row => String(asRecord(row)?.version));
  }
  const tag = `v${identity.releaseVersion}`;
  await waitChecks(github, mergeSha, versions, github.policy.baseBranch);
  const currentTag = await github.checks.tagTarget(tag);
  if (currentTag && currentTag !== mergeSha) throw new Error("release-tag-conflict");
  if (!currentTag) {
    if (await github.checks.mainSha() !== mergeSha) throw new Error("merge-main-drift");
    await github.checks.tag(tag, mergeSha);
  }
  const branch = `upgrade/omp-${version}`;
  const branchHead = await github.checks.remoteBranchHead(branch);
  if (branchHead && branchHead !== identity.headSha) throw new Error("cleanup-branch-head-conflict");
  if (branchHead) await github.checks.deleteBranch(branch);
  const deadline = Date.now() + github.policy.deadlinesMs.release;
  const recovered = new Set<string>();
  while (Date.now() < deadline) {
    const checkRun = await github.checks.checkWorkflowRun(mergeSha);
    if (checkRun.kind !== "found") throw new Error("release-check-run-unavailable");
    const proof = await github.checks.verifyPublishedRelease(tag, checkRun.runId, mergeSha);
    if (proof.kind === "found") {
      const latest = asRecord(await github.api(`repos/${identity.repository}/releases/latest`));
      if (latest?.tag_name !== tag || latest.draft !== false) throw new Error("published-release-not-latest");
      const response = await fetch(`https://github.com/${identity.repository}/releases/latest/download/marketplace.json`, { signal: AbortSignal.timeout(github.policy.deadlinesMs.command) });
      if (!response.ok) throw new Error("published-latest-catalog-unavailable");
      const catalog = asRecord(parseStrictJSON(await response.text()));
      const plugins = catalog?.plugins;
      if (!Array.isArray(plugins) || plugins.length !== 1 || asRecord(plugins[0])?.version !== identity.releaseVersion || asRecord(asRecord(plugins[0])?.source)?.sha !== mergeSha) throw new Error("published-latest-catalog-mismatch");
      return "released";
    }
    if (proof.kind === "blocked") throw new Error(proof.reason);
    const release = await github.checks.releaseState(tag);
    const releaseReady = await workflowRecovery(github, "release.yml", tag, mergeSha, recovered);
    if (release?.draft && release.assets.length >= 3 && releaseReady) await workflowRecovery(github, "marketplace-index.yml", tag, mergeSha, recovered);
    await Bun.sleep(15_000);
  }
  throw new Error("release-publication-timeout");
}

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asRecord, parseStrictJSON } from "./json";
import { git, stableVersion, validateBundle } from "./actions-bundle";
import { HostedGitHub, maintenanceBody, type MaintenanceIdentity } from "./actions-github";
import { SUPPORTED_HOSTS } from "./paths";
import { validatePublishedCandidate } from "./actions-candidate";

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
async function waitChecks(github: HostedGitHub, sha: string, versions: readonly string[]): Promise<void> {
  const deadline = Date.now() + github.policy.deadlinesMs.checks;
  while (Date.now() < deadline) {
    const verdict = github.checks.requiredChecksPassed(await github.checks.checksFor(sha), sha, versions);
    if (verdict.ok) return;
    if (!verdict.reason.startsWith("check-pending:") && !verdict.reason.startsWith("check-missing:")) throw new Error(verdict.reason);
    await Bun.sleep(15_000);
  }
  throw new Error("candidate-checks-timeout");
}
async function workflowRecovery(github: HostedGitHub, path: "release.yml" | "marketplace-index.yml", tag: string, sha: string, recovered: Set<string>): Promise<boolean> {
  const root = `repos/${github.policy.repository}`;
  const query = path === "release.yml" ? `head_sha=${sha}` : "";
  const listed = await github.list(`${root}/actions/workflows/${path}/runs${query ? `?${query}` : ""}`, "workflow_runs");
  const tagBound = new Set<string>();
  if (path === "marketplace-index.yml") for (const run of listed) {
    if (run.path !== ".github/workflows/marketplace-index.yml" || asRecord(run.repository)?.full_name !== github.policy.repository) continue;
    const artifacts = await github.list(`${root}/actions/runs/${run.id}/artifacts`, "artifacts");
    if (artifacts.some(artifact => artifact.name === `prepublish-${tag}-${run.id}-${run.run_attempt}` && artifact.expired === false && String(asRecord(artifact.workflow_run)?.id) === String(run.id))) tagBound.add(String(run.id));
  }
  const runs = listed.filter(run => {
    if (run.path !== `.github/workflows/${path}` || asRecord(run.repository)?.full_name !== github.policy.repository || !["push", "workflow_dispatch", "workflow_run"].includes(String(run.event))) return false;
    if (path === "release.yml") return run.head_sha === sha && run.head_branch === tag;
    // A publisher run is proven by the tag-scoped prepublish artifact of that exact run/attempt,
    // never by its own head: a workflow_run carries the source workflow head, and a manual
    // dispatch runs on main, whose head legitimately advances past the merged and tagged commit.
    if (!tagBound.has(String(run.id))) return false;
    if (run.event !== "workflow_dispatch") return true;
    if (run.head_branch !== "main") return false;
    const inputs = asRecord(run.inputs);
    if (typeof inputs?.tag === "string") return inputs.tag === tag;
    const titleTags = typeof run.display_title === "string" ? run.display_title.match(/v\d+\.\d+\.\d+(?:-[\w.-]+)?/g) ?? [] : [];
    return titleTags.length === 1 && titleTags[0] === tag;
  });
  runs.sort((a, b) => Number(b.id) - Number(a.id));
  const run = runs[0];
  if (!run) {
    if (!recovered.has(path)) {
      await github.command(path === "release.yml" ? ["workflow", "run", path, "--repo", github.policy.repository, "--ref", tag] : ["workflow", "run", path, "--repo", github.policy.repository, "--ref", "main", "-f", `tag=${tag}`], true);
      recovered.add(path);
    }
    return false;
  }
  if (run.status !== "completed") return false;
  if (run.conclusion !== "success") {
    const key = `${path}:${run.id}:${run.run_attempt}`;
    if (!recovered.has(key)) { await github.command(["run", "rerun", String(run.id), "--repo", github.policy.repository, "--failed"], true); recovered.add(key); }
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
      await waitChecks(github, identity.headSha, versions);
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
  await waitChecks(github, mergeSha, versions);
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

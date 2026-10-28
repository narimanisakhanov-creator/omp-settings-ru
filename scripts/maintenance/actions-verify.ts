import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControllerPolicy } from "./contracts";
import { candidatePaths, git, validateBundle, type Candidate } from "./actions-bundle";
import { applyCandidateData, completeSupport, createCandidateWorktree, removeCandidateWorktree, runTrusted, saveCandidateData } from "./actions-candidate";
import { collectSemanticEvidence, semanticPreflight, validateSemantic, type SemanticEvidence } from "./semantic";
import { trustedReleaseDocuments } from "./release-documents";
import { changedEntries, planPaths, intendedTree, commitApproved } from "./tree";
import { CATALOG_PATH } from "./catalog";
import { selectFixedHostAsset, verifyFixedHostBytes } from "../ci/prepare-host";
import { expectedLock } from "./measurement-environment";

/** Изменения рабочего дерева против политики: посторонний путь блокирует кандидата, а не игнорируется. */
function policyPaths(worktree: string, policy: ControllerPolicy, candidate: Candidate): readonly string[] {
  const paths = planPaths(changedEntries(worktree), policy, candidate.upstreamVersion);
  if (paths.rejected.length || paths.approved.some(path => !candidatePaths(candidate.upstreamVersion).includes(path))) throw new Error("candidate-path-outside-policy");
  return paths.approved;
}

export async function verifyCandidate(checkout: string, root: string, policy: ControllerPolicy, readToken?: string): Promise<Candidate> {
  const candidate = await validateBundle(root);
  if (candidate.headSha) throw new Error("candidate-already-verified");
  const worktree = await createCandidateWorktree(checkout, candidate.baseSha);
  let nativeRoot: string | undefined;
  try {
    await applyCandidateData(root, worktree, candidate);
    const versions = await completeSupport(worktree, candidate);
    // Reject all candidate-controlled package, support/history and measurement inputs before resolution.
    const inputPaths = policyPaths(worktree, policy, candidate);
    const preflight = await semanticPreflight(worktree, candidate.baseSha, candidate.upstreamVersion);
    if ("failure" in preflight) throw new Error(preflight.failure);
    const lockRoot = await mkdtemp(join(tmpdir(), "omp-actions-lock-"));
    try {
      const lock = await expectedLock({
        acceptedManifest: preflight.acceptedManifest,
        acceptedLock: git(worktree, ["show", `${candidate.baseSha}:bun.lock`]),
        delta: preflight.delta, scratch: join(lockRoot, "scratch"), cacheDir: join(lockRoot, "cache"),
        deadline: Date.now() + policy.deadlinesMs.verification,
      });
      if ("failure" in lock) throw new Error(lock.failure);
      await Bun.write(join(worktree, "bun.lock"), lock.lock);
    } finally { await rm(lockRoot, { recursive: true, force: true }); }
    const semantic = await collectSemanticEvidence(worktree, candidate.baseSha, candidate.upstreamVersion, versions, inputPaths, undefined, { deadlineMs: policy.deadlinesMs.verification });
    if ("failure" in semantic) throw new Error(semantic.failure);
    const verdict = validateSemantic(semantic, policy, undefined, true);
    if (!verdict.ok) throw new Error(verdict.reason);
    await runTrusted(worktree, ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], policy.deadlinesMs.verification);
    // Пользовательские документы строятся из уже измеренного: README — от измеренного покрытия, CHANGELOG и
    // отчёт — от каталогов базы/кандидата и снимков старой и новой версии. Ошибка генерации блокирует
    // кандидата, а не подменяется общей строкой выпуска.
    const documents = await trustedReleaseDocuments({ candidate, versions, coverage: semantic.coverage, source: { kind: "worktree", worktree } });
    await Bun.write(join(worktree, "README.md"), documents.readme);
    await Bun.write(join(worktree, "CHANGELOG.md"), documents.changelog);
    await Bun.write(join(worktree, "upgrade-report.md"), documents.report);
    // Окончательный набор путей — уже с тремя документами; второго измерения нет, потому что после первого
    // изменялись только эти документы, а их байты сверяет финальная проверка публикации.
    const finalPaths = policyPaths(worktree, policy, candidate);
    const evidence: SemanticEvidence = { ...semantic, changedPaths: finalPaths };
    const finalVerdict = validateSemantic(evidence, policy, undefined, true);
    if (!finalVerdict.ok) throw new Error(finalVerdict.reason);
    const releaseResponse = await fetch(`https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v${candidate.upstreamVersion}`, { headers: { Accept: "application/vnd.github+json", ...(readToken ? { Authorization: `Bearer ${readToken}` } : {}) }, signal: AbortSignal.timeout(policy.deadlinesMs.command), redirect: "error" });
    if (!releaseResponse.ok) throw new Error("native-release-unavailable");
    const asset = selectFixedHostAsset(await releaseResponse.json(), candidate.upstreamVersion, process.platform, process.arch);
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(policy.deadlinesMs.verification) });
    if (!response.ok) throw new Error(`github-http-${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); verifyFixedHostBytes(bytes, asset);
    nativeRoot = await mkdtemp(join(tmpdir(), "omp-actions-native-"));
    const executable = join(nativeRoot, process.platform === "win32" ? "omp.exe" : "omp");
    await writeFile(executable, bytes, { flag: "wx", mode: 0o700 });
    await runTrusted(worktree, ["bun", "run", "check"], policy.deadlinesMs.verification, { OMP_UPDATER_EXECUTABLE: executable, OMP_UPDATER_HOST_VERSION: candidate.upstreamVersion });
    const tree = intendedTree(worktree, candidate.baseSha, finalPaths);
    const headSha = commitApproved(worktree, finalPaths, `chore: support OMP ${candidate.upstreamVersion}`, candidate.baseSha, tree);
    git(worktree, ["update-ref", "refs/heads/maintenance-candidate", headSha]);
    git(worktree, ["bundle", "create", join(root, "candidate.bundle"), "refs/heads/maintenance-candidate", `^${candidate.baseSha}`]);
    const patch = Bun.spawnSync(["git", "diff", "--binary", "--full-index", "--no-renames", candidate.baseSha, headSha], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
    if (patch.exitCode) throw new Error("candidate-patch-failed");
    await Bun.write(join(root, "candidate.patch"), patch.stdout);
    await Bun.write(join(root, "proof.json"), JSON.stringify({ baseSha: candidate.baseSha, upstreamVersion: candidate.upstreamVersion, releaseVersion: candidate.releaseVersion, semanticReview: "disabled", nativeSmoke: "passed", catalogSha256: createHash("sha256").update(await Bun.file(join(worktree, CATALOG_PATH)).bytes()).digest("hex"), manifestSha256: createHash("sha256").update(await Bun.file(join(worktree, "src/translations/variant-review.json")).bytes()).digest("hex"), semantic: evidence }, null, 2) + "\n");
    const result = { ...candidate, headSha }; await saveCandidateData(worktree, root, result);
    return result;
  } finally {
    if (nativeRoot) await rm(nativeRoot, { recursive: true, force: true });
    await removeCandidateWorktree(checkout, worktree);
  }
}

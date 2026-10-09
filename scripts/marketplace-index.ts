import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decideMarketplaceIndexPublish, loadVerifiedCatalog, type MarketplaceCatalog } from "./marketplace-catalog";

/**
 * Publish the marketplace index to its own branch with a real, boring Git push.
 *
 * The index branch holds exactly `.omp-plugin/marketplace.json`. Commits are built
 * with Git plumbing so the working tree is never mutated, the new commit's parent is
 * the fetched branch tip, and the push is a plain fast-forward (no `--force`).
 * `decideMarketplaceIndexPublish` owns monotonic/idempotent/conflict rules, so a
 * racing release can neither downgrade the channel nor rewrite an immutable SHA.
 */

export interface PublishOptions {
  readonly repo: string;
  readonly remote: string;
  readonly branch: string;
  readonly catalog: MarketplaceCatalog;
  readonly indexPath: string;
  readonly message: string;
  readonly author?: {readonly name: string; readonly email: string};
}

export interface PublishResult {
  readonly decision: "publish" | "identical";
  readonly commit?: string;
}

const DEFAULT_AUTHOR = {name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com"};

function git(repo: string, args: string[], env?: Record<string, string>, input?: string): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {stdout: "pipe", stderr: "pipe", env: {...process.env, ...env}, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), timeout: 60000});
  if (result.exitCode !== 0) throw new Error(`marketplace-index-git-failed:git ${args.join(" ")}:${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** Current tip of the index branch, or null when the branch does not exist yet. */
function remoteBranchTip(repo: string, remote: string, branch: string): string | null {
  const listed = Bun.spawnSync(["git", "-C", repo, "ls-remote", "--heads", remote, `refs/heads/${branch}`], {stdout: "pipe", stderr: "pipe", timeout: 60000});
  if (listed.exitCode !== 0) throw new Error(`marketplace-index-remote-unreachable:${listed.stderr.toString().trim()}`);
  if (listed.stdout.toString().trim() === "") return null;
  git(repo, ["fetch", "--quiet", remote, branch]);
  return git(repo, ["rev-parse", "FETCH_HEAD"]).trim();
}

export async function publishMarketplaceIndex(options: PublishOptions): Promise<PublishResult> {
  if (Bun.spawnSync(["git", "check-ref-format", "--branch", options.branch], {stdout: "pipe", stderr: "pipe"}).exitCode !== 0) throw new Error(`marketplace-index-branch-invalid:${options.branch}`);
  if (options.indexPath.startsWith("/") || options.indexPath.split("/").includes("..") || !/^[A-Za-z0-9_.\/-]+$/.test(options.indexPath)) throw new Error(`marketplace-index-path-invalid:${options.indexPath}`);
  const tip = remoteBranchTip(options.repo, options.remote, options.branch);
  let current: unknown = null;
  if (tip) {
    try {
      current = JSON.parse(git(options.repo, ["show", `${tip}:${options.indexPath}`]));
    } catch {
      throw new Error("marketplace-index-unreadable");
    }
  }
  const decision = decideMarketplaceIndexPublish(current, options.catalog);
  if (decision === "identical") return {decision};

  const directory = await mkdtemp(join(tmpdir(), "omp-marketplace-index-"));
  try {
    const indexFile = join(directory, "index");
    const blob = git(options.repo, ["hash-object", "-w", "--stdin"], undefined, JSON.stringify(options.catalog, null, 2) + "\n").trim();
    git(options.repo, ["read-tree", "--empty"], {GIT_INDEX_FILE: indexFile});
    git(options.repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${options.indexPath}`], {GIT_INDEX_FILE: indexFile});
    const tree = git(options.repo, ["write-tree"], {GIT_INDEX_FILE: indexFile}).trim();
    const author = options.author ?? DEFAULT_AUTHOR;
    const identity = {GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email};
    const commit = git(options.repo, ["commit-tree", tree, ...(tip ? ["-p", tip] : []), "-m", options.message], identity).trim();
    git(options.repo, ["push", options.remote, `${commit}:refs/heads/${options.branch}`]);
    return {decision, commit};
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string => {
    const index = args.indexOf(name);
    const found = index >= 0 ? args[index + 1] : undefined;
    if (!found || found.startsWith("--")) throw new Error(`required:${name}`);
    return found;
  };
  // The published index always carries a live, already-published release: the catalog is
  // re-proved against GitHub tag/workflow/assets here, so a hand-written file cannot be
  // pushed by this CLI. Owned-fixture publication goes through the library function.
  const { catalog } = await loadVerifiedCatalog(value("--tag"), value("--check-run"), args.includes("--catalog") ? value("--catalog") : undefined);
  const branch = args.includes("--branch") ? value("--branch") : "marketplace";
  const result = await publishMarketplaceIndex({
    repo: resolve(value("--repo")),
    remote: args.includes("--remote") ? value("--remote") : "origin",
    branch,
    catalog,
    indexPath: args.includes("--index-path") ? value("--index-path") : ".omp-plugin/marketplace.json",
    message: args.includes("--message") ? value("--message") : `marketplace: v${catalog.plugins[0]!.version}`,
  });
  console.log(JSON.stringify(result));
}

if (import.meta.main) await main();

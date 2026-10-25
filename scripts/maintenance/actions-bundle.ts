import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseStrictJSON, asRecord } from "./json";
import { SNAPSHOT_PLATFORMS, SUPPORTED_HOSTS, snapshotPath } from "./paths";

export interface Candidate {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly baseSha: string;
  readonly upstreamVersion: string;
  readonly releaseVersion: string;
  readonly semanticReview: "disabled";
  readonly headSha?: string;
  readonly files: readonly { path: string; sha256: string }[];
}
export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const candidatePaths = (version: string): readonly string[] => ["src/translations/ru-catalog.json", "src/translations/variant-review.json", ...SNAPSHOT_PLATFORMS.map(platform => snapshotPath(version, platform)), SUPPORTED_HOSTS, "package.json", "bun.lock", "upgrade-report.md", "CHANGELOG.md", "README.md"];
export function parseCandidate(raw: unknown): Candidate {
  const row = asRecord(raw);
  const keys = ["schemaVersion", "repository", "runId", "runAttempt", "baseSha", "upstreamVersion", "releaseVersion", "semanticReview", "headSha", "files"];
  if (!row || Object.keys(row).some(key => !keys.includes(key)) || row.schemaVersion !== 1 || row.semanticReview !== "disabled" || typeof row.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(row.repository)) throw new Error("candidate-schema-invalid");
  for (const key of ["runId", "runAttempt"]) if (typeof row[key] !== "string" || !/^[1-9]\d*$/.test(row[key] as string)) throw new Error("candidate-run-invalid");
  for (const key of ["baseSha", ...(row.headSha === undefined ? [] : ["headSha"])]) if (typeof row[key] !== "string" || !/^[a-f0-9]{40}$/.test(row[key] as string)) throw new Error("candidate-sha-invalid");
  for (const key of ["upstreamVersion", "releaseVersion"]) if (typeof row[key] !== "string" || !stableVersion.test(row[key] as string)) throw new Error("candidate-version-invalid");
  if (!Array.isArray(row.files) || row.files.length > 2000) throw new Error("candidate-files-invalid");
  const paths = new Set<string>();
  for (const file of row.files) {
    const item = asRecord(file);
    if (!item || Object.keys(item).sort().join(",") !== "path,sha256" || typeof item.path !== "string" || !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(item.path) || item.path.split("/").some(part => part === "." || part === "..") || item.path === "candidate.json" || paths.has(item.path) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("candidate-file-invalid");
    paths.add(item.path);
  }
  return row as unknown as Candidate;
}
function artifactFiles(root: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("artifact-special-file");
    if (stat.isDirectory()) files.push(...artifactFiles(root, path)); else if (path !== "candidate.json") files.push(path);
  }
  return files.sort();
}
export async function writeBundleManifest(root: string, candidate: Candidate): Promise<void> {
  const files = artifactFiles(root).map(path => ({ path, sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex") }));
  await Bun.write(join(root, "candidate.json"), JSON.stringify(parseCandidate({ ...candidate, files }), null, 2) + "\n");
}
export async function validateBundle(root: string): Promise<Candidate> {
  if (lstatSync(join(root, "candidate.json")).isSymbolicLink() || Bun.file(join(root, "candidate.json")).size > 1024 * 1024) throw new Error("candidate-manifest-invalid");
  const candidate = parseCandidate(parseStrictJSON(await Bun.file(join(root, "candidate.json")).text()));
  const actual = artifactFiles(root);
  if (actual.join("\0") !== candidate.files.map(file => file.path).sort().join("\0")) throw new Error("artifact-unlisted");
  let total = 0;
  for (const file of candidate.files) {
    const stat = lstatSync(join(root, file.path)); total += stat.size;
    if (stat.size > 64 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error("artifact-size-exceeded");
    const bytes = readFileSync(join(root, file.path));
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`artifact-hash-mismatch:${file.path}`);
    const allowed = ["candidate.patch", "candidate.bundle", "proof.json", "responses.json", "requests.json", "input.json", ...candidatePaths(candidate.upstreamVersion).map(path => `data/${path}`)];
    if (!allowed.includes(file.path)) throw new Error(`artifact-path-forbidden:${file.path}`);
  }
  return candidate;
}
function gitBytes(cwd: string, args: readonly string[]): Uint8Array {
  const sanitized = { ...process.env };
  for (const key of Object.keys(sanitized)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL/i.test(key) || key.startsWith("GIT_CONFIG_")) delete sanitized[key];
  delete sanitized.GIT_ASKPASS; delete sanitized.SSH_ASKPASS;
  sanitized.GIT_TERMINAL_PROMPT = "0";
  const child = Bun.spawnSync(["git", ...args], { cwd, env: sanitized, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git-operation-refused:${args[0]}`);
  return child.stdout;
}
export function git(cwd: string, args: readonly string[]): string {
  return Buffer.from(gitBytes(cwd, args)).toString().trim();
}
/**
 * Содержимое файла из коммита без обрезки: пользовательские документы сравниваются побайтово, поэтому
 * завершающий перевод строки — часть содержимого, а не форматирование вывода git.
 */
export function gitFile(cwd: string, revision: string, path: string): string {
  return Buffer.from(gitBytes(cwd, ["show", `${revision}:${path}`])).toString();
}
export function validateCandidateTree(checkout: string, root: string, candidate: Candidate, allowed = candidatePaths(candidate.upstreamVersion)): readonly string[] {
  if (!candidate.headSha) throw new Error("candidate-head-missing");
  const refs = git(checkout, ["bundle", "list-heads", join(root, "candidate.bundle")]).split("\n");
  if (refs.length !== 1 || refs[0] !== `${candidate.headSha} refs/heads/maintenance-candidate`) throw new Error("candidate-bundle-refs-invalid");
  git(checkout, ["bundle", "verify", join(root, "candidate.bundle")]);
  git(checkout, ["fetch", "--no-tags", join(root, "candidate.bundle"), "refs/heads/maintenance-candidate"]);
  if (git(checkout, ["rev-list", "--parents", "-n", "1", candidate.headSha]) !== `${candidate.headSha} ${candidate.baseSha}`) throw new Error("candidate-parent-mismatch");
  if (git(checkout, ["log", "-1", "--format=%s", candidate.headSha]) !== `chore: support OMP ${candidate.upstreamVersion}`) throw new Error("candidate-message-mismatch");
  const entries = git(checkout, ["diff", "--raw", "--no-abbrev", "--no-renames", candidate.baseSha, candidate.headSha]).split("\n").filter(Boolean);
  for (const entry of entries) {
    const [metadata, path] = entry.split("\t");
    if (!path || !allowed.includes(path) || !/^:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M$|^:000000 100644 0{40} [a-f0-9]{40} A$/.test(metadata!)) throw new Error(`candidate-path-forbidden:${path}`);
  }
  if (entries.length === 0) throw new Error("candidate-diff-empty");
  const patch = Bun.spawnSync(["git", "diff", "--binary", "--full-index", "--no-renames", candidate.baseSha, candidate.headSha], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
  if (patch.exitCode || !Buffer.from(patch.stdout).equals(readFileSync(join(root, "candidate.patch")))) throw new Error("candidate-patch-mismatch");
  return entries.map(entry => entry.split("\t")[1]!);
}

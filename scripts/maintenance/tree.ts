import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControllerPolicy } from "./contracts";

/**
 * Работа с рабочим деревом исполнителя.
 *
 * Инварианты:
 * 1. Индексируются **только** пути из политики. Ни `git add .`, ни `git add -A`: неизвестный файл — отказ.
 * 2. Коммит и push выполняются только из проверенного рабочего дерева исполнителя, никогда из корневого
 *    человеческого дерева.
 * 3. Удаления и переименования нормализуются и проверяются так же, как изменения; выход за пределы
 *    (`..`, абсолютные пути, симлинки) — отказ.
 * 4. После коммита не остаётся незакоммиченных или неизвестных файлов: дерево, которое уходит в PR, целиком
 *    описано разрешёнными путями.
 */

export interface ChangedEntry {
  readonly path: string;
  readonly status: string;
}

export interface PathPlan {
  readonly approved: readonly string[];
  readonly rejected: readonly { path: string; reason: string }[];
}

function run(args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

/** Разбор `git status --porcelain -z`: NUL-разделённые записи, переименования дают две записи. */
export function parsePorcelainZ(output: string): readonly ChangedEntry[] {
  const entries: ChangedEntry[] = [];
  const parts = output.split("\0").filter(part => part.length > 0);
  for (let index = 0; index < parts.length; index++) {
    const record = parts[index]!;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;
    if (status.includes("R")) {
      const previous = parts[index + 1];
      if (previous) {
        entries.push({ path: previous, status: "D " });
        index++;
      }
    }
    entries.push({ path, status });
  }
  return entries;
}

/**
 * Изменения рабочего дерева относительно HEAD плюс неотслеживаемые файлы.
 *
 * Сравнение идёт с HEAD, а не с индексом: реальный индекс пользователя контроллер не читает и не меняет, и
 * подготовленные им записи не должны выглядеть как изменения исполнителя.
 */
export function changedEntries(worktree: string): readonly ChangedEntry[] {
  const tracked = run(["git", "diff", "--name-only", "-z", "HEAD"], worktree);
  if (tracked.code !== 0) throw new Error("git-status-refused");
  const untracked = run(["git", "ls-files", "--others", "--exclude-standard", "-z"], worktree);
  if (untracked.code !== 0) throw new Error("git-status-refused");
  const entries: ChangedEntry[] = [];
  for (const path of tracked.stdout.split("\0").filter(Boolean)) entries.push({ path, status: "M " });
  for (const path of untracked.stdout.split("\0").filter(Boolean)) entries.push({ path, status: "??" });
  return entries;
}

function pathIsAllowed(path: string, policy: ControllerPolicy, candidate: string): boolean {
  if (path.includes("\\") || path.startsWith("/") || path.split("/").includes("..") || path.includes("\0")) return false;
  return policy.executorPaths.some(pattern => {
    const expanded = pattern.replaceAll("<candidate>", candidate);
    return expanded.endsWith("/") ? path.startsWith(expanded) : path === expanded;
  });
}

/** Разделение изменений на разрешённые и отклонённые. Отклонённые блокируют коммит, а не игнорируются. */
export function planPaths(entries: readonly ChangedEntry[], policy: ControllerPolicy, candidate: string): PathPlan {
  const approved: string[] = [];
  const rejected: { path: string; reason: string }[] = [];
  for (const entry of entries) {
    if (pathIsAllowed(entry.path, policy, candidate)) approved.push(entry.path);
    else rejected.push({ path: entry.path, reason: "path-outside-policy" });
  }
  return { approved: [...new Set(approved)].sort(), rejected };
}

/** Проверка, что рабочее дерево принадлежит ожидаемому репозиторию. */
export function assertOrigin(worktree: string, repository: string): void {
  const result = run(["git", "remote", "get-url", "origin"], worktree);
  if (result.code !== 0) throw new Error("origin-unavailable");
  const url = result.stdout.trim();
  if (!url.includes(repository)) throw new Error("origin-mismatch");
}

export function currentHead(worktree: string): string {
  const result = run(["git", "rev-parse", "HEAD"], worktree);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("head-unavailable");
  return sha;
}

/** Родитель коммита — доказательство, что найденная голова выросла из ожидаемой базы. */
export function parentOf(worktree: string, sha: string): string {
  const result = run(["git", "rev-parse", `${sha}^`], worktree);
  const parent = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{40}$/.test(parent)) throw new Error("parent-unavailable");
  return parent;
}

function runEnv(args: readonly string[], cwd: string, env: Record<string, string | undefined>): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

/**
 * Изменённые пути между двумя коммитами — из истории, а не из состояния рабочего дерева.
 *
 * Чистое дерево на проверяемом коммите не имеет незакоммиченных изменений, поэтому `changedEntries` там
 * пуст. Набор изменений генерации берётся сравнением базы и головы; переименования запрещены, иначе пара
 * путей неоднозначна.
 */
export function committedPaths(worktree: string, baseSha: string, headSha: string): readonly string[] {
  const result = run(["git", "diff", "--name-only", "-z", "--no-renames", baseSha, headSha], worktree);
  if (result.code !== 0) throw new Error("committed-diff-unavailable");
  return result.stdout.split("\0").filter(Boolean);
}

/** Рабочее дерево и индекс обязаны быть чистыми: правки ревьюера недопустимы. */
export function assertCleanWorktree(worktree: string): void {
  const status = run(["git", "status", "--porcelain=v1", "-z"], worktree);
  if (status.code !== 0) throw new Error("git-status-refused");
  if (status.stdout.split("\0").filter(Boolean).length > 0) throw new Error("reviewer-worktree-dirty");
}

/** Дерево, которое получится из разрешённых путей поверх базы.
 *
 * Индекс берётся **изолированный** (`GIT_INDEX_FILE`), поэтому подготовленные пользователем записи в реальном
 * индексе не участвуют и не изменяются. Ожидаемое дерево — это и есть намерение коммита.
 */
export function intendedTree(worktree: string, baseSha: string, approved: readonly string[]): string {
  const indexFile = join(tmpdir(), `maint-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const read = runEnv(["read-tree", baseSha], worktree, env);
    if (read.code !== 0) throw new Error("index-seed-refused");
    const add = runEnv(["add", "--", ...approved], worktree, env);
    if (add.code !== 0) throw new Error("git-add-refused");
    const tree = runEnv(["write-tree"], worktree, env);
    const hash = tree.stdout.trim();
    if (tree.code !== 0 || !/^[a-f0-9]{40}$/.test(hash)) throw new Error("tree-unavailable");
    return hash;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * Коммит строго разрешённых путей поверх базы.
 *
 * Записи реального индекса не используются и не изменяются: коммит собирается через изолированный индекс и
 * `commit-tree`, а ветвь двигается compare-and-swap по ожидаемой старой голове. Посторонняя подготовка в
 * индексе — отказ, а не «закоммитим заодно».
 */
export function commitApproved(
  worktree: string, paths: readonly string[], message: string, baseSha: string, expectedTree: string,
): string {
  if (paths.length === 0) throw new Error("no-approved-changes");
  const preexisting = stagedPaths(worktree).filter(path => !paths.includes(path));
  if (preexisting.length > 0) throw new Error(`index-outside-policy:${preexisting.join(",")}`);
  const oldHead = currentHead(worktree);
  if (oldHead !== baseSha) throw new Error("head-not-at-base");
  const indexFile = join(tmpdir(), `maint-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const read = runEnv(["read-tree", baseSha], worktree, env);
    if (read.code !== 0) throw new Error("index-seed-refused");
    const add = runEnv(["add", "--", ...paths], worktree, env);
    if (add.code !== 0) throw new Error("git-add-refused");
    const tree = runEnv(["write-tree"], worktree, env).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("tree-unavailable");
    // Дерево пересчитано перед коммитом и обязано совпасть с зафиксированным намерением: иначе содержимое
    // изменилось между наблюдением и применением, и коммитить его нельзя.
    if (tree !== expectedTree) throw new Error("tree-intent-mismatch");
    const created = runEnv(["commit-tree", tree, "-p", baseSha, "-m", message], worktree, env);
    const commit = created.stdout.trim();
    if (created.code !== 0 || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("git-commit-refused");
    const branch = run(["git", "symbolic-ref", "-q", "HEAD"], worktree).stdout.trim();
    const updated = run(["git", "update-ref", branch || "HEAD", commit, oldHead], worktree);
    if (updated.code !== 0) throw new Error("head-cas-refused");
    // Реальный индекс переводится на новый коммит: коммит собран через изолированный индекс, и без этого
    // шага индекс остался бы на базе, а рабочее дерево выглядело бы изменённым. Рабочие файлы не трогаются.
    const refreshed = run(["git", "read-tree", "HEAD"], worktree);
    if (refreshed.code !== 0) throw new Error("index-refresh-refused");
    return commit;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Отпечаток содержимого разрешённых путей — часть неизменяемого намерения коммита. */
export async function contentHash(worktree: string, approved: readonly string[]): Promise<string> {
  const hasher = createHash("sha256");
  for (const path of [...approved].sort()) {
    hasher.update(path);
    hasher.update("\0");
    const file = Bun.file(join(worktree, path));
    hasher.update(await file.exists() ? await file.text() : "<absent>");
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

/**
 * Канонический набор отпечатков доказательств проверяемого коммита.
 *
 * Считается контроллером из фактического коммита: дерево коммита, каждый изменённый путь и его содержимое.
 * Это независимый от отчёта ревьюера набор — с ним сверяется `verdict.evidenceHashes` как множество.
 */
export async function evidenceSet(worktree: string, headSha: string, approved: readonly string[]): Promise<readonly string[]> {
  const hashes: string[] = [];
  const tree = run(["git", "rev-parse", `${headSha}^{tree}`], worktree).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("evidence-tree-unavailable");
  hashes.push(createHash("sha256").update(`tree:${tree}`).digest("hex"));
  for (const path of [...approved].sort()) {
    hashes.push(createHash("sha256").update(`path:${path}`).digest("hex"));
    const blob = run(["git", "show", `${headSha}:${path}`], worktree);
    if (blob.code !== 0) {
      hashes.push(createHash("sha256").update(`absent:${path}`).digest("hex"));
      continue;
    }
    hashes.push(createHash("sha256").update(`blob:${path}:${blob.stdout}`).digest("hex"));
  }
  return hashes.sort();
}
/**
 * Наблюдение коммита: ровно то, что нужно, чтобы пережить сбой между коммитом и записью receipt.
 *
 * Отсутствие доказывается только чистым деревом на базе без посторонних изменений. Найденный коммит обязан
 * совпасть по родителю, сообщению и дереву — дерево пересчитывается из разрешённых путей здесь же. Любое
 * расхождение недоказуемо, и стадия блокируется, а не повторяется.
 */
export function observeCommit(
  worktree: string, baseSha: string, approved: readonly string[], message: string, expectedTree: string,
): { kind: "absent" } | { kind: "found"; receipt: { headSha: string; treeHash: string } } | { kind: "unknown" } {
  let head: string;
  try {
    head = currentHead(worktree);
  } catch {
    return { kind: "unknown" };
  }
  const unexpected = changedEntries(worktree).filter(entry => !approved.includes(entry.path));
  if (unexpected.length > 0) return { kind: "unknown" };
  let actualTree: string;
  try {
    actualTree = intendedTree(worktree, baseSha, approved);
  } catch {
    return { kind: "unknown" };
  }
  // Намерение зафиксировано до действия: другое дерево означает, что дерево изменилось под нами.
  if (actualTree !== expectedTree) return { kind: "unknown" };
  if (head === baseSha) return { kind: "absent" };
  try {
    if (parentOf(worktree, head) !== baseSha) return { kind: "unknown" };
    if (run(["git", "log", "-1", "--format=%s"], worktree).stdout.trim() !== message) return { kind: "unknown" };
    if (run(["git", "rev-parse", `${head}^{tree}`], worktree).stdout.trim() !== expectedTree) return { kind: "unknown" };
    return { kind: "found", receipt: { headSha: head, treeHash: expectedTree } };
  } catch {
    return { kind: "unknown" };
  }
}

/** Записи индекса, уже подготовленные к коммиту посторонним процессом. */
export function stagedPaths(worktree: string): readonly string[] {
  const result = run(["git", "diff", "--cached", "--name-only", "-z"], worktree);
  if (result.code !== 0) throw new Error("index-unreadable");
  return result.stdout.split("\0").filter(Boolean);
}

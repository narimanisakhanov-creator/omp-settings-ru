import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCleanWorktree, changedEntries, commitApproved, committedPaths, currentHead, intendedTree, observeCommit, parentOf, planPaths } from "../scripts/maintenance/tree";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";
import { SNAPSHOT_DIR, SUPPORTED_HOSTS } from "../scripts/maintenance/paths";

/**
 * Реальные git-репозитории: проверяется фактическое наблюдение коммита, а не подменённый ответ.
 * Никаких сетевых границ здесь нет — только локальное дерево и его история.
 */

const policy = validatePolicy(rawPolicy);

function git(cwd: string, args: readonly string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

async function makeRepository(): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), "maint-tree-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "controller@example.invalid"]);
  git(dir, ["config", "user.name", "Controller"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(dir, "src/translations"), { recursive: true });
  await mkdir(join(dir, SNAPSHOT_DIR), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.5.0" }));
  await writeFile(join(dir, "src/translations/ru-catalog.json"), '{"locale":"ru","settings":{}}\n');
  await writeFile(join(dir, SUPPORTED_HOSTS), "{}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return { dir, base: git(dir, ["rev-parse", "HEAD"]) };
}

describe("наблюдение коммита на реальном дереве", () => {
  let repository: { dir: string; base: string };

  beforeEach(async () => {
    repository = await makeRepository();
  });

  afterEach(async () => {
    await rm(repository.dir, { recursive: true, force: true });
  });

  test("чистое дерево на базе означает отсутствие коммита", () => {
    const tree = intendedTree(repository.dir, repository.base, ["src/translations/ru-catalog.json"]);
    expect(observeCommit(repository.dir, repository.base, ["src/translations/ru-catalog.json"], "Поддержка OMP 18.8.9", tree).kind).toBe("absent");
  });

  test("посторонний файл делает отсутствие недоказуемым", async () => {
    await writeFile(join(repository.dir, "unexpected.txt"), "посторонний\n");
    const tree = intendedTree(repository.dir, repository.base, ["src/translations/ru-catalog.json"]);
    expect(observeCommit(repository.dir, repository.base, ["src/translations/ru-catalog.json"], "Поддержка OMP 18.8.9", tree).kind).toBe("unknown");
  });

  test("коммит из правильной базы распознаётся как применённый", async () => {
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),'{"changed":"б"}\n');
    const head=commitApproved(repository.dir,["src/translations/ru-catalog.json"],"Поддержка OMP 18.8.9",repository.base,intendedTree(repository.dir,repository.base,["src/translations/ru-catalog.json"]));
    const observed=observeCommit(repository.dir,repository.base,["src/translations/ru-catalog.json"],"Поддержка OMP 18.8.9",intendedTree(repository.dir,repository.base,["src/translations/ru-catalog.json"]));
    expect(observed.kind).toBe("found");
    expect(observed.kind === "found" ? observed.receipt.headSha : "").toBe(head);
    expect(parentOf(repository.dir, head)).toBe(repository.base);
  });

  test("подготовленный посторонний файл не попадает в коммит и блокирует его", async () => {
    await writeFile(join(repository.dir, ".env.local"), "SECRET=1\n");
    git(repository.dir, ["add", ".env.local"]);
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),'{"changed":"б"}\n');
    expect(() => commitApproved(repository.dir, ["src/translations/ru-catalog.json"], "Поддержка OMP 18.8.9", repository.base, intendedTree(repository.dir, repository.base, ["src/translations/ru-catalog.json"])))
      .toThrow("index-outside-policy:.env.local");
    expect(git(repository.dir, ["rev-parse", "HEAD"])).toBe(repository.base);
    expect(git(repository.dir, ["diff", "--cached", "--name-only"])).toBe(".env.local");
  });

  test("коммит не из ожидаемой базы недоказуем", async () => {
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),"[1]\n");
    git(repository.dir, ["add", "-A"]);
    git(repository.dir, ["commit", "-q", "-m", "посторонний коммит"]);
    const alien = git(repository.dir, ["rev-parse", "HEAD"]);
    expect(alien).not.toBe(repository.base);
    expect(observeCommit(repository.dir, repository.base, ["src/translations/ru-catalog.json"], "Поддержка OMP 18.8.9", intendedTree(repository.dir, repository.base, ["src/translations/ru-catalog.json"])).kind).toBe("unknown");
  });

  test("чужое сообщение коммита делает его недоказуемым", async () => {
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),'{"changed":"б"}\n');
    const tree=intendedTree(repository.dir,repository.base,["src/translations/ru-catalog.json"]);
    const foreign = git(repository.dir, ["commit-tree", tree, "-p", repository.base, "-m", "Постороннее сообщение"]);
    git(repository.dir, ["update-ref", "HEAD", foreign, repository.base]);
    expect(observeCommit(repository.dir, repository.base, ["src/translations/ru-catalog.json"], "Поддержка OMP 18.8.9", intendedTree(repository.dir, repository.base, ["src/translations/ru-catalog.json"])).kind).toBe("unknown");
  });

  test("изменение содержимого после коммита делает наблюдение недоказуемым", async () => {
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),'{"changed":"б"}\n');
    commitApproved(repository.dir,["src/translations/ru-catalog.json"],"Поддержка OMP 18.8.9",repository.base,intendedTree(repository.dir,repository.base,["src/translations/ru-catalog.json"]));
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),'{"changed":"в"}\n');
    expect(observeCommit(repository.dir, repository.base, ["src/translations/ru-catalog.json"], "Поддержка OMP 18.8.9", intendedTree(repository.dir, repository.base, ["src/translations/ru-catalog.json"])).kind).toBe("unknown");
  });

  test("посторонний путь отклоняется планом, а коммит содержит только разрешённые пути", async () => {
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),"[2]\n");
    await writeFile(join(repository.dir, ".github-workflow.yml"), "посторонний\n");
    const plan = planPaths(changedEntries(repository.dir), policy, "18.8.9");
    expect(plan.rejected.map(entry => entry.path)).toContain(".github-workflow.yml");
    expect(plan.approved).toContain("src/translations/ru-catalog.json");
    const head = commitApproved(repository.dir, plan.approved, "Поддержка OMP 18.8.9", repository.base, intendedTree(repository.dir, repository.base, plan.approved));
    const committed = git(repository.dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", head]).split("\n");
    expect(committed).toEqual(["src/translations/ru-catalog.json"]);
    // Посторонний файл остаётся неотслеживаемым и в коммит не попадает.
    expect(git(repository.dir, ["ls-files", "--others", "--exclude-standard"])).toBe(".github-workflow.yml");
  });

  test("после коммита дерево чистое, а голова отличается от базы", async () => {
    await writeFile(join(repository.dir, "package.json"), JSON.stringify({ name: "x", version: "0.6.0" }));
    const head = commitApproved(repository.dir, ["package.json"], "Поддержка OMP 18.8.9", repository.base, intendedTree(repository.dir, repository.base, ["package.json"]));
    expect(changedEntries(repository.dir)).toHaveLength(0);
    expect(currentHead(repository.dir)).toBe(head);
    expect(head).not.toBe(repository.base);
  });

  test("чистое дерево на проверяемом коммите не даёт пустой набор изменений", async () => {
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),'{"changed":"б"}\n');
    const tree=intendedTree(repository.dir,repository.base,["src/translations/ru-catalog.json"]);
    const head=commitApproved(repository.dir,["src/translations/ru-catalog.json"],"Поддержка OMP 18.8.9",repository.base,tree);
    // Рабочее дерево чистое: `changedEntries` пуст, и именно поэтому набор изменений берётся из истории.
    expect(changedEntries(repository.dir)).toHaveLength(0);
    expect(committedPaths(repository.dir,repository.base,head)).toEqual(["src/translations/ru-catalog.json"]);
    expect(() => assertCleanWorktree(repository.dir)).not.toThrow();
  });

  test("правки ревьюера в дереве запрещены", async () => {
    await writeFile(join(repository.dir,"src/translations/ru-catalog.json"),"[3]\n");
    expect(() => assertCleanWorktree(repository.dir)).toThrow("reviewer-worktree-dirty");
  });
});

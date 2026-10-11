import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  assertOrigin, changedEntries, commitApproved, contentHash, currentHead, intendedTree, observeCommit, parentOf, planPaths, stagedPaths,
} from "../scripts/maintenance/tree";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";

/**
 * Изолированный сквозной прогон контроллера на **настоящем** git.
 *
 * Здесь нет подменённых ответов: создаётся реальное рабочее дерево и реальный bare-репозиторий как `origin`,
 * после чего проверяется фактическое содержимое коммитов и фактическая голова удалённой ветви. Только так
 * можно доказать свойства, невидимые в исходнике: что подготовленный посторонним процессом файл не уезжает в
 * коммит, что коммит несёт ровно одобренный набор путей, что родитель — ожидаемая база, что зафиксированное
 * намерение защищает от правки содержимого, и что отправка доводит до удалённой ветви тот самый SHA.
 *
 * Никакой сети, никаких настоящих PR/выпусков/тегов: `origin` — локальный bare-каталог в temp.
 */

const policy = validatePolicy(rawPolicy);
const MESSAGE = "Поддержка OMP 18.8.9";
const APPROVED = "src/translations/ru-part-1.ts";
const SECRET = ".env.local";

function git(cwd: string, args: readonly string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

/** Фактический набор путей, который несёт коммит, — то, что реально уйдёт в PR. */
function committedPaths(cwd: string, base: string, head: string): string[] {
  return git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", base, head])
    .split("\n").map(line => line.trim()).filter(Boolean);
}

interface Fixture {
  readonly root: string;
  readonly worktree: string;
  readonly origin: string;
  readonly base: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "maint-controller-e2e-"));
  const origin = join(root, "origin.git");
  const worktree = join(root, "worktree");
  await mkdir(origin, { recursive: true });
  await mkdir(worktree, { recursive: true });
  git(origin, ["init", "-q", "--bare", "-b", "main"]);
  git(worktree, ["init", "-q", "-b", "main"]);
  git(worktree, ["config", "user.email", "controller@example.invalid"]);
  git(worktree, ["config", "user.name", "Controller"]);
  git(worktree, ["config", "commit.gpgsign", "false"]);
  git(worktree, ["remote", "add", "origin", origin]);
  await mkdir(join(worktree, "src/translations"), { recursive: true });
  await mkdir(join(worktree, "baseline"), { recursive: true });
  await mkdir(join(worktree, "docs"), { recursive: true });
  await writeFile(join(worktree, "package.json"), JSON.stringify({ name: "omp-settings-ru", version: "0.6.0" }));
  await writeFile(join(worktree, APPROVED), "export const ru = [];\n");
  await writeFile(join(worktree, "docs/secret.md"), "внутренняя заметка\n");
  await writeFile(join(worktree, "baseline/supported-hosts.json"), JSON.stringify({ versions: [{ version: "18.8.4" }] }));
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-q", "-m", "base"]);
  git(worktree, ["push", "-q", "origin", "main"]);
  return { root, worktree, origin, base: git(worktree, ["rev-parse", "HEAD"]) };
}

describe("изолированный прогон контроллера: реальный git", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("подготовленный извне .env не попадает в коммит, HEAD не двигается", async () => {
    const { worktree, base } = fixture;
    await writeFile(join(worktree, APPROVED), "export const ru = [{ source: 'a', ru: 'б' }];\n");
    await writeFile(join(worktree, SECRET), "TOKEN=утечка\n");
    // Посторонний процесс уже подготовил секрет в индексе вместе с разрешённым путём.
    git(worktree, ["add", "--", SECRET, APPROVED]);
    expect([...stagedPaths(worktree)].sort()).toEqual([SECRET, APPROVED].sort());

    const intent = intendedTree(worktree, base, [APPROVED]);
    const before = currentHead(worktree);
    let refusal: string | undefined;
    try {
      commitApproved(worktree, [APPROVED], MESSAGE, base, intent);
    } catch (error) {
      refusal = (error as Error).message;
    }

    // Отказ обязателен: утечка секрета в PR недопустима.
    expect(refusal).toContain(SECRET);
    // Ни один коммит не создан: HEAD не сдвинулся с базы.
    expect(before).toBe(base);
    expect(currentHead(worktree)).toBe(base);
    expect(git(worktree, ["log", "--format=%H"]).trim()).toBe(base);
    // Секрет остался в индексе как был: фикстура не «убирает» чужую запись молча.
    expect(stagedPaths(worktree)).toContain(SECRET);
    expect(await Bun.file(join(worktree, SECRET)).exists()).toBe(true);
  });

  test("разрешённый политикой, но не одобренный путь тоже не уезжает в коммит", async () => {
    const { worktree, base } = fixture;
    await writeFile(join(worktree, APPROVED), "export const ru = [{ source: 'a', ru: 'б' }];\n");
    await writeFile(join(worktree, "src/evil.ts"), "export const evil = 1;\n");
    git(worktree, ["add", "--", "src/evil.ts", APPROVED]);

    const intent = intendedTree(worktree, base, [APPROVED]);
    expect(() => commitApproved(worktree, [APPROVED], MESSAGE, base, intent)).toThrow("index-outside-policy:src/evil.ts");
    expect(currentHead(worktree)).toBe(base);
  });

  test("изменение пути вне политики вместе с одобренным: отказ, HEAD сохранён", async () => {
    const { worktree, base } = fixture;
    // Переименование `docs/secret.md` (вне политики) в разрешённый путь: в индексе оказываются и удаление
    // постороннего пути, и добавление одобренного. Посторонний путь — отказ, а не «закоммитим заодно».
    git(worktree, ["rm", "-q", "docs/secret.md"]);
    await writeFile(join(worktree, "src/translations/moved.ts"), "export const ru = [{ source: 'a', ru: 'б' }];\n");
    git(worktree, ["add", "--", "src/translations/moved.ts"]);
    expect([...stagedPaths(worktree)].sort()).toEqual(["docs/secret.md", "src/translations/moved.ts"].sort());

    const intent = intendedTree(worktree, base, ["src/translations/moved.ts"]);
    expect(() => commitApproved(worktree, ["src/translations/moved.ts"], MESSAGE, base, intent))
      .toThrow("index-outside-policy:docs/secret.md");
    // Отказ не оставляет полу-коммита: HEAD на базе, постороннее удаление не приписано коммиту.
    expect(currentHead(worktree)).toBe(base);
    expect(git(worktree, ["log", "--format=%H"]).trim()).toBe(base);
  });

  test("намерение зафиксировано до действия: правка одобренного файла после наблюдения не коммитится", async () => {
    const { worktree, base } = fixture;
    await writeFile(join(worktree, APPROVED), "export const ru = [{ source: 'a', ru: 'заявлено' }];\n");
    const intent = intendedTree(worktree, base, [APPROVED]);
    // Содержимое одобренного файла (в пределах allowlist) меняется уже после фиксации намерения.
    await writeFile(join(worktree, APPROVED), "export const ru = [{ source: 'a', ru: 'подменено' }];\n");

    // Наблюдение недоказуемо, а применение отказывает: намерение не пересчитывается молча.
    expect(observeCommit(worktree, base, [APPROVED], MESSAGE, intent).kind).toBe("unknown");
    expect(() => commitApproved(worktree, [APPROVED], MESSAGE, base, intent)).toThrow("tree-intent-mismatch");
    expect(currentHead(worktree)).toBe(base);
  });

  test("одобренный коммит: родитель — база, дерево — из одобренных путей, содержимое точное", async () => {
    const { worktree, base } = fixture;
    await writeFile(join(worktree, APPROVED), "export const ru = [{ source: 'a', ru: 'б' }];\n");

    const plan = planPaths(changedEntries(worktree), policy, "18.8.9");
    expect(plan.approved).toEqual([APPROVED]);
    expect(plan.rejected).toEqual([]);

    const intent = intendedTree(worktree, base, plan.approved);
    const content = await contentHash(worktree, plan.approved);
    const head = commitApproved(worktree, plan.approved, MESSAGE, base, intent);

    expect(head).not.toBe(base);
    expect(parentOf(worktree, head)).toBe(base);
    expect(committedPaths(worktree, base, head)).toEqual([APPROVED]);
    expect(git(worktree, ["rev-parse", `${head}^{tree}`])).toBe(intent);
    expect(await contentHash(worktree, plan.approved)).toBe(content);
    expect(changedEntries(worktree)).toHaveLength(0);

    // Наблюдение на повторном прогоне подтверждает уже сделанный коммит — повторного коммита не будет.
    expect(observeCommit(worktree, base, plan.approved, MESSAGE, intent))
      .toEqual({ kind: "found", receipt: { headSha: head, treeHash: intent } });
    expect(currentHead(worktree)).toBe(head);
  });

  test("отправка доводит до удалённой ветви тот самый SHA и повтор идемпотентен", async () => {
    const { worktree, origin, base } = fixture;
    await writeFile(join(worktree, APPROVED), "export const ru = [{ source: 'a', ru: 'б' }];\n");
    const head = commitApproved(worktree, [APPROVED], MESSAGE, base, intendedTree(worktree, base, [APPROVED]));

    // Фикстура живёт только в temp: рабочий репозиторий не является продакшн-origin.
    expect(() => assertOrigin(worktree, policy.repository)).toThrow("origin-mismatch");
    assertOrigin(worktree, basename(origin));
    git(worktree, ["push", "-q", "origin", `${head}:refs/heads/upgrade/omp-18.8.9`]);
    const remote = git(worktree, ["ls-remote", "origin", "refs/heads/upgrade/omp-18.8.9"]).split(/\s+/)[0]!;
    expect(remote).toBe(head);
    expect(remote).not.toBe(base);

    // Повторная отправка того же SHA ничего не меняет — повтор после сбоя безопасен.
    git(worktree, ["push", "-q", "origin", `${head}:refs/heads/upgrade/omp-18.8.9`]);
    expect(git(worktree, ["ls-remote", "origin", "refs/heads/upgrade/omp-18.8.9"]).split(/\s+/)[0]!).toBe(head);
  });
});

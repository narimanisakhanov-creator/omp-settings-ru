import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { privateArtifactCode, repositoryViolations, trackedPathViolation } from "../scripts/check-repository";

const checkout = join(import.meta.dir, "..");
const script = join(checkout, "scripts", "check-repository.ts");

function git(cwd: string, ...args: string[]): void {
  const child = Bun.spawnSync(["git", "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
}

/** A real temporary Git repository: the guard reads tracked entries, so the fixture must be committed. */
async function trackedRepository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-repository-composition-"));
  git(root, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  // A user-level excludes file must not silently hide the fixture file from the guard's input.
  git(root, "add", "--force", "--all", ".");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

function guard(root: string) {
  const child = Bun.spawnSync(["bun", script], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test("tracked project provenance and nested documentation are allowed", () => {
  for (const path of [
    "upgrade-report.md",
    "CHANGELOG.md",
    "src/index.ts",
    "src/translations/ru-catalog.json",
    "test/fixtures/host-snapshots/18.13.3-linux.json",
    "test/fixtures/host-snapshots/supported-hosts.json",
    "docs/screenshots/settings-ru.png",
    "docs/maintenance.md",
    "docs/notes_PLAN.md",
    ".env.example",
    "scripts/check-repository.ts",
  ]) expect(trackedPathViolation(path)).toBeUndefined();
  expect(repositoryViolations(["README.md", "docs/architecture.md"])).toEqual([]);
});

test("service directories, private plans, env files and scratch output are refused by path only", () => {
  const banned = [
    ".tools/session.log",
    ".kiro/plan.md",
    "nested/.firecrawl/cache.json",
    ".smoke/report.json",
    ".agents/instructions.md",
    ".hiro/trace.json",
    ".triage/notes.md",
    ".orca/state.json",
    "OWNER_PLAN.md",
    ".env",
    ".env.local",
    "private-backup-2026.json",
    "backup/private-backup-channel.json",
    "logs/build.log",
    "captures/panel.dump",
    "tmp/work.tmp",
  ];
  for (const path of banned) expect(trackedPathViolation(path)).toBe(privateArtifactCode(path));
  expect(repositoryViolations(banned)).toEqual(banned.map(privateArtifactCode));
});

test("control characters in a tracked name cannot forge a log line", () => {
  const forged = "notes\nrepository-composition-ok:0.log";
  expect(trackedPathViolation(forged)).toBe(`private-project-artifact:${JSON.stringify(forged)}`);
  expect(privateArtifactCode(forged)).not.toContain("\n");
});

test("the current tracked tree passes the guard", () => {
  const run = guard(checkout);
  expect(run.exitCode).toBe(0);
  expect(run.stdout.trim()).toMatch(/^repository-composition-ok:\d+$/);
  expect(run.stderr).not.toContain("private-project-artifact:");
}, 60_000);

test("a tracked service artifact fails the guard without printing its content", async () => {
  const secret = "ghp_thisValueMustNeverBePrinted0123456789";
  const root = await trackedRepository({
    "README.md": "project\n",
    ".tools/session.log": `${secret}\n`,
    ".env.local": `TOKEN=${secret}\n`,
    "OWNER_PLAN.md": `${secret}\n`,
    "private-backup-2026.json": `{"token":"${secret}"}\n`,
    "docs/maintenance.md": "documented\n",
  });
  try {
    const run = guard(root);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.split("\n").filter(line => line.startsWith("private-project-artifact:")).sort()).toEqual([
      "private-project-artifact:.env.local",
      "private-project-artifact:.tools/session.log",
      "private-project-artifact:OWNER_PLAN.md",
      "private-project-artifact:private-backup-2026.json",
    ]);
    expect(run.stderr).toContain("repository-composition-invalid:4");
    expect(run.stderr).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("an untracked local artifact is not part of the published tree and does not fail the guard", async () => {
  const root = await trackedRepository({ "README.md": "project\n", ".gitignore": ".tools/\n*.log\n" });
  try {
    await mkdir(join(root, ".tools"), { recursive: true });
    await writeFile(join(root, ".tools", "session.log"), "local only\n");
    const run = guard(root);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe("repository-composition-ok:2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a checkout without a readable index fails closed instead of reporting an empty tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-repository-unversioned-"));
  try {
    // A `.git` file pointing at a missing directory makes the failure deterministic: an
    // enclosing repository can never turn this fixture into a valid empty index.
    await writeFile(join(root, ".git"), "gitdir: /nonexistent/omp-repository-index\n");
    const run = guard(root);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("tracked-files-unavailable");
    expect(run.stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

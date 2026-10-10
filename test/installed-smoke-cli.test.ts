import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalContentHash } from "../scripts/installed-smoke";
import { updaterTestExecutable } from "../scripts/ci/prepare-host";

const executable = updaterTestExecutable(process.env, () => process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? "", "omp", "omp.exe") : Bun.which("omp"));
const versionProbe = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
const hostVersion = /^(?:omp(?: v|\/))?(\d+\.\d+\.\d+)\s*$/.exec(versionProbe.stdout.toString().trim())?.[1];
if (versionProbe.exitCode !== 0 || !hostVersion) throw new Error("installed-smoke-host-unverifiable");
if (process.env.OMP_UPDATER_HOST_VERSION && process.env.OMP_UPDATER_HOST_VERSION !== hostVersion) throw new Error("installed-smoke-host-version-mismatch");

test("installed host preflight identifies actual executable and isolated native installation", async () => {
  const result = Bun.spawnSync(["bun", "scripts/smoke-installed-host.ts", "--preflight", "--executable", executable], {stdout: "pipe", stderr: "pipe", timeout: 60000});
  expect(result.exitCode).toBe(0);
  const receipt = JSON.parse(result.stdout.toString());
  expect(receipt.hostVersion).toBe(hostVersion);
  expect(receipt.plugin.enabled).toBe(true);
  expect(receipt.plugin.manifest.extensions).toContain("./src/index.ts");
  expect(receipt.installedPanel).toBe(false);
  expect(receipt.contentHash).toBe(await canonicalContentHash(process.cwd()));
  expect(receipt.executableSha256).toMatch(/^[a-f0-9]{64}$/);
}, 60000);

test("actual installed host exercises panel search edits recovery and clean fresh session", () => {
  const result = Bun.spawnSync(["bun", "scripts/smoke-installed-host.ts", "--exercise", "--executable", executable], {stdout: "pipe", stderr: "pipe", timeout: 180000});
  expect(result.exitCode).toBe(0);
  const receipt = JSON.parse(result.stdout.toString());
  expect(receipt.hostVersion).toBe(hostVersion);
  expect(receipt.installedPanel).toBe(true);
  expect(receipt.observations.map((entry: {kind: string}) => entry.kind)).toEqual(["startup", "ru-panel", "ru-search", "bool-change", "bool-restored", "enum-change", "enum-restored", "en-panel", "ru-reapplied", "explicit-en-reset", "fresh-english-no-extensions"]);
  expect(receipt.isolation.ambientCredentialInherited).toBe(false);
  expect(receipt.contentHash).toMatch(/^[a-f0-9]{64}$/);
}, 180000);

/**
 * The distribution smoke proves one explicitly named release. A caller that names no target, or
 * two conflicting targets, must be refused before any home, profile or executable is touched: the
 * old implicit default release is gone, so an unlabelled run can no longer prove stale bytes. The
 * deliberately absent executable is the sentinel for "nothing was spawned".
 */
function refusedSmokeTarget(args: string[]): {exitCode: number | null; errorLine: string | undefined; output: string; homeCreated: boolean} {
  const parent = mkdtempSync(join(tmpdir(), "omp-smoke-target-"));
  const home = join(parent, "home");
  const executable = join(parent, "absent-executable", process.platform === "win32" ? "omp.exe" : "omp");
  try {
    const result = Bun.spawnSync(["bun", "scripts/distribution-smoke.ts", ...args, "--executable", executable, "--home", home], {stdout: "pipe", stderr: "pipe", timeout: 60000});
    const output = result.stdout.toString() + result.stderr.toString();
    return {exitCode: result.exitCode, errorLine: output.split("\n").map(line => line.trim()).find(line => line.startsWith("error:")), output, homeCreated: existsSync(home)};
  } finally {
    rmSync(parent, {recursive: true, force: true});
  }
}

test("distribution smoke target is required when neither --source nor --catalog is given", () => {
  const run = refusedSmokeTarget([]);
  expect(run.exitCode).not.toBe(0);
  expect(run.errorLine).toBe("error: smoke-target-required: use --source or --catalog <path>");
  expect(run.output).not.toMatch(/uv_spawn|ENOENT|native-executable-required/);
  expect(run.homeCreated).toBe(false);
}, 180000);

test("distribution smoke target conflict is refused when both --source and --catalog are given", () => {
  const run = refusedSmokeTarget(["--source", "--catalog", join(tmpdir(), "omp-smoke-absent-catalog.json")]);
  expect(run.exitCode).not.toBe(0);
  expect(run.errorLine).toBe("error: smoke-target-conflict: use --source or --catalog <path>");
  expect(run.output).not.toMatch(/uv_spawn|ENOENT|native-executable-required/);
  expect(run.homeCreated).toBe(false);
}, 180000);

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "switch-channel.ts");

/**
 * The supported migration is one-way (legacy npm user-install → marketplace). The reverse
 * target must be refused before any option is resolved, home is read or native process is
 * spawned: the absent executable and non-existent paths are sentinels for "nothing ran".
 */
function refused(args: readonly string[], parent: string): { exitCode: number | null; output: string } {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
    env: { ...process.env, HOME: parent, USERPROFILE: parent },
  });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test("reverse npm target is refused before any option, home or backup exists", () => {
  const parent = mkdtempSync(join(tmpdir(), "omp-channel-target-"));
  const home = join(parent, "home");
  const backup = join(parent, "backup.json");
  const executable = join(parent, "absent-executable", process.platform === "win32" ? "omp.exe" : "omp");
  try {
    const run = refused(["--home", home, "--profile", "proof", "--executable", executable, "--to", "npm", "--spec", "github:narimanisakhanov-creator/omp-settings-ru#v0.5.0", "--backup", backup, "--apply"], parent);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("channel-target-unsupported");
    expect(existsSync(home)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(run.output).not.toMatch(/uv_spawn|ENOENT|native-executable-required|required:--home/);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reverse npm target is refused before required options are parsed", () => {
  const parent = mkdtempSync(join(tmpdir(), "omp-channel-target-"));
  try {
    const run = refused(["--to", "npm"], parent);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("channel-target-unsupported");
    expect(run.output).not.toMatch(/required:--home|required:--profile|required:--spec/);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("unknown target is not mistaken for the reverse migration", () => {
  const parent = mkdtempSync(join(tmpdir(), "omp-channel-target-"));
  try {
    const run = refused(["--to", "github"], parent);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/^error: channel-invalid\s*$/m);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("configured extension roots are refused before migration", () => {
  const parent = mkdtempSync(join(tmpdir(), "omp-channel-target-"));
  const home = join(parent, "home");
  const profile = "proof";
  mkdirSync(home, { recursive: true });
  try {
    const executable = process.env.OMP_UPDATER_EXECUTABLE;
    expect(executable).toBeTruthy();
    // Write the setting where the host itself says its profile config lives: the layout is
    // host-version specific, and a hardcoded path would silently test "no roots configured".
    const environment = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata") };
    const path = Bun.spawnSync([executable!, "--profile", profile, "config", "path"], { stdout: "pipe", stderr: "pipe", timeout: 30000, env: environment });
    expect(path.exitCode, path.stderr.toString()).toBe(0);
    const agentDir = path.stdout.toString().trim();
    expect(agentDir.length).toBeGreaterThan(0);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "config.yml"), "extensions:\n  - ./src/index.ts\n");
    const result = Bun.spawnSync([process.execPath, script, "--home", home, "--profile", profile, "--executable", executable!, "--to", "marketplace", "--spec", "omp-settings-ru@omp-settings-ru", "--backup", join(parent, "backup.json"), "--apply"], { stdout: "pipe", stderr: "pipe", timeout: 60000, env: { ...process.env, OMP_PLUGIN_EXTENSIONS: undefined } });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output, output).toContain("extension-roots-present");
    expect(existsSync(join(parent, "backup.json"))).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

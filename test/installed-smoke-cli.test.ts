import { expect, test } from "bun:test";
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

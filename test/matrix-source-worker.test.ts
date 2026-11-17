import { expect, test } from "bun:test";
import type { BaselineSnapshot } from "../src/report";
import { readSupportedHosts, snapshotPath } from "../scripts/maintenance/paths";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStrictJSON } from "../scripts/maintenance/json";

const manifest = readSupportedHosts();
const derived = ["win32", "darwin", "linux"].filter(platform => platform !== process.platform);

function exportDerived(alias: string, version: string, platform: string) {
  const directory = mkdtempSync(join(tmpdir(), "registry-worker-test-"));
  try {
    const output = join(directory, "snapshot.json");
    const result = Bun.spawnSync(["bun", "scripts/matrix-registry-worker.ts", alias, version, platform, output], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    if (result.exitCode !== 0) throw new Error(`source export failed for ${alias}/${platform}: ${result.stderr.toString().slice(0, 500)}`);
    return parseStrictJSON(readFileSync(output, "utf8")) as BaselineSnapshot;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const record of manifest.versions) {
  for (const platform of derived) {
    test(`source registry export derives reviewed ${record.version} ${platform} baseline`, async () => {
      const snapshot = exportDerived(record.package, record.version, platform);
      const baseline = await Bun.file(snapshotPath(record.version, platform)).json() as BaselineSnapshot;
      expect(snapshot.version).toBe(record.version);
      expect(snapshot.platform).toBe(platform);
      expect(snapshot.settings).toEqual(baseline.settings);
    }, 60000);
  }
}

test("registry worker isolates snapshots from stdout noise and rejects missing or existing output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-worker-channel-"));
  try {
    const record = manifest.versions[0]!;
    const platform = derived[0]!;
    const output = join(directory, "snapshot.json");
    const preload = join(directory, "noise.ts");
    writeFileSync(preload, 'process.stdout.write("native initialization noise {not-json}\\n");');
    const args = [process.execPath, "--preload", preload, "scripts/matrix-registry-worker.ts", record.package, record.version, platform, output];
    const child = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString()).toContain("native initialization noise");
    const bytes = readFileSync(output, "utf8");
    const snapshot = parseStrictJSON(bytes) as BaselineSnapshot;
    const baseline = await Bun.file(snapshotPath(record.version, platform)).json() as BaselineSnapshot;
    expect(snapshot.settings).toEqual(baseline.settings);
    expect(Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 60000 }).exitCode).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(bytes);
    const missing = Bun.spawnSync([process.execPath, "scripts/matrix-registry-worker.ts", record.package, record.version, platform], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(missing.exitCode).not.toBe(0);
    const noiseOnly = join(directory, "noise-only.ts");
    const absent = join(directory, "absent.json");
    writeFileSync(noiseOnly, 'console.log(JSON.stringify({version:"fake",settings:{}})); process.exit(0);');
    const noResult = Bun.spawnSync([process.execPath, "--preload", noiseOnly, "scripts/matrix-registry-worker.ts", record.package, record.version, platform, absent], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    expect(noResult.exitCode).toBe(0);
    expect(existsSync(absent)).toBe(false);
    expect(() => parseStrictJSON(readFileSync(absent, "utf8"))).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60000);

test("historical darwin snapshot retains Apple completion option", async () => {
  const historical = (manifest.historical ?? []).find(record => record.version === "18.8.4");
  expect(historical).toBeDefined();
  const baseline = await Bun.file(snapshotPath("18.8.4", "darwin")).json() as BaselineSnapshot;
  const appleOption = {value: "apple", label: "Apple", description: "macOS dictionary completions"};
  expect(baseline.settings["spelling.autocomplete"]!.options).toContainEqual(appleOption);
});


import { expect, test } from "bun:test";
import type { BaselineSnapshot } from "../src/report";
import { readSupportedHosts, snapshotPath } from "../scripts/maintenance/paths";

const manifest = readSupportedHosts();
const derived = ["win32", "darwin", "linux"].filter(platform => platform !== process.platform);

function exportDerived(alias: string, version: string, platform: string) {
  const result = Bun.spawnSync(["bun", "scripts/matrix-registry-worker.ts", alias, version, platform], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
  if (result.exitCode !== 0) throw new Error(`source export failed for ${alias}/${platform}: ${result.stderr.toString().slice(0, 500)}`);
  return JSON.parse(result.stdout.toString()) as BaselineSnapshot;
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

test("historical darwin snapshot retains Apple completion option", async () => {
  const historical = (manifest.historical ?? []).find(record => record.version === "18.8.4");
  expect(historical).toBeDefined();
  const baseline = await Bun.file(snapshotPath("18.8.4", "darwin")).json() as BaselineSnapshot;
  const appleOption = {value: "apple", label: "Apple", description: "macOS dictionary completions"};
  expect(baseline.settings["spelling.autocomplete"]!.options).toContainEqual(appleOption);
});


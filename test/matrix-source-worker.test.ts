import { expect, test } from "bun:test";
import type { BaselineSnapshot } from "../src/report";

// The source export derives a non-native platform's registry from package source. That derivation is
// only trustworthy if it reproduces the reviewed baseline exactly, including per-path sourceHash and
// platform-only branches; a wrong platform or version must not pass on shape alone.
const derived = ["win32", "darwin", "linux"].filter(platform => platform !== process.platform);

function exportDerived(alias: string, version: string, platform: string) {
  const result = Bun.spawnSync(["bun", "scripts/matrix-registry-worker.ts", alias, version, platform], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  if (result.exitCode !== 0) throw new Error(`source export failed for ${alias}/${platform}: ${result.stderr.toString().slice(0, 500)}`);
  return JSON.parse(result.stdout.toString()) as BaselineSnapshot;
}

for (const [version, alias] of [["18.6.1", "omp-host-1861"], ["18.8.0", "omp-host-1880"], ["18.8.4", "omp-host-1884"], ["18.8.7", "omp-host-1887"]]) {
  for (const platform of derived) {
    test(`source registry export derives the reviewed ${version} ${platform} baseline`, async () => {
      const snapshot = exportDerived(alias!, version!, platform);
      const baseline = await Bun.file(`baseline/${version}-${platform}.json`).json() as BaselineSnapshot;
      expect(snapshot.version).toBe(version!);
      expect(snapshot.platform).toBe(platform);
      expect(snapshot.settings).toEqual(baseline.settings);
    }, 60000);
  }
}

test("derived source export keeps the darwin-only Apple completion option", async () => {
  const baseline = await Bun.file("baseline/18.8.4-darwin.json").json() as BaselineSnapshot;
  const snapshot = exportDerived("omp-host-1884", "18.8.4", "darwin");
  expect(snapshot.settings).toEqual(baseline.settings);
  const appleOption = {value: "apple", label: "Apple", description: "macOS dictionary completions"};
  expect(snapshot.settings["spelling.autocomplete"]!.options).toContainEqual(appleOption);
  // The Apple option is a darwin-only branch, absent from the win32 baseline for the same version.
  const windows = await Bun.file("baseline/18.8.4-win32.json").json() as BaselineSnapshot;
  expect(windows.settings["spelling.autocomplete"]!.options).not.toContainEqual(appleOption);
});

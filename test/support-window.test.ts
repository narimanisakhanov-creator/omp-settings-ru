import { describe, expect, test } from "bun:test";
import { evidenceHosts, supportWindow, validateSupportedHostsManifest, type SupportedHostsManifest } from "../scripts/maintenance/paths";

describe("support window", () => {
  test("selects three greatest stable versions numerically", () => {
    expect(supportWindow(["18.9.0", "18.10.0", "18.8.9", "18.13.1", "18.13.3"])).toEqual(["18.10.0", "18.13.1", "18.13.3"]);
  });
  test("rejects duplicate and prerelease versions", () => {
    expect(() => supportWindow(["18.1.0", "18.1.0"])).toThrow("support-window-version-duplicate");
    expect(() => supportWindow(["18.1.0-rc.1"])).toThrow("support-window-version-invalid");
  });
  test("rejects an empty active window even when history exists", () => {
    expect(() => validateSupportedHostsManifest({ schemaVersion: 1, versions: [], historical: [] })).toThrow("supported-hosts-invalid");
  });
  test("validates active and historical rows as disjoint evidence", () => {
    const row = (version: string) => ({ version, package: `omp-host-${version.replaceAll(".", "")}`, platforms: ["win32", "darwin", "linux"], baselines: { win32: "a".repeat(64), darwin: "b".repeat(64), linux: "c".repeat(64) } });
    const manifest: SupportedHostsManifest = { schemaVersion: 1, versions: [row("18.13.2"), row("18.13.3")], historical: [row("18.12.6")] };
    expect(validateSupportedHostsManifest(manifest)).toEqual(manifest);
    expect(evidenceHosts(manifest).map(item => item.version)).toEqual(["18.13.2", "18.13.3", "18.12.6"]);
    expect(() => validateSupportedHostsManifest({ ...manifest, historical: [row("18.13.3")] })).toThrow("supported-version-overlap");
    expect(() => validateSupportedHostsManifest({ ...manifest, versions: [row("18.13.3"),row("18.13.2")] })).toThrow("supported-active-window-unsorted");
    expect(() => validateSupportedHostsManifest({ ...manifest, versions: [row("18.13.1"),row("18.13.2"),row("18.13.3"),row("18.13.4")] })).toThrow("supported-active-window-too-large");
    expect(() => validateSupportedHostsManifest({ ...manifest, versions: [{...row("18.13.3"),baselines:{}}] })).toThrow("supported-baselines-invalid");
    expect(evidenceHosts({schemaVersion:1,versions:[row("18.13.3")]})).toEqual([row("18.13.3")]);
  });
});

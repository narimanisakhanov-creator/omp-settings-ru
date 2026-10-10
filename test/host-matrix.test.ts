import { expect, test } from "bun:test";
import { buildCoverageReport, buildDriftReport } from "../src/report";
import { ru } from "../src/translations/ru";
import type { HostMetadata, HostSettingDefinition } from "../src/host-types";

for (const [version, alias] of [["18.6.1", "omp-host-1861"], ["18.8.0", "omp-host-1880"], ["18.8.4", "omp-host-1884"], ["18.8.7", "omp-host-1887"]]) {
  test(`pinned ${version} actual host registry has native baseline identity and complete coverage`, async () => {
    const { orderedSettings } = await import(`${alias}/config/all-settings`);
    const schema: HostMetadata["schema"] = Object.create(null);
    for (const setting of orderedSettings()) schema[setting.id] = setting.definition as HostSettingDefinition;
    const host = { version: version!, platform: process.platform, schema };
    const baseline = await Bun.file(`baseline/${version}-${process.platform}.json`).json();
    expect(buildDriftReport(host, baseline)).toEqual({addedPaths: [], removedPaths: [], changedPaths: []});
    const report = buildCoverageReport(host, ru);
    expect(report.completeSettings).toBe(version === "18.6.1" ? 398 : version === "18.8.7" ? 410 : 404);
    expect(report.sourceHashMismatches).toEqual([]);
  }, 60000);
}

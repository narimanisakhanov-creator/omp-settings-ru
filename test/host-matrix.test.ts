import { expect, test } from "bun:test";
import { buildCoverageReport, buildDriftReport } from "../src/report";
import { ru } from "../src/translations/ru";
import type { HostMetadata, HostSettingDefinition } from "../src/host-types";
import { readSupportedHosts, snapshotPath } from "../scripts/maintenance/paths";

const manifest = readSupportedHosts();
for (const record of manifest.versions) {
  test(`pinned ${record.version} actual host registry has complete coverage`, async () => {
    const { orderedSettings } = await import(`${record.package}/config/all-settings`);
    const schema: HostMetadata["schema"] = Object.create(null);
    for (const setting of orderedSettings()) schema[setting.id] = setting.definition as HostSettingDefinition;
    const host = { version: record.version, platform: process.platform, schema };
    const baseline = await Bun.file(snapshotPath(record.version, process.platform)).json();
    expect(buildDriftReport(host, baseline)).toEqual({addedPaths: [], removedPaths: [], changedPaths: []});
    const report = buildCoverageReport(host, ru);
    expect(report.completeSettings).toBe(report.totalUiSettings);
    expect(report.sourceHashMismatches).toEqual([]);
  }, 60000);
}

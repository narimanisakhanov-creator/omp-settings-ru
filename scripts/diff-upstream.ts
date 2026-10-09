import { buildDriftReport } from "../src/report";
import type { BaselineSnapshot } from "../src/report";
import { loadMatrixHost, requestedPairs } from "./matrix-host";

const pairs = [];
for (const pair of requestedPairs(process.argv.slice(2))) {
  const {host, evidence} = await loadMatrixHost(pair.version, pair.platform);
  const baselinePath = `baseline/${host.version}-${host.platform}.json`;
  const baseline = await Bun.file(baselinePath).json() as BaselineSnapshot;
  const drift = buildDriftReport(host, baseline);
  const ok = baseline.version === host.version && baseline.platform === host.platform && !drift.addedPaths.length && !drift.removedPaths.length && !drift.changedPaths.length;
  pairs.push({hostVersion: host.version, platform: host.platform, evidence, installedPanel: false, baseline: baselinePath, ...drift, ok});
}
const ok = pairs.length > 0 && pairs.every(pair => pair.ok);
console.log(JSON.stringify({ok, pairs}, null, 2));
if (!ok) process.exit(1);

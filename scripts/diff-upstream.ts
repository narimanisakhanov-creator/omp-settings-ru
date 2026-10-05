// Upstream drift CLI: compares the live host registry with the reviewed baseline snapshot for the
// host version and platform. Added, removed and changed settings are reported explicitly, and any
// difference or missing baseline exits nonzero. Reads only host metadata; no configuration or secrets.
import { getHostMetadata } from "../src/host-adapter";
import { buildDriftReport, type BaselineSnapshot } from "../src/report";

const host = await getHostMetadata();
const baselinePath = `baseline/${host.version}-${host.platform}.json`;
const file = Bun.file(baselinePath);
if (!(await file.exists())) {
  console.log(
    JSON.stringify(
      { hostVersion: host.version, platform: host.platform, baseline: baselinePath, missingBaseline: true, ok: false },
      null,
      2,
    ),
  );
  process.exit(1);
}

const baseline = (await file.json()) as BaselineSnapshot;
const drift = buildDriftReport(host, baseline);
const versionMismatch = baseline.version !== host.version || baseline.platform !== host.platform;
const ok = !versionMismatch && drift.addedPaths.length === 0 && drift.removedPaths.length === 0 && drift.changedPaths.length === 0;
console.log(
  JSON.stringify(
    {
      hostVersion: host.version,
      platform: host.platform,
      baseline: baselinePath,
      baselineVersion: baseline.version,
      baselinePlatform: baseline.platform,
      versionMismatch,
      ...drift,
      ok,
    },
    null,
    2,
  ),
);
if (!ok) process.exit(1);

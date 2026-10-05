// Coverage CLI: prints a deterministic report of the fixed host registry against the ru catalog.
// Reads only host metadata through the host adapter; never touches user configuration or credentials.
import { getHostMetadata } from "../src/host-adapter";
import { buildCoverageReport } from "../src/report";
import { ru } from "../src/translations/ru";

const host = await getHostMetadata();
const report = buildCoverageReport(host, ru);
const versionMismatch = host.version !== ru.sourceOmpVersion;
const incomplete =
  versionMismatch ||
  report.untranslatedPaths.length > 0 ||
  report.partialPaths.length > 0 ||
  report.stalePaths.length > 0 ||
  report.optionMismatches.length > 0 ||
  report.sourceHashMismatches.length > 0;

const output = {
  locale: ru.locale,
  sourceOmpVersion: ru.sourceOmpVersion,
  hostVersion: host.version,
  platform: host.platform,
  versionMismatch,
  ok: !incomplete,
  report,
};
console.log(JSON.stringify(output, null, 2));
if (incomplete) process.exit(1);

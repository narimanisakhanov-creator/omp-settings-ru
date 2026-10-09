import { buildCoverageReport } from "../src/report";
import { ru } from "../src/translations/ru";
import { loadMatrixHost, requestedPairs } from "./matrix-host";

const pairs = [];
for (const pair of requestedPairs(process.argv.slice(2))) {
  const {host, evidence} = await loadMatrixHost(pair.version, pair.platform);
  const report = buildCoverageReport(host, ru);
  const ok = report.completeSettings === report.totalUiSettings && !report.sourceHashMismatches.length && !report.optionMismatches.length;
  pairs.push({hostVersion: host.version, platform: host.platform, evidence, installedPanel: false, ok, report});
}
const ok = pairs.length > 0 && pairs.every(pair => pair.ok);
console.log(JSON.stringify({locale: ru.locale, ok, pairs}, null, 2));
if (!ok) process.exit(1);

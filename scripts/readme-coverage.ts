import { buildCoverageReport } from "../src/report";
import { ru } from "../src/translations/ru";
import { loadMatrixHost, requestedPairs } from "./matrix-host";
import { readSupportedHosts } from "./maintenance/paths";
import { renderCompatibility, renderCoverageBadge, renderVersionBadge, replaceCompatibility, replaceCoverageBadge, replaceVersionBadge } from "./maintenance/release-content";
import type { CoveragePair } from "./maintenance/semantic";

/**
 * Управляемый блок README против фактического измерения.
 *
 * Таблица совместимости — не текст, который правит человек: её печатает `renderCompatibility` из покрытия
 * каталога, а `buildReleaseDocuments` перезаписывает блок при каждом выпуске. Здесь тот же расчёт применяется к
 * текущему checkout, поэтому отставшие числа видны как отказ, а не как тихо устаревшая документация.
 *
 * `--check` ничего не пишет: расхождение — код возврата 1 с путём к управляемому блоку. `--write` заменяет
 * ровно блок между маркерами, оставляя остальной README байт в байт.
 */

const README = "README.md";

async function measuredPairs(): Promise<readonly CoveragePair[]> {
  const manifest = readSupportedHosts();
  const pairs: CoveragePair[] = [];
  // Ровно активное окно: исторические версии остаются данными, но не обещанием поддержки и не строками README.
  for (const record of manifest.versions) {
    for (const pair of requestedPairs([record.version])) {
      const { host } = await loadMatrixHost(pair.version, pair.platform);
      const report = buildCoverageReport(host, ru);
      pairs.push({ version: pair.version, platform: pair.platform, complete: report.completeSettings, total: report.totalUiSettings });
    }
  }
  return pairs;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const unknown = process.argv.slice(2).filter(arg => arg !== "--write" && arg !== "--check");
  if (unknown.length > 0) throw new Error(`readme-coverage-argument-invalid:${unknown[0]}`);

  const manifest = readSupportedHosts();
  const versions = manifest.versions.map(record => record.version);
  const pairs = await measuredPairs();
  const section = renderCompatibility(versions, pairs);
  const badges = renderVersionBadge(versions);
  const coverageBadge = renderCoverageBadge(versions, pairs);
  const readme = await Bun.file(README).text();
  const expected = replaceCompatibility(
    replaceCoverageBadge(replaceVersionBadge(readme, badges), coverageBadge),
    section,
  );

  if (expected === readme) {
    console.log(JSON.stringify({ ok: true, versions, block: "current" }));
    return;
  }
  if (!write) {
    console.error("readme-coverage-stale: запусти `bun run readme:write`, чтобы пересчитать бейджи и таблицу из измерения");
    process.exitCode = 1;
    return;
  }
  await Bun.write(README, expected);
  console.log(JSON.stringify({ ok: true, versions, block: "rewritten" }));
}

if (import.meta.main) await main();

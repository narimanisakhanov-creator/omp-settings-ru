import { expect, test } from "bun:test";
import rawPolicy from "../maintenance.config.json";
import type { SourcePlatform } from "../scripts/maintenance/contracts";
import { SUPPORT_WINDOW_SIZE, readSupportedHosts, supportWindow } from "../scripts/maintenance/paths";
import { compareVersions, validatePolicy } from "../scripts/maintenance/policy";

interface MatrixPair { readonly version: string; readonly os: string; readonly platform: SourcePlatform }
interface CiMatrix { readonly include: readonly MatrixPair[] }

/** Политика читается напрямую из `maintenance.config.json`, без запуска проверяемого скрипта. */
const policy = validatePolicy(rawPolicy);

/** Кандидат — следующий patch после последней активной версии: в тесте нет литерала версии. */
function nextCandidate(active: readonly string[]): string {
  const latest = active[active.length - 1];
  if (!latest) throw new Error("supported-active-window-empty");
  const [major, minor, patch] = latest.split(".").map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + 1}`;
}

test("CI candidate support rotates the active window", () => {
  const manifest = readSupportedHosts();
  const active = manifest.versions.map(record => record.version).sort(compareVersions);
  const candidate = nextCandidate(active);
  const expectedVersions = supportWindow([...active, candidate]);
  expect(expectedVersions).toHaveLength(SUPPORT_WINDOW_SIZE);

  const result = Bun.spawnSync(["bun", "scripts/check-matrix.ts", "--ci-matrix", "--candidate", candidate], {stdout: "pipe", stderr: "pipe"});
  expect(result.exitCode).toBe(0);
  const matrix = JSON.parse(result.stdout.toString()) as CiMatrix;

  // Ожидание строится независимо: окно из манифеста × платформы из политики, в объявленном порядке.
  const expectedInclude = expectedVersions.flatMap(version =>
    policy.requiredCheckPlatforms.map(({os, platform}) => ({version, os, platform})));
  expect(matrix.include).toEqual(expectedInclude);

  // Инвариант ротации: кандидат входит, самая старая активная версия выпадает, остальные остаются.
  const actualVersions = [...new Set(matrix.include.map(pair => pair.version))];
  expect(actualVersions).toEqual([...expectedVersions]);
  expect(actualVersions).not.toContain(active[0]!);
  expect(actualVersions).toEqual(expect.arrayContaining(active.slice(1)));
  expect(actualVersions).toContain(candidate);
  expect(matrix.include).toHaveLength(SUPPORT_WINDOW_SIZE * policy.requiredCheckPlatforms.length);

  // Каждая версия окна покрыта всеми платформами политики ровно в объявленном порядке.
  for (const version of actualVersions) {
    expect(matrix.include.filter(pair => pair.version === version).map(({os, platform}) => ({os, platform})))
      .toEqual(policy.requiredCheckPlatforms.map(({os, platform}) => ({os, platform})));
  }
});

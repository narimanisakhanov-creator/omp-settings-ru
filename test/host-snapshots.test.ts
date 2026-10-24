import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import rawPolicy from "../maintenance.config.json";
import { validatePolicy } from "../scripts/maintenance/policy";
import { SNAPSHOT_DIR, SNAPSHOT_PLATFORMS, SUPPORTED_HOSTS, snapshotPath } from "../scripts/maintenance/paths";

/**
 * Канонический каталог снимков — единственный отслеживаемый экземпляр данных хоста.
 *
 * `baseline/` в checkout остаётся локальным: он не попадает в Git, поэтому каждый читатель и писатель берёт
 * путь из `scripts/maintenance/paths.ts`. Здесь проверяется статическая связь «каталог ↔ манифест ↔
 * политика кандидата»: снимок без записи в манифесте, подменённые байты или путь, выпавший из allowlist,
 * ломают покрытие и drift молча, поэтому отказ должен приходить до измерения.
 */
const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, SUPPORTED_HOSTS), "utf8")) as {
  schemaVersion: number;
  versions: readonly { version: string; platforms: readonly string[]; baselines: Readonly<Record<string, string>> }[];
};

test("канонический каталог содержит ровно объявленные пары версия × платформа", () => {
  expect(manifest.schemaVersion).toBe(1);
  const expected: string[] = [];
  for (const row of manifest.versions) {
    expect(row.platforms).toEqual([...SNAPSHOT_PLATFORMS]);
    for (const platform of row.platforms) expected.push(`${row.version}-${platform}.json`);
  }
  const actual = readdirSync(join(root, SNAPSHOT_DIR)).filter(name => name.endsWith(".json") && name !== "supported-hosts.json").sort();
  expect(actual).toEqual(expected.sort());
});

test("sha256 каждого снимка совпадает с записью манифеста", () => {
  const mismatches: string[] = [];
  for (const row of manifest.versions) {
    for (const [platform, expected] of Object.entries(row.baselines)) {
      const actual = createHash("sha256").update(readFileSync(join(root, snapshotPath(row.version, platform)))).digest("hex");
      if (actual !== expected) mismatches.push(`${row.version}-${platform}`);
    }
  }
  expect(mismatches).toEqual([]);
});

test("политика кандидата разрешает ровно канонические пути данных", () => {
  const policy = validatePolicy(rawPolicy);
  const allowed = [SUPPORTED_HOSTS, ...SNAPSHOT_PLATFORMS.map(platform => snapshotPath("<candidate>", platform))].sort();
  expect(policy.executorPaths.filter(path => path.startsWith(SNAPSHOT_DIR)).sort()).toEqual(allowed);
});

test("канонический каталог не игнорируется, а локальный baseline/ — игнорируется", () => {
  // `--no-index` проверяет сами правила: пока parent не убрал `baseline/` из индекса, обычный check-ignore
  // молчит про отслеживаемые файлы.
  const ignored = (path: string) => Bun.spawnSync(["git", "check-ignore", "-q", "--no-index", "--", path], { cwd: root }).exitCode === 0;
  expect(ignored(SUPPORTED_HOSTS)).toBe(false);
  expect(ignored(snapshotPath("18.8.7", "win32"))).toBe(false);
  expect(ignored("baseline/18.8.7-win32.json")).toBe(true);
});

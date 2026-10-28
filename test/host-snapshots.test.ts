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
  historical?: readonly { version: string; platforms: readonly string[]; baselines: Readonly<Record<string, string>> }[];
};
const evidence = [...manifest.versions, ...(manifest.historical ?? [])];

test("канонический каталог содержит ровно объявленные пары версия × платформа", () => {
  expect(manifest.schemaVersion).toBe(1);
  const expected: string[] = [];
  for (const row of evidence) {
    expect(row.platforms).toEqual([...SNAPSHOT_PLATFORMS]);
    for (const platform of row.platforms) expected.push(`${row.version}-${platform}.json`);
  }
  const actual = readdirSync(join(root, SNAPSHOT_DIR)).filter(name => name.endsWith(".json") && name !== "supported-hosts.json").sort();
  expect(actual).toEqual(expected.sort());
});

test("sha256 каждого снимка совпадает с записью манифеста", () => {
  const mismatches: string[] = [];
  for (const row of evidence) {
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

/**
 * Пользовательские документы выпуска — часть checkout, а не локальный артефакт.
 *
 * `upgrade-report.md` пишет verify до коммита кандидата, а CHANGELOG ссылается на него абсолютным URL тега:
 * пока файл игнорировался, отчёт не попадал в коммит и ссылка выпуска вела в никуда. Документы обязаны быть
 * отслеживаемыми и не закрытыми правилами `.gitignore`.
 */
test("документы выпуска отслеживаются и не игнорируются", () => {
  for (const path of ["README.md", "CHANGELOG.md", "upgrade-report.md"]) {
    expect(Bun.spawnSync(["git", "check-ignore", "-q", "--no-index", "--", path], { cwd: root }).exitCode).not.toBe(0);
    expect(Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", path], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  }
});

/**
 * README — представление того же манифеста, поэтому новая поддержанная версия обязана появиться в нём в том же
 * изменении. Проверяется связь «манифест ↔ опубликованная таблица», а не её формулировки: таблица, отставшая
 * от манифеста, вводит читателя в заблуждение молча.
 */
test("управляемый блок README перечисляет ровно версии манифеста", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const start = "<!-- omp-supported:start -->";
  const end = "<!-- omp-supported:end -->";
  expect(readme.split(start)).toHaveLength(2);
  expect(readme.split(end)).toHaveLength(2);
  const block = readme.slice(readme.indexOf(start) + start.length, readme.indexOf(end));
  const rows = block.split("\n").map(line => /^\| (\d+\.\d+\.\d+) \|(?: [^\n|]+ \|)+$/.exec(line)).filter(match => match !== null);
  expect(rows.map(match => match[1])).toEqual(manifest.versions.map(row => row.version));
});

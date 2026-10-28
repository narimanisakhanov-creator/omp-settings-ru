import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "./policy";

/**
 * Канонический каталог снимков метаданных хоста.
 *
 * Снимки — данные, а не код: их читают покрытие, drift, матрица CI и hosted pipeline, и они же служат базой
 * для проверки нового кандидата. Отслеживаемый экземпляр ровно один — этот каталог; `baseline/` в checkout
 * остаётся локальным и в Git не попадает. И писатель, и все читатели берут путь только отсюда, поэтому
 * перенос каталога не может разойтись между ними.
 */
export const SNAPSHOT_DIR = "test/fixtures/host-snapshots";

/** Манифест поддержанных хостов: версии, алиасы пакетов, платформы и sha256 снимков. */
export const SUPPORTED_HOSTS = `${SNAPSHOT_DIR}/supported-hosts.json`;

/** Платформы, для которых снимается каждая поддержанная версия. */
export const SNAPSHOT_PLATFORMS = ["win32", "darwin", "linux"] as const;

/**
 * Размер активного окна поддержки.
 *
 * Поддерживаются ровно три последние стабильные версии OMP: это единственный контракт, который читают выбор
 * очереди, ротация манифеста, CI-матрица и README. Больше никто не задаёт это число своим литералом.
 */
export const SUPPORT_WINDOW_SIZE = 3;

/** Путь снимка одной пары «версия × платформа». */
export function snapshotPath(version: string, platform: string): string {
  return `${SNAPSHOT_DIR}/${version}-${platform}.json`;
}

export interface SupportedHostRecord {
  readonly version: string;
  readonly package: string;
  readonly platforms: readonly string[];
  readonly baselines?: Readonly<Record<string, string>>;
}

/**
 * Манифест поддержки: активное окно и замороженная история.
 *
 * `versions` — исполняемая поддержка, `historical` — выбывшие записи, сохранённые вместе со снимками.
 */
export interface SupportedHostsManifest {
  readonly schemaVersion: number;
  readonly versions: readonly SupportedHostRecord[];
  readonly historical?: readonly SupportedHostRecord[];
  readonly [key: string]: unknown;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;

function validateRows(rows: unknown, section: string, seen: Set<string>): SupportedHostRecord[] {
  if (!Array.isArray(rows) || rows.length === 0 && section === "active") throw new Error("supported-hosts-invalid");
  const result: SupportedHostRecord[] = [];
  for (const raw of rows as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`supported-${section}-row-invalid`);
    const row = raw as Record<string, unknown>;
    if (typeof row.version !== "string" || !STABLE_VERSION.test(row.version)) throw new Error(`supported-version-invalid:${String(row.version)}`);
    if (seen.has(row.version)) throw new Error(`supported-version-overlap:${row.version}`);
    seen.add(row.version);
    if (row.package !== hostAlias(row.version)) throw new Error(`supported-package-invalid:${row.version}`);
    if (!Array.isArray(row.platforms) || row.platforms.length !== SNAPSHOT_PLATFORMS.length || new Set(row.platforms).size !== SNAPSHOT_PLATFORMS.length || row.platforms.some(platform => !SNAPSHOT_PLATFORMS.includes(platform as typeof SNAPSHOT_PLATFORMS[number]))) {
      throw new Error(`supported-platforms-invalid:${row.version}`);
    }
    const baselines = row.baselines;
    if (typeof baselines !== "object" || baselines === null || Array.isArray(baselines)) throw new Error(`supported-baselines-invalid:${row.version}`);
    const baselineRecord = baselines as Record<string, unknown>;
    if (Object.keys(baselineRecord).sort().join(",") !== [...SNAPSHOT_PLATFORMS].sort().join(",") || Object.values(baselineRecord).some(value => typeof value !== "string" || !SHA256.test(value))) throw new Error(`supported-baselines-invalid:${row.version}`);
    result.push({ ...row, version: row.version, package: row.package, platforms: [...row.platforms] as string[], baselines: { ...baselineRecord } as Record<string, string> });
  }
  return result;
}

function hostAlias(version: string): string {
  return `omp-host-${version.replaceAll(".", "")}`;
}

/** Validate the production manifest before any measurement subprocess is started. */
export function validateSupportedHostsManifest(value: unknown): SupportedHostsManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("supported-hosts-invalid");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("supported-hosts-schema-invalid");
  const seen = new Set<string>();
  const versions = validateRows(raw.versions, "active", seen);
  if (versions.length > SUPPORT_WINDOW_SIZE) throw new Error("supported-active-window-too-large");
  if (versions.some((row, index) => index > 0 && compareVersions(versions[index - 1]!.version, row.version) >= 0)) throw new Error("supported-active-window-unsorted");
  const historical = raw.historical === undefined ? [] : validateRows(raw.historical, "historical", seen);
  if (historical.some((row, index) => index > 0 && compareVersions(historical[index - 1]!.version, row.version) >= 0)) throw new Error("supported-history-unsorted");
  return { ...raw, schemaVersion: 1, versions, historical };
}

/** Активное окно + замороженная история: источник проверки маркеров и целостности снимков. */
export function evidenceHosts(manifest: SupportedHostsManifest): readonly SupportedHostRecord[] {
  const validated = validateSupportedHostsManifest(manifest);
  return [...validated.versions, ...validated.historical!];
}

/** Последние стабильные версии в числовом порядке по возрастанию. */
export function supportWindow(versions: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const version of versions) {
    if (typeof version !== "string" || !STABLE_VERSION.test(version)) throw new Error(`support-window-version-invalid:${String(version)}`);
    if (seen.has(version)) throw new Error(`support-window-version-duplicate:${version}`);
    seen.add(version);
  }
  return [...versions].sort(compareVersions).slice(-SUPPORT_WINDOW_SIZE);
}

/** Манифест этого checkout: валидируется до передачи данных subprocess-ам. */
export function readSupportedHosts(): SupportedHostsManifest {
  return validateSupportedHostsManifest(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", SUPPORTED_HOSTS), "utf8")));
}

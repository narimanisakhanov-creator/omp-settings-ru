import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export interface SupportedHostsManifest {
  readonly schemaVersion: number;
  readonly versions: readonly SupportedHostRecord[];
}

/** Манифест этого checkout: путь разрешается от модуля, а не от текущего каталога процесса. */
export function readSupportedHosts(): SupportedHostsManifest {
  return JSON.parse(readFileSync(join(import.meta.dir, "..", "..", SUPPORTED_HOSTS), "utf8")) as SupportedHostsManifest;
}

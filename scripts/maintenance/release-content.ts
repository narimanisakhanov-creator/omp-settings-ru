import type { BaselineSnapshot } from "../../src/report";
import type { SourcePlatform } from "../../src/translations/types";
import type { CatalogEntry, CoveragePair } from "./semantic";
import { compareVersions } from "./policy";

/**
 * Пользовательские материалы выпуска: README-блок поддержки, раздел CHANGELOG и подробный отчёт.
 *
 * Модуль детерминированный и чистый: ни сети, ни файлов, ни модели. Всё, что попадает в текст, — измеренное
 * значение из переданных данных; отсутствующее значение — отказ, а не ноль и не догадка. Поэтому один и тот же
 * вход всегда даёт те же байты, и выпуск можно пересчитать и сверить побайтово.
 */

/** Канонический репозиторий публикации: абсолютная ссылка обязана работать и в теле GitHub Release. */
const RELEASE_REPOSITORY = "narimanisakhanov-creator/omp-settings-ru";

/**
 * Порядок платформ в тексте. Он не совпадает с порядком обхода снимков (`SNAPSHOT_PLATFORMS`): файлы читаются
 * в одном порядке, а человеку Windows, Linux и macOS показываются в этом. Оба порядка фиксированы явно, чтобы
 * вывод не зависел от порядка ключей JSON или машинной локали.
 */
const DISPLAY_PLATFORMS: readonly SourcePlatform[] = ["win32", "linux", "darwin"];
const PLATFORM_LABELS: Readonly<Record<SourcePlatform, string>> = { win32: "Windows", linux: "Linux", darwin: "macOS" };
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Маркеры управляемого блока README: ровно одна пара, иначе замена неоднозначна. */
export const COMPATIBILITY_START = "<!-- omp-supported:start -->";
export const COMPATIBILITY_END = "<!-- omp-supported:end -->";

/** Порядок строк по коду символа: лексикографический и независимый от локали. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(reason: string): never {
  throw new Error(`release-content-invalid:${reason}`);
}

type CoverageGrid = ReadonlyMap<string, ReadonlyMap<SourcePlatform, CoveragePair>>;

/**
 * Сетка «версия × платформа» из измерения. Пропуск пары, дубль, чужая платформа или нечисловое покрытие —
 * отказ: таблица поддержки не имеет права показать неполное измерение как полное.
 *
 * `requireComplete` включается там, где неполное покрытие нельзя честно описать словами: сводка перевода
 * утверждает, что каталог подходит к исходным текстам версии, и при `complete < total` это было бы неправдой.
 * README же показывает измеренные числа как есть, поэтому там неполнота остаётся видимой цифрой.
 */
function coverageGrid(versions: readonly string[], coverage: readonly CoveragePair[], requireComplete: boolean): CoverageGrid {
  const grid = new Map<string, Map<SourcePlatform, CoveragePair>>();
  const expected = new Set(versions);
  for (const pair of coverage) {
    if (!expected.has(pair.version)) continue;
    if (!DISPLAY_PLATFORMS.includes(pair.platform as SourcePlatform)) invalid(`coverage-platform-invalid:${pair.version}-${pair.platform}`);
    const platform = pair.platform as SourcePlatform;
    const row = grid.get(pair.version) ?? new Map<SourcePlatform, CoveragePair>();
    if (row.has(platform)) invalid(`coverage-duplicate:${pair.version}-${platform}`);
    if (!Number.isSafeInteger(pair.complete) || !Number.isSafeInteger(pair.total) || pair.total <= 0 || pair.complete < 0 || pair.complete > pair.total) {
      invalid(`coverage-value-invalid:${pair.version}-${platform}`);
    }
    row.set(platform, pair);
    grid.set(pair.version, row);
  }
  for (const version of versions) {
    const row = grid.get(version);
    if (!row) invalid(`coverage-missing:${version}`);
    for (const platform of DISPLAY_PLATFORMS) {
      if (!row.has(platform)) invalid(`coverage-missing:${version}-${platform}`);
      if (requireComplete && row.get(platform)!.complete !== row.get(platform)!.total) invalid(`coverage-incomplete:${version}-${platform}`);
    }
  }
  return grid;
}

/** Снимки одной версии: ровно по одному на платформу и с совпадающей версией. */
function snapshotsByPlatform(
  snapshots: readonly BaselineSnapshot[], version: string, side: "previous" | "current",
): ReadonlyMap<SourcePlatform, BaselineSnapshot> {
  const byPlatform = new Map<SourcePlatform, BaselineSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.version !== version) invalid(`snapshot-version-mismatch:${side}-${snapshot.platform}`);
    if (!DISPLAY_PLATFORMS.includes(snapshot.platform as SourcePlatform)) invalid(`snapshot-platform-invalid:${side}-${snapshot.platform}`);
    const platform = snapshot.platform as SourcePlatform;
    if (byPlatform.has(platform)) invalid(`snapshot-duplicate:${side}-${platform}`);
    byPlatform.set(platform, snapshot);
  }
  for (const platform of DISPLAY_PLATFORMS) if (!byPlatform.has(platform)) invalid(`snapshot-missing:${side}-${platform}`);
  return byPlatform;
}

/**
 * Экранирование пользовательского текста: Markdown, HTML и переводы строк не должны управлять разметкой.
 *
 * Набор символов минимальный — только те, что реально ломают встроенный текст. Дефисы и точки в названиях
 * настроек остаются как есть: `Тайм\-аут` читается хуже, чем `Тайм-аут`, а списка из середины строки не выйдет.
 */
function escapeLabel(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/[\\`*_[\]()<>|&#~]/g, "\\$&");
}

/** Технический путь остаётся читаемым: экранируются только символы, ломающие код-обрыв и таблицу. */
function escapePath(path: string, inTable = false): string {
  const escaped = path.replace(/\r?\n/g, " ").replace(/[\\`]/g, "\\$&");
  return `\`${inTable ? escaped.replace(/\|/g, "\\|") : escaped}\``;
}

/**
 * Блок поддержки для README. Все версии берутся из манифеста поддержанных хостов, покрытие — из измерения
 * ровно этих пар: никакой «последней версии npm» и никакой сводки платформ в одно число.
 */
export function renderCompatibility(versions: readonly string[], coverage: readonly CoveragePair[]): string {
  if (versions.length === 0) invalid("versions-empty");
  if (new Set(versions).size !== versions.length) invalid("versions-duplicate");
  for (const version of versions) if (!STABLE_VERSION.test(version)) invalid(`version-invalid:${version}`);
  const grid = coverageGrid(versions, coverage, false);
  const ordered = [...versions].sort(compareVersions);
  const rows = ordered.map(version => {
    const cells = DISPLAY_PLATFORMS.map(platform => {
      const pair = grid.get(version)!.get(platform)!;
      return `${pair.complete}/${pair.total}`;
    });
    return `| ${version} | ${cells.join(" | ")} |`;
  });
  return [
    "## поддерживаемые версии OMP",
    "",
    `Поддержка в этом checkout: OMP ${ordered.join(", ")}.`,
    "",
    `| OMP | ${DISPLAY_PLATFORMS.map(platform => PLATFORM_LABELS[platform]).join(" | ")} |`,
    "| --- | ---: | ---: | ---: |",
    ...rows,
    "",
    "в ячейке — измеренное покрытие каталога для точной пары «версия × платформа» (`bun scripts/check-coverage.ts <версия> <платформа>`); другое число в ячейке означает другое измерение, а не округление.",
    "список относится к текущему checkout: совместимость опубликованного пакета определяется тегом его выпуска, а не этим файлом.",
    "источники — [манифест поддержанных хостов](test/fixtures/host-snapshots/supported-hosts.json) и exact-commit CI [check.yml](.github/workflows/check.yml); покрытие платформы, отличной от раннера, выведено из источника пакета и нативную панель не доказывает.",
    "",
    "неизвестный путь или изменившийся источник остаётся английским; неизвестная версия не становится поддержанной от совпадения строк. определения уровней доказательств — в [CONTRIBUTING](CONTRIBUTING.md#матрица-и-peer-диапазон).",
  ].join("\n");
}

/**
 * Замена управляемого блока README. Текст вне пары маркеров сохраняется байт в байт: расширенный allowlist
 * кандидата не должен превращаться в право переписать установку или ссылки.
 */
export function replaceCompatibility(readme: string, section: string): string {
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = readme.indexOf(COMPATIBILITY_START); index >= 0; index = readme.indexOf(COMPATIBILITY_START, index + 1)) starts.push(index);
  for (let index = readme.indexOf(COMPATIBILITY_END); index >= 0; index = readme.indexOf(COMPATIBILITY_END, index + 1)) ends.push(index);
  if (starts.length !== 1 || ends.length !== 1) throw new Error("readme-support-markers-invalid");
  const start = starts[0]!;
  const end = ends[0]!;
  if (start > end) throw new Error("readme-support-markers-invalid");
  const head = readme.slice(0, start + COMPATIBILITY_START.length);
  const tail = readme.slice(end);
  return `${head}\n${section}\n${tail}`;
}

export interface ReleaseContentInput {
  readonly releaseVersion: string;
  readonly previousHostVersion: string;
  readonly upstreamVersion: string;
  readonly versions: readonly string[];
  readonly before: readonly CatalogEntry[];
  readonly after: readonly CatalogEntry[];
  readonly previousSnapshots: readonly BaselineSnapshot[];
  readonly currentSnapshots: readonly BaselineSnapshot[];
  readonly coverage: readonly CoveragePair[];
}

export interface ReleaseContent {
  readonly changelogSection: string;
  readonly report: string;
}

/** Принятые пользовательские документы базы: их содержимое вне управляемых частей не переписывается. */
export interface ReleaseBaseDocuments {
  readonly readme: string;
  readonly changelog: string;
}

export interface ReleaseDocuments {
  readonly readme: string;
  readonly changelog: string;
  readonly report: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Раздел выпуска уже присутствует в принятом CHANGELOG.
 *
 * Повторная генерация не имеет права ни продублировать секцию, ни переписать историю: заголовок `## <версия>`
 * в любом из принятых форматов (с ссылкой или без) означает, что версия уже описана человеком или прошлым
 * выпуском, и автоматическая запись здесь была бы перезаписью.
 */
export function hasReleaseHeading(changelog: string, releaseVersion: string): boolean {
  // Граница после версии обязательна: без неё `0.7.1` совпало бы с заголовком `0.7.10`, и выпуск отказал бы
  // из-за чужой секции. Допустимы только конец строки, `]` (ссылочная форма) и пробел/скобка после версии.
  return new RegExp(`^##\\s+(?:\\[)?${escapeRegExp(releaseVersion)}(?=$|\\]|\\s|\\()`, "m").test(changelog);
}

/**
 * Три пользовательских документа выпуска из проверенных данных.
 *
 * README — только управляемый блок поверх принятых байтов, CHANGELOG — новая секция перед принятыми байтами,
 * отчёт — подробный список. Ни один документ не содержит ничего, чего нет во входных данных, поэтому повторный
 * вызов на том же входе даёт те же байты, а расхождение с коммитом — обнаружимое доказательство подмены.
 */
export function buildReleaseDocuments(input: ReleaseContentInput, base: ReleaseBaseDocuments): ReleaseDocuments {
  if (hasReleaseHeading(base.changelog, input.releaseVersion)) throw new Error("release-changelog-version-conflict");
  const readme = replaceCompatibility(base.readme, renderCompatibility(input.versions, input.coverage));
  const { changelogSection, report } = renderTranslationUpdate(input);
  return { readme, changelog: `${changelogSection}\n\n${base.changelog}`, report };
}

interface PathRow {
  readonly path: string;
  readonly labels: string[];
  readonly variants: { readonly sourceHash: string; readonly labels: string[]; readonly platforms: readonly SourcePlatform[] }[];
}

/** Один путь настройки: названия всех его новых вариантов, без дублей и в стабильном порядке. */
function mergeRow(rows: Map<string, PathRow>, path: string, sourceHash: string, labels: readonly string[], platforms: readonly SourcePlatform[]): void {
  const row = rows.get(path) ?? { path, labels: [], variants: [] };
  for (const label of labels) if (!row.labels.includes(label)) row.labels.push(label);
  row.labels.sort(compareText);
  row.variants.push({ sourceHash, labels: [...labels].sort(compareText), platforms: [...platforms] });
  rows.set(path, row);
}

/** Русское согласование числа с существительным: «1 настройка», «2 настройки», «5 настроек». */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Первые четыре названия с путями плюс честный остаток: «ещё K». */
function summary(rows: readonly PathRow[]): string {
  const shown = rows.slice(0, 4).map(row => `${row.labels.map(escapeLabel).join(" / ")} (${escapePath(row.path)})`);
  const rest = rows.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? `; ещё ${rest}` : ""}`;
}

/**
 * Заголовок раздела отчёта: настроек — по уникальным путям, вариантов — по уникальным «путь + sourceHash».
 *
 * Числа расходятся, когда у одной настройки появилось несколько вариантов перевода: счётчик настроек не имеет
 * права их складывать, а счётчик вариантов — умножать на платформы.
 */
function sectionHeading(title: string, rows: readonly PathRow[]): string {
  const variants = rows.reduce((total, row) => total + row.variants.length, 0);
  if (variants === rows.length) return `## ${title} (${rows.length})`;
  const settings = `${rows.length} ${plural(rows.length, "настройка", "настройки", "настроек")}`;
  return `## ${title} (${settings}, ${variants} ${plural(variants, "вариант", "варианта", "вариантов")})`;
}

function sortedRows(rows: ReadonlyMap<string, PathRow>): readonly PathRow[] {
  return [...rows.values()].sort((left, right) => compareText(left.path, right.path));
}

/**
 * Сводка перевода и подробный отчёт для одного выпуска.
 *
 * Категории считаются по каталогу базы и кандидата и проверяются по снимкам новой версии: настройка попадает в
 * сводку только если её вариант реально отдаётся новой версией на этой платформе. Исторические варианты
 * остаются в каталоге и в счётчики новых не попадают.
 */
export function renderTranslationUpdate(input: ReleaseContentInput): ReleaseContent {
  for (const [name, value] of [["releaseVersion", input.releaseVersion], ["previousHostVersion", input.previousHostVersion], ["upstreamVersion", input.upstreamVersion]] as const) {
    if (!STABLE_VERSION.test(value)) invalid(`${name}-invalid`);
  }
  const grid = coverageGrid(input.versions, input.coverage, true);
  if (!grid.has(input.upstreamVersion)) invalid(`version-missing:${input.upstreamVersion}`);

  const previous = snapshotsByPlatform(input.previousSnapshots, input.previousHostVersion, "previous");
  const current = snapshotsByPlatform(input.currentSnapshots, input.upstreamVersion, "current");

  // Фактически используемые варианты новой версии: путь, sourceHash и платформы, где он отдаётся.
  const used = new Map<string, { path: string; sourceHash: string; platforms: SourcePlatform[] }>();
  for (const platform of DISPLAY_PLATFORMS) {
    for (const [path, source] of Object.entries(current.get(platform)!.settings)) {
      const key = `${path}\u0000${source.sourceHash}`;
      const row = used.get(key) ?? { path, sourceHash: source.sourceHash, platforms: [] };
      row.platforms.push(platform);
      used.set(key, row);
    }
  }

  const beforePaths = new Set(input.before.map(entry => entry.path));
  const beforeVariants = new Map<string, CatalogEntry[]>();
  for (const entry of input.before) {
    const key = `${entry.path}\u0000${entry.sourceHash}`;
    const rows = beforeVariants.get(key) ?? [];
    rows.push(entry);
    beforeVariants.set(key, rows);
  }

  const created = new Map<string, PathRow>();
  const updated = new Map<string, PathRow>();
  const extended = new Map<string, PathRow>();
  const keys = [...used.keys()].sort((left, right) => compareText(left, right));
  for (const key of keys) {
    const row = used.get(key)!;
    const matching = input.after.filter(entry => entry.path === row.path && entry.sourceHash === row.sourceHash);
    if (matching.length === 0) invalid(`catalog-variant-missing:${row.path}:${row.sourceHash}`);
    // Один и тот же источник может иметь разные варианты под разные платформы: в сводку попадают только те,
    // что реально обслуживают используемые платформы новой версии. Чужой label — это другая настройка.
    const served = matching.filter(entry => entry.platforms.some(platform => row.platforms.includes(platform)));
    if (served.length === 0) invalid(`catalog-platform-missing:${row.path}:${row.platforms.join(",")}`);
    const catalogPlatforms = new Set(served.flatMap(entry => entry.platforms));
    for (const platform of row.platforms) if (!catalogPlatforms.has(platform)) invalid(`catalog-platform-missing:${row.path}:${platform}`);
    const labels = [...new Set(served.flatMap(entry => entry.label ?? ""))].filter(label => label !== "");
    if (labels.length === 0) invalid(`label-empty:${row.path}`);
    if (!beforePaths.has(row.path)) mergeRow(created, row.path, row.sourceHash, labels, row.platforms);
    else if (!beforeVariants.has(key)) mergeRow(updated, row.path, row.sourceHash, labels, row.platforms);
    else {
      const accepted = new Set(beforeVariants.get(key)!.flatMap(entry => entry.platforms));
      const added = row.platforms.filter(platform => !accepted.has(platform));
      if (added.length > 0) mergeRow(extended, row.path, row.sourceHash, labels, added);
    }
  }

  // Исчезнувшая из OMP настройка: сравниваются объединения путей трёх снимков старого и нового хоста.
  // Каталог при этом не чистится — исторический перевод остаётся в нём.
  const previousPaths = new Map<string, SourcePlatform[]>();
  for (const platform of DISPLAY_PLATFORMS) {
    for (const path of Object.keys(previous.get(platform)!.settings)) {
      const platforms = previousPaths.get(path) ?? [];
      platforms.push(platform);
      previousPaths.set(path, platforms);
    }
  }
  const currentPaths = new Set<string>();
  for (const platform of DISPLAY_PLATFORMS) for (const path of Object.keys(current.get(platform)!.settings)) currentPaths.add(path);
  const removed = [...previousPaths.keys()].filter(path => !currentPaths.has(path)).sort(compareText);

  const createdRows = sortedRows(created);
  const updatedRows = sortedRows(updated);
  const extendedRows = sortedRows(extended);

  const coverageText = [...input.versions].sort(compareVersions).map(version => {
    const cells = DISPLAY_PLATFORMS.map(platform => grid.get(version)!.get(platform)!);
    const uniform = cells.every(pair => pair.complete === cells[0]!.complete && pair.total === cells[0]!.total);
    return uniform
      ? `${version} ${cells[0]!.complete}/${cells[0]!.total}`
      : `${version} ${DISPLAY_PLATFORMS.map((platform, index) => `${platform} ${cells[index]!.complete}/${cells[index]!.total}`).join(", ")}`;
  }).join(", ");
  const reportUrl = `https://github.com/${RELEASE_REPOSITORY}/blob/v${input.releaseVersion}/upgrade-report.md`;

  const bullets: string[] = [];
  if (createdRows.length > 0) bullets.push(`Новые настройки на русском: ${createdRows.length} — ${summary(createdRows)}.`);
  if (updatedRows.length > 0) bullets.push(`Обновлены переводы изменившихся настроек: ${updatedRows.length} — ${summary(updatedRows)}.`);
  if (extendedRows.length > 0) bullets.push(`Расширена доступность существующих переводов на платформах: ${extendedRows.length} ${plural(extendedRows.length, "настройка", "настройки", "настроек")}.`);
  if (bullets.length === 0) bullets.push("Новых переводов не потребовалось; существующий русский каталог подходит к исходным текстам этой версии.");
  if (removed.length > 0) bullets.push(`Больше не доступны в OMP ${input.upstreamVersion}: ${removed.length} ${plural(removed.length, "настройка", "настройки", "настроек")}; исторические переводы сохранены.`);
  bullets.push(`Покрытие: ${coverageText}. [Полный список](${reportUrl}).`);

  const changelogSection = `## ${input.releaseVersion}\n\nOMP ${input.previousHostVersion} → ${input.upstreamVersion}.\n\n${bullets.map(bullet => `- ${bullet}`).join("\n")}`;

  const table = (header: readonly string[], rows: readonly (readonly string[])[]): readonly string[] => [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.join(" | ")} |`),
  ];
  const variantRows = (rows: readonly PathRow[]): readonly (readonly string[])[] => rows.flatMap(row => row.variants.map(variant => [
    variant.labels.map(escapeLabel).join(" / "),
    escapePath(row.path, true),
    `\`${variant.sourceHash}\``,
    variant.platforms.join(", "),
  ]));
  const lines: string[] = [
    `# OMP ${input.previousHostVersion} → ${input.upstreamVersion}`,
    "",
    `Релиз ${input.releaseVersion}. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.`,
    "",
  ];
  if (createdRows.length > 0) {
    lines.push(sectionHeading("Новые настройки на русском", createdRows), "", ...table(["настройка", "путь", "sourceHash", "платформы"], variantRows(createdRows)), "");
  }
  if (updatedRows.length > 0) {
    lines.push(sectionHeading("Обновлены переводы изменившихся настроек", updatedRows), "", ...table(["настройка", "путь", "новый sourceHash", "платформы"], variantRows(updatedRows)), "");
  }
  if (extendedRows.length > 0) {
    lines.push(sectionHeading("Расширена доступность существующих переводов", extendedRows), "", ...table(["настройка", "путь", "sourceHash", "добавленные платформы"], variantRows(extendedRows)), "");
  }
  if (removed.length > 0) {
    const rows = removed.map(path => {
      const platforms = previousPaths.get(path)!;
      const label = platforms.map(platform => previous.get(platform)!.settings[path]?.label).find(value => typeof value === "string" && value !== "") ?? "";
      return [label === "" ? "—" : escapeLabel(label), escapePath(path, true), platforms.join(", ")];
    });
    lines.push(`## Больше не доступны в OMP ${input.upstreamVersion} (${removed.length})`, "", ...table(["настройка в OMP", "путь", "платформы старого хоста"], rows), "");
  }
  if (createdRows.length === 0 && updatedRows.length === 0 && extendedRows.length === 0) {
    lines.push("## Новых переводов не потребовалось", "", "Существующий русский каталог подходит к исходным текстам этой версии.", "");
  }
  const coverageRows = [...input.versions].sort(compareVersions).flatMap(version => DISPLAY_PLATFORMS.map(platform => {
    const pair = grid.get(version)!.get(platform)!;
    return [version, platform, `${pair.complete}/${pair.total}`];
  }));
  lines.push("## Покрытие каталога", "", ...table(["OMP", "платформа", "настройки"], coverageRows), "");
  return { changelogSection, report: `${lines.join("\n").trimEnd()}\n` };
}

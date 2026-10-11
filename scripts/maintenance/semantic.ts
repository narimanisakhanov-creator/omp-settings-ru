import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { ACCEPTANCE_SCENARIO_FILES } from "./acceptance-scenarios";
import { approvedDelta, dispose, hostAliasOf, lockVerdict, prepareToolRoot } from "./measurement-environment";
import type { ControllerPolicy } from "./contracts";
/**
 * Содержательный гейт перевода.
 *
 * Реальная модель каталога: `src/translations/ru-part-{1,2,3}.ts` — это
 * `Record<путь настройки, {sourceHash, label?, description?, descriptionSource?, warning?, options?}>`.
 * `sourceHash` — sha256 нормализованных метаданных хоста (с шаблонами), поэтому его нельзя пересчитать из
 * самого файла перевода: он сверяется с фактическим `sourceHash` из каталога и с независимым ревью.
 *
 * Файлы читаются статически (TypeScript AST), код кандидата не исполняется. Покрытие и дрейф считают
 * реальные скрипты репозитория; контроллер здесь проверяет идентичности каталога, сохранность исторических
 * вариантов и подстановочные маркеры.
 */

export interface OptionTranslation {
  readonly label?: string;
  readonly description?: string;
}

export interface CatalogEntry {
  readonly path: string;
  readonly sourceHash: string;
  readonly translationHash: string;
  readonly label?: string;
  readonly description?: string;
  readonly descriptionSource?: string;
  readonly warning?: string;
  readonly options?: Readonly<Record<string, OptionTranslation>>;
}

export interface ReviewRow {
  readonly path: string;
  readonly sourceHash: string;
  /** Хеш перевода варианта — строка ревью обязана относиться к точному переводу этого варианта. */
  readonly translationHash: string;
  readonly reviewedAtVersion: string;
  readonly platforms: readonly string[];
}

export interface CoveragePair {
  readonly version: string;
  readonly platform: string;
  readonly complete: number;
  readonly total: number;
}

export interface DriftPair {
  readonly version: string;
  readonly platform: string;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

export interface SemanticEvidence {
  readonly candidateVersion: string;
  readonly supportedVersions: readonly string[];
  readonly coverage: readonly CoveragePair[];
  readonly drift: readonly DriftPair[];
  readonly reviewRows: readonly ReviewRow[];
  readonly changedPaths: readonly string[];
  /** Идентичности каталога в проверяемом коммите: `path:sourceHash:translationHash`. */
  readonly identities: readonly string[];
  /** Идентичности каталога в базе: ничего из этого набора не может исчезнуть. */
  readonly identitiesBefore: readonly string[];
  /** Записи с шаблоном исходника и переводом — источник проверки маркеров. */
  readonly markerPairs: readonly { path: string; source: string; ru: string }[];
  /**
   * Варианты изменённых файлов каталога с полной строкой требования: путь настройки, `sourceHash`,
   * `translationHash` и точный набор платформ, где этот вариант действительно отдаётся базовыми снимками.
   * Ключ — пара «путь настройки + sourceHash»: у одного пути бывает несколько исторических вариантов.
   */
  readonly changedCatalogVariants: readonly {
    readonly path: string;
    readonly sourceHash: string;
    readonly translationHash: string;
    readonly platforms: readonly string[];
  }[];
  /**
   * Требуется ли покрытие строками ревью. На стадии подготовки независимого ревью ещё не было, поэтому
   * строки не запрашиваются; на стадии ревью манифест обязателен и сверяется точно.
   */
  readonly reviewRequired: boolean;
}

export type SemanticVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const MARKER = /\{[A-Za-z0-9_]+\}|\{\{[^{}]+\}\}|%\d*\$?[sdif]|<[a-z][A-Za-z0-9_-]*>/g;

/** Маркеры подстановки, которые обязаны выжить в переводе. */
export function markers(text: string): readonly string[] {
  return [...new Set(text.match(MARKER) ?? [])].sort();
}

export function missingMarkers(source: string, translation: string): readonly string[] {
  const present = new Set(markers(translation));
  return markers(source).filter(marker => !present.has(marker));
}

/** Хеш перевода по полям варианта — та же формула, что в `verify-variant-reviews.ts`. */
export function translationHash(entry: Omit<CatalogEntry, "path" | "translationHash">): string {
  const { sourceHash: _sourceHash, ...fields } = entry;
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        throw new Error("nonliteral-catalog");
      }
      result[property.name.text] = literal(property.initializer);
    }
    return result;
  }
  throw new Error("nonliteral-catalog");
}

/**
 * Поля одного варианта каталога. Форма проверяется строго: запись без `sourceHash` в форме sha256 — это
 * признак того, что мы не поняли структуру файла, а не запись, которую можно молча выбросить.
 */
function fieldsOf(value: unknown, path: string): Omit<CatalogEntry, "path" | "translationHash"> {
  if (typeof value !== "object" || value === null) throw new Error(`malformed-catalog-entry:${path}`);
  const record = value as Record<string, unknown>;
  if (typeof record.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(record.sourceHash)) {
    throw new Error(`invalid-source-hash:${path}`);
  }
  const options = record.options;
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new Error(`malformed-catalog-entry:${path}`);
  }
  return {
    sourceHash: record.sourceHash,
    label: typeof record.label === "string" ? record.label : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    descriptionSource: typeof record.descriptionSource === "string" ? record.descriptionSource : undefined,
    warning: typeof record.warning === "string" ? record.warning : undefined,
    options: options === undefined ? undefined : options as Record<string, OptionTranslation>,
  };
}

/**
 * Разбор одного файла каталога.
 *
 * Файл — это данные, а не программа: он обязан состоять только из type-импортов и одного экспортируемого
 * литерального объектного объявления. Любое другое утверждение (значимый импорт, вызов, объявление функции,
 * присваивание) означает, что при импорте файла выполнится неизвестный код, поэтому это отказ, а не пропуск.
 * Динамическое выражение вместо карты (вызов, ссылка) — та же неизвестная структура: отказ.
 */
export function catalogFromSource(text: string): readonly CatalogEntry[] {
  const source = ts.createSourceFile("catalog.ts", text, ts.ScriptTarget.Latest, true);
  const entries: CatalogEntry[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      // Разрешён только type-импорт: значимый импорт выполнял бы код зависимости при импорте файла.
      if (!statement.importClause?.isTypeOnly) throw new Error("catalog-module-side-effect:import");
      continue;
    }
    if (!ts.isVariableStatement(statement)) throw new Error(`catalog-module-side-effect:${ts.SyntaxKind[statement.kind]}`);
    const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) throw new Error("catalog-module-side-effect:variable");
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) throw new Error("catalog-module-side-effect:mutable");
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) throw new Error("catalog-module-side-effect:binding");
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
        throw new Error("nonliteral-catalog");
      }
      for (const property of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          throw new Error("nonliteral-catalog");
        }
        const path = property.name.text;
        const fields = fieldsOf(literal(property.initializer), path);
        entries.push({ path, ...fields, translationHash: translationHash(fields) });
      }
    }
  }
  return entries;
}

/** Файлы каталога обязаны присутствовать все: отсутствие файла — не «нет записей», а неполный каталог. */
const CATALOG_FILES = ["ru-part-1.ts", "ru-part-2.ts", "ru-part-3.ts", "ru-variants.ts"] as const;
const CATALOG_DIR = "src/translations/";

/**
 * Вариант идентифицируется парой `(path, sourceHash)`: один путь в разных версиях хоста имеет разные
 * `sourceHash`, и такие варианты обязаны сосуществовать. Совпадающий вариант (тот же `translationHash`)
 * схлопывается, конфликтующий перевод того же варианта — отказ.
 */
function addEntry(entries: Map<string, CatalogEntry>, entry: CatalogEntry): void {
  const key = `${entry.path}\u0000${entry.sourceHash}`;
  const existing = entries.get(key);
  if (existing) {
    if (existing.translationHash !== entry.translationHash) {
      throw new Error(`conflicting-translation:${entry.path}:${entry.sourceHash}`);
    }
    return;
  }
  entries.set(key, entry);
}

function sortedEntries(entries: Map<string, CatalogEntry>): readonly CatalogEntry[] {
  return [...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.sourceHash.localeCompare(right.sourceHash));
}

/**
 * Области, изменение которых отменяет силу измерения: покрытие и дрейф считают скрипты репозитория, и
 * кандидат, переписавший измерительный код (или его вспомогательные модули), мог бы доказать что угодно.
 * Единственное исключение — данные каталога перевода: они и есть предмет сопровождения.
 */
const MEASUREMENT_ROOTS = ["scripts/", "src/"] as const;
/**
 * Конфигурация разрешения модулей: `tsconfig.json` меняет, какой код реально подхватывается (path aliases),
 * поэтому он часть измерительного кода и обязан совпадать с базой. `package.json` и `bun.lock` здесь
 * намеренно НЕ перечислены: разрешённая дельта манифеста накладывается на принятую базу, а граф lockfile
 * сверяется с независимо сгенерированным доверенным Bun графом.
 */
const MEASUREMENT_CONFIG = ["tsconfig.json"] as const;
const MEASUREMENT_EXEMPT = CATALOG_FILES.map(name => `${CATALOG_DIR}${name}`);
/**
 * Файлы сценариев приёмки: список приходит из единственного источника истины, а не дублируется здесь.
 * Доказательство продюсера состоит именно из факта их прогона, поэтому кандидат, переписавший собственный
 * сценарий, не может быть проверен тем же прогоном. Сравнение идёт с базовым блобом — как у прочего
 * измерительного кода, — поэтому правка сценария отменяет силу измерения до первого подпроцесса.
 */
const MEASUREMENT_SCENARIOS: readonly string[] = ACCEPTANCE_SCENARIO_FILES;

function isMeasurementPath(path: string): boolean {
  if ((MEASUREMENT_CONFIG as readonly string[]).includes(path)) return true;
  if (MEASUREMENT_SCENARIOS.includes(path)) return true;
  return MEASUREMENT_ROOTS.some(root => path.startsWith(root)) && !MEASUREMENT_EXEMPT.includes(path);
}

function gitBytes(worktree: string, args: readonly string[]): { stdout: Uint8Array; code: number; stderr: string } {
  const child = Bun.spawnSync(["git", ...args], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  return { stdout: child.stdout, code: child.exitCode, stderr: child.stderr.toString() };
}

/**
 * Изменившиеся файлы измерительного кода: базовый коммит против фактического рабочего дерева.
 *
 * Сравнивается весь код под `scripts/` и `src/` (кроме четырёх файлов каталога), а не только две точки
 * входа: иначе изменение вспомогательного модуля прошло бы мимо проверки. Пустое множество — измерительный
 * код не тронут, и его результату можно верить.
 */
export async function measurementChanges(worktree: string, baseSha: string): Promise<readonly string[]> {
  const pathspec = [...MEASUREMENT_ROOTS, ...MEASUREMENT_CONFIG, ...MEASUREMENT_SCENARIOS];
  const listed = gitBytes(worktree, ["ls-tree", "-r", "-z", "--name-only", baseSha, "--", ...pathspec]);
  if (listed.code !== 0) throw new Error("measurement-baseline-unavailable");
  const basePaths = new Set(
    new TextDecoder().decode(listed.stdout).split("\0").filter(path => path && isMeasurementPath(path)),
  );
  const working = gitBytes(worktree, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspec]);
  if (working.code !== 0) throw new Error("measurement-worktree-unavailable");
  const workingPaths = new Set(
    new TextDecoder().decode(working.stdout).split("\0").filter(path => path && isMeasurementPath(path)),
  );
  const changed: string[] = [];
  for (const path of [...new Set([...basePaths, ...workingPaths])].sort()) {
    if (!workingPaths.has(path) || !basePaths.has(path)) {
      changed.push(path);
      continue;
    }
    const blob = gitBytes(worktree, ["show", `${baseSha}:${path}`]);
    if (blob.code !== 0) throw new Error(`measurement-blob-unavailable:${path}`);
    const file = Bun.file(`${worktree}/${path}`);
    if (!await file.exists()) {
      changed.push(path);
      continue;
    }
    const current = new Uint8Array(await file.arrayBuffer());
    if (current.length !== blob.stdout.length || current.some((byte, index) => byte !== blob.stdout[index])) {
      changed.push(path);
    }
  }
  return changed;
}

/** Допустимые изменения манифеста: версия плагина и пин хоста OMP для новой версии кандидата. */
const HOST_ALIAS = /^omp-host-\d+$/;
const OMP_PACKAGE = /^@oh-my-pi\/pi-(coding-agent|natives|tui|utils)$/;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function dependencyViolations(before: unknown, after: unknown, candidateVersion: string): string[] {
  const left = (typeof before === "object" && before !== null ? before : {}) as Record<string, unknown>;
  const right = (typeof after === "object" && after !== null ? after : {}) as Record<string, unknown>;
  const violations: string[] = [];
  for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const oldValue = left[name];
    const newValue = right[name];
    if (sortedJson(oldValue) === sortedJson(newValue)) continue;
    // Разрешено ровно одно: пин хоста OMP. Актуальный пакет-алиас указывает на версию кандидата, а
    // peer/range-запись того же семейства обязана упоминать эту версию.
    if (!HOST_ALIAS.test(name) && !OMP_PACKAGE.test(name)) {
      violations.push(`package-dependency-changed:${name}`);
      continue;
    }
    if (typeof newValue !== "string" || !newValue.includes(candidateVersion)) {
      violations.push(`package-dependency-unverified:${name}`);
    }
  }
  return violations;
}

/**
 * Манифест против базы: ранний отказ на посторонние поля и зависимости.
 * Полная допустимость дельты и сгенерированный граф lockfile проверяются доверенной средой ниже;
 * сравнение байтов lockfile здесь намеренно не применяется.
 */
export async function packageChanges(worktree: string, baseSha: string, candidateVersion: string): Promise<readonly string[]> {
  const violations: string[] = [];
  const blob = gitBytes(worktree, ["show", `${baseSha}:package.json`]);
  if (blob.code !== 0) throw new Error("package-baseline-unavailable");
  const file = Bun.file(`${worktree}/package.json`);
  if (!await file.exists()) throw new Error("package-json-missing");
  const before = JSON.parse(new TextDecoder().decode(blob.stdout)) as Record<string, unknown>;
  const after = JSON.parse(await file.text()) as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (key === "version" || (DEPENDENCY_FIELDS as readonly string[]).includes(key)) continue;
    if (sortedJson(before[key]) !== sortedJson(after[key])) violations.push(`package-field-changed:${key}`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    violations.push(...dependencyViolations(before[field], after[field], candidateVersion));
  }
  const lockFile = Bun.file(`${worktree}/bun.lock`);
  if (!await lockFile.exists()) violations.push("bun-lock-missing");
  return violations;
}

/**
 * Версии, объявленные манифестом поддержанных хостов рабочего дерева.
 *
 * Манифест — недоверенная граница кандидата: объявленная версия расширяет сетку обязательных измерений,
 * поэтому разбор строгий (схема, semver, уникальность пар «версия × платформа») и отказ приходит до первого
 * подпроцесса. Дубль версии или платформы означал бы, что часть заявленного набора не проверяется, а пропуск
 * записи — что заявленная поддержка ничем не подтверждена.
 */
export async function claimedVersions(worktree: string): Promise<readonly string[]> {
  const file = Bun.file(`${worktree}/baseline/supported-hosts.json`);
  if (!await file.exists()) throw new Error("supported-hosts-unreadable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error("supported-hosts-unreadable");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("supported-hosts-invalid");
  const record = parsed as { schemaVersion?: unknown; versions?: unknown };
  if (record.schemaVersion !== 1 || !Array.isArray(record.versions) || record.versions.length === 0) {
    throw new Error("supported-hosts-invalid");
  }
  const seenVersions = new Set<string>();
  const seenPairs = new Set<string>();
  const versions: string[] = [];
  for (const raw of record.versions) {
    if (typeof raw !== "object" || raw === null) throw new Error("supported-hosts-invalid");
    const entry = raw as { version?: unknown; platforms?: unknown; package?: unknown };
    if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.version)) throw new Error("supported-version-invalid");
    if (seenVersions.has(entry.version)) throw new Error(`supported-version-duplicate:${entry.version}`);
    seenVersions.add(entry.version);
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
      throw new Error(`supported-platforms-invalid:${entry.version}`);
    }
    for (const platform of entry.platforms) {
      // Имя платформы — часть пары «версия × платформа», поэтому оно тоже проверяется на форму, а не
      // приводится к строке: значение из манифеста не должно попасть в сетку измерений произвольным текстом.
      if (typeof platform !== "string" || !/^[a-z0-9]+$/.test(platform)) throw new Error(`supported-platform-invalid:${entry.version}`);
      const pair = `${entry.version}\u0000${platform}`;
      if (seenPairs.has(pair)) throw new Error(`supported-platform-duplicate:${entry.version}:${platform}`);
      seenPairs.add(pair);
    }
    if (entry.package !== hostAliasOf(entry.version)) throw new Error(`supported-package-invalid:${entry.version}`);
    versions.push(entry.version);
  }
  return versions;
}

/** Каталог рабочего дерева: все файлы `src/translations/ru-part-*.ts`, затем исторические варианты. */
export async function readCatalog(worktree: string): Promise<readonly CatalogEntry[]> {
  const entries = new Map<string, CatalogEntry>();
  for (const name of CATALOG_FILES) {
    const file = Bun.file(`${worktree}/src/translations/${name}`);
    if (!await file.exists()) throw new Error(`catalog-file-missing:${name}`);
    for (const entry of catalogFromSource(await file.text())) addEntry(entries, entry);
  }
  return sortedEntries(entries);
}

/** Каталог из конкретного коммита — база для проверки сохранности исторических вариантов. */
export function readCatalogAtCommit(worktree: string, sha: string): readonly CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  for (const name of CATALOG_FILES) {
    const blob = Bun.spawnSync(["git", "show", `${sha}:src/translations/${name}`], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
    if (blob.exitCode !== 0) throw new Error(`catalog-blob-missing:${sha}:${name}`);
    for (const entry of catalogFromSource(blob.stdout.toString())) addEntry(entries, entry);
  }
  return sortedEntries(entries);
}

export function identitiesOf(entries: readonly CatalogEntry[]): readonly string[] {
  return entries.map(entry => `${entry.path}:${entry.sourceHash}:${entry.translationHash}`).sort();
}

/** Пары «шаблон исходника → перевод» для проверки маркеров. */
export function markerPairsOf(entries: readonly CatalogEntry[]): readonly { path: string; source: string; ru: string }[] {
  const pairs: { path: string; source: string; ru: string }[] = [];
  for (const entry of entries) {
    if (entry.descriptionSource && entry.description) {
      pairs.push({ path: entry.path, source: entry.descriptionSource, ru: entry.description });
    }
  }
  return pairs;
}

export function validateSemantic(evidence: SemanticEvidence, policy: ControllerPolicy): SemanticVerdict {
  // Пустой фактический каталог или пустая база — это не «нечего проверять»: каталог проекта всегда непуст,
  // поэтому пустое множество идентичностей означает непрочитанный/неполный каталог и обязано отказать.
  if (evidence.identities.length === 0) return { ok: false, reason: "catalog-empty" };
  if (evidence.identitiesBefore.length === 0) return { ok: false, reason: "baseline-catalog-empty" };
  const expected = [...new Set([...evidence.supportedVersions, evidence.candidateVersion])].sort();
  const seen = new Set(evidence.coverage.map(pair => pair.version));
  for (const version of expected) {
    if (!seen.has(version)) return { ok: false, reason: `coverage-missing:${version}` };
  }
  // Сетка «версия × платформа» обязана быть полной и без дублей: покрытие по одному платформы не доказывает
  // остальные, а повтор одного ключа маскирует пропущенный.
  const coverageKeys = new Set<string>();
  for (const pair of evidence.coverage) {
    if (!expected.includes(pair.version)) return { ok: false, reason: `coverage-unexpected-version:${pair.version}` };
    const key = `${pair.version}:${pair.platform}`;
    if (coverageKeys.has(key)) return { ok: false, reason: `coverage-duplicate:${pair.version}-${pair.platform}` };
    coverageKeys.add(key);
  }
  for (const version of expected) {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      if (!coverageKeys.has(`${version}:${platform}`)) return { ok: false, reason: `coverage-missing:${version}-${platform}` };
    }
  }
  for (const pair of evidence.coverage) {
    if (pair.total <= 0 || pair.complete !== pair.total) {
      return { ok: false, reason: `coverage-incomplete:${pair.version}-${pair.platform}` };
    }
  }
  const driftKeys = new Set<string>();
  for (const pair of evidence.drift) {
    const key = `${pair.version}:${pair.platform}`;
    if (driftKeys.has(key)) return { ok: false, reason: `drift-duplicate:${pair.version}-${pair.platform}` };
    driftKeys.add(key);
    if (pair.added || pair.removed || pair.changed) {
      return { ok: false, reason: `drift-nonzero:${pair.version}-${pair.platform}` };
    }
  }
  if (evidence.drift.length !== evidence.coverage.length) return { ok: false, reason: "drift-incomplete" };
  for (const version of expected) {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      if (!driftKeys.has(`${version}:${platform}`)) return { ok: false, reason: `drift-missing:${version}-${platform}` };
    }
  }

  for (const path of evidence.changedPaths) {
    const allowed = policy.executorPaths.some(pattern => {
      const expanded = pattern.replaceAll("<candidate>", evidence.candidateVersion);
      return expanded.endsWith("/") ? path.startsWith(expanded) : path === expanded;
    });
    if (!allowed) return { ok: false, reason: `path-outside-policy:${path}` };
    // Изменение в каталоге перевода вне четырёх известных файлов — неизвестная структура: не проверяется
    // построчно и потому не допускается. Такой файл требует отдельного полного ревью каталога.
    const name = path.startsWith(CATALOG_DIR) ? path.slice(CATALOG_DIR.length) : undefined;
    if (name !== undefined && !(CATALOG_FILES as readonly string[]).includes(name)) {
      return { ok: false, reason: `unknown-catalog-file:${path}` };
    }
  }

  // Сохранность истории — по множеству идентичностей, а не по количеству: замена одного варианта другим с
  // тем же числом записей недопустима.
  const current = new Set(evidence.identities);
  for (const identity of evidence.identitiesBefore) {
    if (!current.has(identity)) return { ok: false, reason: `historical-identity-removed:${identity}` };
  }

  // Строки ревью называются путями настроек и покрывают варианты изменённых файлов каталога точно — без
  // пропусков и без лишних записей. Ключ — пара «путь настройки + sourceHash»: у одного пути бывает
  // несколько исторических вариантов, и путь файла такую пару не заменяет.
  const byPath = new Map<string, Set<string>>();
  for (const identity of evidence.identities) {
    const index = identity.indexOf(":");
    const path = identity.slice(0, index);
    const sourceHash = identity.slice(index + 1, identity.indexOf(":", index + 1));
    const set = byPath.get(path) ?? new Set<string>();
    set.add(sourceHash);
    byPath.set(path, set);
  }
  const key = (path: string, sourceHash: string): string => `${path}:${sourceHash}`;
  if (!evidence.reviewRequired) {
    if (evidence.reviewRows.length > 0) return { ok: false, reason: "review-rows-unexpected" };
  } else {
    for (const variant of evidence.changedCatalogVariants) {
      const keyed = key(variant.path, variant.sourceHash);
      const rows = evidence.reviewRows.filter(row => row.path === variant.path && row.sourceHash === variant.sourceHash);
      if (rows.length === 0) return { ok: false, reason: `review-row-missing:${keyed}` };
      if (rows.length > 1) return { ok: false, reason: `review-row-duplicate:${keyed}` };
      const row = rows[0]!;
      if (row.translationHash !== variant.translationHash) {
        return { ok: false, reason: `review-translation-mismatch:${keyed}` };
      }
      const submitted = [...row.platforms].sort().join(",");
      const required = [...variant.platforms].sort().join(",");
      if (submitted !== required) return { ok: false, reason: `review-platform-mismatch:${keyed}` };
    }
    const expectedSet = new Set(evidence.changedCatalogVariants.map(variant => key(variant.path, variant.sourceHash)));
    const unexpected = evidence.reviewRows.find(row => !expectedSet.has(key(row.path, row.sourceHash)));
    if (unexpected) return { ok: false, reason: `review-row-unknown:${key(unexpected.path, unexpected.sourceHash)}` };
    for (const row of evidence.reviewRows) {
      if (row.reviewedAtVersion !== evidence.candidateVersion) return { ok: false, reason: `review-stale-version:${row.path}` };
      const actual = byPath.get(row.path);
      if (!actual || !actual.has(row.sourceHash)) return { ok: false, reason: `review-hash-mismatch:${row.path}` };
    }
  }

  for (const pair of evidence.markerPairs) {
    const missing = missingMarkers(pair.source, pair.ru);
    if (missing.length) return { ok: false, reason: `placeholder-lost:${pair.path}:${missing.join(",")}` };
  }
  return { ok: true };
}

/** Покрытие и дрейф — из реальных скриптов репозитория; отказ скрипта тоже отказ сбора. */
export async function collectCoverageAndDrift(
  worktree: string, versions: readonly string[],
): Promise<{ coverage: readonly CoveragePair[]; drift: readonly DriftPair[] } | { readonly failure: string }> {
  const coverage: CoveragePair[] = [];
  const drift: DriftPair[] = [];
  for (const version of versions) {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const coverageRun = Bun.spawnSync(["bun", "scripts/check-coverage.ts", version, platform], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
      if (coverageRun.exitCode !== 0) return { failure: `coverage-run-failed:${version}-${platform}` };
      const coverageReport = JSON.parse(coverageRun.stdout.toString()) as { pairs: { report: { completeSettings: number; totalUiSettings: number } }[] };
      for (const pair of coverageReport.pairs) {
        coverage.push({ version, platform, complete: pair.report.completeSettings, total: pair.report.totalUiSettings });
      }
      const driftRun = Bun.spawnSync(["bun", "scripts/diff-upstream.ts", version, platform], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
      if (driftRun.exitCode !== 0) return { failure: `drift-run-failed:${version}-${platform}` };
      const driftReport = JSON.parse(driftRun.stdout.toString()) as { pairs: { addedPaths: string[]; removedPaths: string[]; changedPaths: string[] }[] };
      for (const pair of driftReport.pairs) {
        drift.push({ version, platform, added: pair.addedPaths.length, removed: pair.removedPaths.length, changed: pair.changedPaths.length });
      }
    }
  }
  return { coverage, drift };
}

/** Настройка доверенного реестра вызывающим кодом, не данными кандидата или переменными окружения. */
export interface MeasurementEnvironmentOptions {
  readonly registry?: string;
  readonly deadlineMs?: number;
}
/** Сбор доказательства: реальные скрипты + фактический каталог + строки ревью + база для сохранности. */
export async function collectSemanticEvidence(
  worktree: string,
  baseSha: string,
  candidateVersion: string,
  supportedVersions: readonly string[],
  changedPaths: readonly string[],
  /** Манифест ревью: `undefined` — независимого ревью ещё не было (стадия подготовки). */
  review?: readonly ReviewRow[],
  environment: MeasurementEnvironmentOptions = {},
): Promise<SemanticEvidence | { readonly failure: string }> {
  const deadlineMs = environment.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) return { failure: "measurement-deadline-invalid" };
  // Набор измеряемых версий — объединение принятой поддержки и поддержки, объявленной кандидатом: заявленную
  // версию нельзя пропустить в сетке «версия × платформа», и она всё равно обязана быть измерена целиком.
  // Гейт измерительного кода стоит ДО запуска скриптов: иначе кандидат мог бы переписать измерение и
  // предъявить его результат как доказательство.
  let measurementTouched: readonly string[];
  try {
    measurementTouched = await measurementChanges(worktree, baseSha);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
  if (measurementTouched.length > 0) return { failure: `measurement-code-changed:${measurementTouched[0]}` };
  // Манифест и lockfile проверяются там же: изменение зависимости расширяет исполняемый код не меньше,
  // чем правка скрипта измерения.
  let packageTouched: readonly string[];
  try {
    packageTouched = await packageChanges(worktree, baseSha, candidateVersion);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
  if (packageTouched.length > 0) return { failure: packageTouched[0]! };
  // Заявленная кандидатом поддержка читается строго и ДО первого подпроцесса: объявленная версия расширяет
  // сетку измерений, поэтому непроверяемая запись манифеста — отказ, а не молчаливо пропущенная версия.
  let claimed: readonly string[];
  try {
    claimed = await claimedVersions(worktree);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
  const versions = [...new Set([...supportedVersions, ...claimed, candidateVersion])];
  const manifest = await Bun.file(`${worktree}/baseline/supported-hosts.json`).json() as { versions: { version: string; platforms: string[] }[] };
  for (const version of versions) {
    const record = manifest.versions.find(record => record.version === version);
    if (!record) return { failure: `supported-version-missing:${version}` };
    for (const platform of ["win32", "linux", "darwin"]) {
      if (!record.platforms.includes(platform)) return { failure: `supported-platform-missing:${version}:${platform}` };
    }
  }
  // Каталог разбирается статически ДО первого подпроцесса измерения: файл каталога — данные, а не программа,
  // и постороннее утверждение уровня модуля означало бы исполнение неизвестного кода при импорте. Отказ здесь
  // дешевле и точнее отказа измерения и не зависит от того, какие пары хостов вообще поддержаны.
  let entries: readonly CatalogEntry[];
  let before: readonly CatalogEntry[];
  try {
    entries = await readCatalog(worktree);
    before = readCatalogAtCommit(worktree, baseSha);
  } catch (error) {
    // Каталог с отсутствующим файлом, блобом или нераспознанной записью — отказ сбора, а не пустой каталог.
    return { failure: error instanceof Error ? error.message : String(error) };
  }
  if (entries.length === 0) return { failure: "catalog-unreadable" };
  if (before.length === 0) return { failure: "baseline-catalog-unreadable" };
  // Сохранность истории проверяется тем же сравнением множеств идентичностей `путь:sourceHash:translationHash`,
  // что и в `validateSemantic`: изменённая запись исторического варианта (правка `label`, `description`,
  // `descriptionSource`, `warning`, `options` при том же `sourceHash`) даёт другую идентичность и обязана
  // отказать здесь — до измерения. Новые записи при этом не запрещены: база обязана остаться подмножеством,
  // поэтому настоящее расширение каталога под новый upstream проходит и не «замораживается».
  {
    const current = new Set(identitiesOf(entries));
    const removed = identitiesOf(before).find(identity => !current.has(identity));
    if (removed !== undefined) return { failure: `historical-identity-removed:${removed}` };
  }
  const acceptedManifest = gitBytes(worktree, ["show", `${baseSha}:package.json`]);
  if (acceptedManifest.code !== 0) return { failure: "package-baseline-unavailable" };
  const approved = approvedDelta(
    JSON.parse(new TextDecoder().decode(acceptedManifest.stdout)),
    JSON.parse(await Bun.file(`${worktree}/package.json`).text()), candidateVersion,
  );
  if ("failure" in approved) return approved;
  const prepared = await prepareToolRoot({
    checkout: worktree, baseSha, root: join(tmpdir(), `omp-measurement-${randomUUID()}`),
    delta: approved.delta, deadlineMs, registry: environment.registry,
  });
  if ("failure" in prepared) return prepared;
  try {
    for (const version of versions) {
      if (!prepared.hosts.some(host => host.alias === hostAliasOf(version) && host.version === version)) {
        return { failure: `host-identity-missing:${hostAliasOf(version)}` };
      }
    }
    const lock = lockVerdict(prepared.lock, await Bun.file(`${worktree}/bun.lock`).text(), Bun.version);
    if ("failure" in lock) return lock;
    const measured = await collectCoverageAndDrift(prepared.root, versions);
    if ("failure" in measured) return measured;
    const requirements = await changedCatalogRequirements(prepared.root, changedPaths, versions);
    if ("failure" in requirements) return requirements;
    return {
      candidateVersion, supportedVersions: versions,
      coverage: measured.coverage, drift: measured.drift,
      reviewRows: review ?? [], reviewRequired: review !== undefined, changedPaths,
      changedCatalogVariants: requirements.variants,
      identities: identitiesOf(entries), identitiesBefore: identitiesOf(before), markerPairs: markerPairsOf(entries),
    };
  } finally {
    await dispose(prepared.root);
  }
}

/**
 * Требования строк ревью для изменённых файлов каталога.
 *
 * Набор платформ берётся из **принятых** базовых снимков (`baseline/<version>-<platform>.json` — входящие
 * артефакты, а не отчёт исполнителя): вариант отдаётся ровно тем платформам, чей снимок несёт этот
 * `sourceHash` для этого пути настройки. Манифест ревью, назвавший другой набор, не является доказательством.
 */
export async function changedCatalogRequirements(
  worktree: string, changedPaths: readonly string[], versions: readonly string[],
): Promise<{ readonly variants: readonly {
  readonly path: string; readonly sourceHash: string; readonly translationHash: string; readonly platforms: readonly string[];
}[] } | { readonly failure: string }> {
  const platformOf = new Map<string, string[]>();
  for (const version of versions) {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const file = Bun.file(`${worktree}/baseline/${version}-${platform}.json`);
      if (!await file.exists()) return { failure: `baseline-missing:${version}-${platform}` };
      const snapshot = JSON.parse(await file.text()) as { settings?: Record<string, { sourceHash?: string }> };
      for (const [path, setting] of Object.entries(snapshot.settings ?? {})) {
        if (typeof setting?.sourceHash !== "string") continue;
        const key = `${path}\u0000${setting.sourceHash}`;
        const platforms = platformOf.get(key) ?? [];
        if (!platforms.includes(platform)) platforms.push(platform);
        platformOf.set(key, platforms);
      }
    }
  }
  // Варианты изменённых файлов каталога считаются из фактического содержимого, а не из имён файлов:
  // строки ревью адресуют пару «путь настройки + sourceHash», и только она отличает исторический вариант.
  const variants: { path: string; sourceHash: string; translationHash: string; platforms: readonly string[] }[] = [];
  for (const path of changedPaths) {
    const name = path.startsWith(CATALOG_DIR) ? path.slice(CATALOG_DIR.length) : undefined;
    if (name === undefined || !(CATALOG_FILES as readonly string[]).includes(name)) continue;
    const file = Bun.file(`${worktree}/${path}`);
    if (!await file.exists()) return { failure: `catalog-file-missing:${name}` };
    for (const entry of catalogFromSource(await file.text())) {
      const platforms = platformOf.get(`${entry.path}\u0000${entry.sourceHash}`);
      // Вариант, который не отдаёт ни один поддерживаемый хост, нечем подтвердить платформенно: это отказ,
      // а не строка с пустым набором платформ, которую можно «удовлетворить».
      if (!platforms || platforms.length === 0) {
        return { failure: `catalog-variant-without-baseline:${entry.path}:${entry.sourceHash}` };
      }
      variants.push({
        path: entry.path, sourceHash: entry.sourceHash, translationHash: entry.translationHash,
        platforms: [...platforms].sort(),
      });
    }
  }
  return { variants };
}

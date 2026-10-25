import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PATH, parseCatalogJSON, readCatalogJSON, translationFieldsHash } from "./catalog";
import type { LocalePack, SourcePlatform } from "../../src/translations/types";
import type { BaselineSnapshot } from "../../src/report";
import { approvedDelta, dispose, hostAliasOf, lockVerdict, prepareToolRoot } from "./measurement-environment";
import { SUPPORTED_HOSTS, snapshotPath } from "./paths";
import type { ControllerPolicy } from "./contracts";

/** Candidate catalog bytes are strict JSON data; executable code always comes from the accepted base. */

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
  readonly platforms: readonly SourcePlatform[];
  readonly observedIn: readonly string[];
}

export interface ReviewRow {
  readonly path: string;
  readonly sourceHash: string;
  /** Хеш перевода варианта — строка ревью обязана относиться к точному переводу этого варианта. */
  readonly translationHash: string;
  readonly reviewedAtVersion: string;
  readonly platforms: readonly string[];
  readonly review: "independently-confirmed";
  readonly comparison: string;
  readonly reviewTask: string;
  readonly evidence: string;
}

/** Artifact content comes from the trusted caller, never from a candidate review row.
 * Digest-only artifacts are allowed only after that caller has measured the actual sanitized bytes.
 */
export type ReviewContentArtifact =
  | { readonly bytes: string; readonly sha256?: string }
  | { readonly bytes?: never; readonly sha256: string };

export interface ReviewProofContext {
  readonly runId: string;
  readonly runAttempt: string;
  /** Keys are exactly `${path}:${sourceHash}`. Values bind sanitized reviewer content, not report JSON. */
  readonly artifacts: ReadonlyMap<string, ReviewContentArtifact>;
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
  /** Source identities are exactly path/sourceHash/platform/observedIn, never translation hashes. */
  readonly identities: readonly string[];
  /** Идентичности каталога в базе: ничего из этого набора не может исчезнуть. */
  readonly identitiesBefore: readonly string[];
  readonly translationIdentities: readonly string[];
  readonly translationIdentitiesBefore: readonly string[];
  /** Записи с шаблоном исходника и переводом — источник проверки маркеров. */
  readonly markerPairs: readonly { path: string; sourceHash: string; translationHash: string; field: string; source: string; ru: string }[];
  /**
   * Новые identities и расширения платформ с полной строкой требования: путь настройки, `sourceHash`,
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
   * Nonempty semantic delta always requires independent proof. Preparation may collect evidence,
   * but cannot declare semantic approval until exact review rows are supplied.
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

/** Shared insertion-order-sensitive display hash; platform/version provenance is excluded. */
export const translationHash = translationFieldsHash;

// Exact historical review rows at immutable commit 370b2028798c5f5c1da797e0d321191ae1780d88,
// src/translations/variant-review.json. Only this already-shipped description mapping is approved.
const HISTORICAL_MARKER_TRANSLATIONS: Readonly<Record<string,string>> = {
  d6bcd3d11e4d2ce2eba1cc7b75e5bc9c4589d1fe5bb1a174cfcd37d977ba285e: "9dbad3a9e55dc9a065ffd495403e4063cfa21de916b3a0bd6b7fd14f222bd894",
  e0a244746eda55072d4fe4c3a75f3238565ccf3857190875d8aef6b58d323927: "575a3dfe997e1dc5e826c1fb041a45b4c390d73e81636c844d68a2305ea0f4da",
};

export function catalogEntries(pack: LocalePack): readonly CatalogEntry[] {
  return Object.entries(pack.settings).flatMap(([path, setting]) => setting.variants.map(variant => ({
    path, ...variant, translationHash: translationFieldsHash(variant),
  }))).sort((left, right) => left.path.localeCompare(right.path) || left.sourceHash.localeCompare(right.sourceHash));
}

const CATALOG_FILES = ["ru-catalog.json", "variant-review.json"] as const;
const CATALOG_DIR = "src/translations/";

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
const MEASUREMENT_SCENARIOS: readonly string[] = [
  "test/maintenance-actions.e2e.test.ts", "test/maintenance-translation.test.ts",
  "test/maintenance-github.e2e.test.ts", "test/maintenance-tree.test.ts",
  "test/maintenance-semantic.test.ts", "test/maintenance-measurement-environment.test.ts",
];

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
 * Сравнивается весь код под `scripts/` и `src/` (кроме JSON-данных каталога/ревью), а не только две точки
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
  const file = Bun.file(join(worktree, SUPPORTED_HOSTS));
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

/** Only the effective JSON catalog is a candidate input; old TS layouts are deliberately unsupported. */
export async function readCatalog(worktree: string): Promise<readonly CatalogEntry[]> {
  return catalogEntries(await readCatalogJSON(worktree));
}

export function readCatalogAtCommit(worktree: string, sha: string): readonly CatalogEntry[] {
  const blob = gitBytes(worktree, ["show", `${sha}:${CATALOG_PATH}`]);
  if (blob.code !== 0) throw new Error(`catalog-blob-missing:${sha}:ru-catalog.json`);
  return catalogEntries(parseCatalogJSON(new TextDecoder().decode(blob.stdout)));
}

/** Every source/platform observation is independently preserved; new observations are additive. */
export function identitiesOf(entries: readonly CatalogEntry[]): readonly string[] {
  return entries.flatMap(entry => entry.platforms.flatMap(platform => entry.observedIn.map(version =>
    `${entry.path}:${entry.sourceHash}:${platform}:${version}`,
  ))).sort();
}

/** Historical Russian bytes are protected separately from source provenance. */
export function translationIdentitiesOf(entries: readonly CatalogEntry[]): readonly string[] {
  return entries.flatMap(entry => entry.platforms.map(platform =>
    `${entry.path}:${entry.sourceHash}:${platform}:${entry.translationHash}`,
  )).sort();
}

/** Every display field is paired with source metadata of the exact source identity. */
export function markerPairsOf(entries: readonly CatalogEntry[], snapshots: readonly BaselineSnapshot[]): SemanticEvidence["markerPairs"] {
  const pairs: { path: string; sourceHash: string; translationHash: string; field: string; source: string; ru: string }[] = [];
  for (const entry of entries) {
    const source = snapshots.map(snapshot => snapshot.settings[entry.path]).find(source => source?.sourceHash === entry.sourceHash);
    if (!source) throw new Error(`catalog-source-missing:${entry.path}:${entry.sourceHash}`);
    const add = (field: string, english: unknown, russian: unknown) => {
      if (typeof english === "string" && typeof russian === "string") pairs.push({ path: entry.path, sourceHash: entry.sourceHash, translationHash: entry.translationHash, field, source: english, ru: russian });
      else if (typeof english === "string" || typeof russian === "string") throw new Error(`catalog-field-source-mismatch:${entry.path}:${field}`);
    };
    add("label", source.label, entry.label);
    if (entry.descriptionSource !== undefined && entry.descriptionSource !== source.description) throw new Error(`catalog-description-source-mismatch:${entry.path}`);
    add("description", source.description, entry.description);
    add("warning", source.warning, entry.warning);
    if (Array.isArray(source.options)) for (const option of source.options) {
      add(`options.${option.value}.label`, option.label, entry.options?.[option.value]?.label);
      add(`options.${option.value}.description`, option.description, entry.options?.[option.value]?.description);
    }
    const sourceOptionKeys = Array.isArray(source.options) ? source.options.map(option => option.value) : [];
    if (Object.keys(entry.options ?? {}).some(value => !sourceOptionKeys.includes(value))) throw new Error(`catalog-option-source-mismatch:${entry.path}`);
  }
  return pairs;
}

export function validateSemantic(
  evidence: SemanticEvidence, policy: ControllerPolicy, proof?: ReviewProofContext, semanticReviewDisabled = false,
): SemanticVerdict {
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
    // Only the two explicit JSON data files are mutable under translations; runtime modules are protected.
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
  const translations = new Set(evidence.translationIdentities);
  for (const identity of evidence.translationIdentitiesBefore) {
    if (!translations.has(identity)) return { ok: false, reason: `historical-translation-changed:${identity}` };
  }

  // Review rows cover the semantic delta exactly: path/sourceHash, display hash, and observed platforms.
  // A changed JSON file does not invalidate unchanged identities.
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
  if (semanticReviewDisabled) {
    if (evidence.reviewRows.length > 0) return { ok: false, reason: "review-rows-unexpected" };
  } else if (!evidence.reviewRequired && evidence.changedCatalogVariants.length === 0) {
    if (evidence.reviewRows.length > 0) return { ok: false, reason: "review-rows-unexpected" };
  } else {
    for (const variant of evidence.changedCatalogVariants) {
      const keyed = key(variant.path, variant.sourceHash);
      const rows = evidence.reviewRows.filter(row => row.path === variant.path && row.sourceHash === variant.sourceHash);
      if (rows.length === 0) return { ok: false, reason: `review-row-missing:${keyed}` };
      if (rows.length > 1) return { ok: false, reason: `review-row-duplicate:${keyed}` };
      const row = rows[0]!;
      if (row.review !== "independently-confirmed" || typeof row.comparison !== "string" || !row.comparison.trim() || typeof row.reviewTask !== "string" || !/^\d+:\d+$/.test(row.reviewTask) || typeof row.evidence !== "string" || !/^[a-f0-9]{64}$/.test(row.evidence)) {
        return { ok: false, reason: `review-proof-invalid:${keyed}` };
      }
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
    if (evidence.changedCatalogVariants.length > 0) {
      if (!proof) return { ok: false, reason: "review-context-missing" };
      if (!/^\d+$/.test(proof.runId) || !/^\d+$/.test(proof.runAttempt)) return { ok: false, reason: "review-context-invalid" };
      for (const row of evidence.reviewRows) {
        const keyed = key(row.path, row.sourceHash);
        if (row.reviewTask !== `${proof.runId}:${proof.runAttempt}`) return { ok: false, reason: `review-task-mismatch:${keyed}` };
        const artifact = proof.artifacts.get(keyed);
        if (!artifact) return { ok: false, reason: `review-artifact-missing:${keyed}` };
        const digest = artifact.bytes === undefined ? artifact.sha256 : createHash("sha256").update(artifact.bytes, "utf8").digest("hex");
        if (!/^[a-f0-9]{64}$/.test(digest) || (artifact.sha256 !== undefined && artifact.sha256 !== digest) || row.evidence !== digest) {
          return { ok: false, reason: `review-evidence-mismatch:${keyed}` };
        }
      }
    }
  }

  for (const pair of evidence.markerPairs) {
    const historical = pair.path === "statusLine.compactThinkingLevel" && pair.field === "description"
      && Object.hasOwn(HISTORICAL_MARKER_TRANSLATIONS,pair.sourceHash)
      && HISTORICAL_MARKER_TRANSLATIONS[pair.sourceHash] === pair.translationHash
      && pair.source.includes("<level>") && pair.ru.includes("<уровень>");
    const russian = historical ? pair.ru.replaceAll("<уровень>","<level>") : pair.ru;
    if (markers(pair.source).join("\0") !== markers(russian).join("\0")) {
      return { ok: false, reason: `placeholder-mismatch:${pair.path}:${pair.field}` };
    }
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
  const manifest = await Bun.file(join(worktree, SUPPORTED_HOSTS)).json() as { versions: { version: string; platforms: string[] }[] };
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
  // Source/platform/observation identities and historical translation bytes are separate invariants.
  // Neither a new observation nor a reviewer approval authorizes rewriting an old translation.
  {
    const current = new Set(identitiesOf(entries));
    const removed = identitiesOf(before).find(identity => !current.has(identity));
    if (removed !== undefined) return { failure: `historical-identity-removed:${removed}` };
    const translations = new Set(translationIdentitiesOf(entries));
    const changed = translationIdentitiesOf(before).find(identity => !translations.has(identity));
    if (changed !== undefined) return { failure: `historical-translation-changed:${changed}` };
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
    const requirements = await changedCatalogRequirements(worktree, baseSha, versions);
    if ("failure" in requirements) return requirements;
    const snapshots: BaselineSnapshot[] = [];
    for (const version of versions) for (const platform of ["win32", "linux", "darwin"]) {
      snapshots.push(await Bun.file(join(prepared.root, snapshotPath(version, platform))).json() as BaselineSnapshot);
    }
    let markerPairs: SemanticEvidence["markerPairs"];
    try { markerPairs = markerPairsOf(entries, snapshots); }
    catch (error) { return { failure: error instanceof Error ? error.message : String(error) }; }
    return {
      candidateVersion, supportedVersions: versions,
      coverage: measured.coverage, drift: measured.drift,
      reviewRows: review ?? [], reviewRequired: requirements.variants.length > 0 || review !== undefined, changedPaths,
      changedCatalogVariants: requirements.variants,
      identities: identitiesOf(entries), identitiesBefore: identitiesOf(before), markerPairs,
      translationIdentities: translationIdentitiesOf(entries), translationIdentitiesBefore: translationIdentitiesOf(before),
    };
  } finally {
    await dispose(prepared.root);
  }
}

/** Review only new identities and platform extensions, never every row in a changed data file. */
export async function changedCatalogRequirements(
  worktree: string, baseSha: string, versions: readonly string[],
): Promise<{ readonly variants: readonly {
  readonly path: string; readonly sourceHash: string; readonly translationHash: string; readonly platforms: readonly string[];
}[] } | { readonly failure: string }> {
  try {
    const current = await readCatalog(worktree);
    const before = readCatalogAtCommit(worktree, baseSha);
    const identities = new Set(identitiesOf(current));
    const removed = identitiesOf(before).find(identity => !identities.has(identity));
    if (removed) return { failure: `historical-identity-removed:${removed}` };
    const translations = new Set(translationIdentitiesOf(current));
    const changed = translationIdentitiesOf(before).find(identity => !translations.has(identity));
    if (changed) return { failure: `historical-translation-changed:${changed}` };
    const observed = new Map<string, Set<string>>();
    const oldObserved = new Map<string, Set<string>>();
    for (const version of versions) for (const platform of ["win32", "linux", "darwin"]) {
      const path = snapshotPath(version, platform);
      const file = Bun.file(join(worktree, path));
      if (!await file.exists()) return { failure: `baseline-missing:${version}-${platform}` };
      const add = (text: string, target: Map<string, Set<string>>) => {
        const snapshot = JSON.parse(text) as BaselineSnapshot;
        for (const [path, setting] of Object.entries(snapshot.settings)) {
          const key = `${path}\0${setting.sourceHash}`;
          const platforms = target.get(key) ?? new Set<string>();
          platforms.add(platform); target.set(key, platforms);
        }
      };
      add(await file.text(), observed);
      const blob = gitBytes(worktree, ["show", `${baseSha}:${path}`]);
      if (blob.code === 0) add(new TextDecoder().decode(blob.stdout), oldObserved);
    }
    const variants: { path: string; sourceHash: string; translationHash: string; platforms: readonly string[] }[] = [];
    for (const entry of current) {
      const key = `${entry.path}\0${entry.sourceHash}`;
      const previous = before.filter(old => old.path === entry.path && old.sourceHash === entry.sourceHash && old.translationHash === entry.translationHash);
      const platforms = [...(observed.get(key) ?? [])].filter(platform => entry.platforms.includes(platform as SourcePlatform)).sort();
      const extended = entry.platforms.some(platform => !previous.some(old => old.platforms.includes(platform)))
        || platforms.some(platform => !oldObserved.get(key)?.has(platform));
      if (!previous.length || extended) {
        if (!platforms.length) return { failure: `catalog-variant-without-baseline:${entry.path}:${entry.sourceHash}` };
        if (platforms.join(",") !== [...entry.platforms].sort().join(",")) return { failure: `catalog-platform-mismatch:${entry.path}:${entry.sourceHash}` };
        variants.push({ path: entry.path, sourceHash: entry.sourceHash, translationHash: entry.translationHash, platforms });
      }
    }
    return { variants };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

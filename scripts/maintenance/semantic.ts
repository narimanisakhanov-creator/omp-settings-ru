import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PATH, parseCatalogJSON, readCatalogJSON, translationFieldsHash } from "./catalog";
import type { LocalePack, SourcePlatform } from "../../src/translations/types";
import type { BaselineSnapshot } from "../../src/report";
import { snapshotValue } from "./snapshots";
import { approvedDelta, dispose, exportHostSnapshot, hostAliasOf, lockVerdict, prepareToolRoot, type ApprovedDelta } from "./measurement-environment";
import { SUPPORTED_HOSTS, SNAPSHOT_PLATFORMS, evidenceHosts, supportWindow, validateSupportedHostsManifest, snapshotPath, type SupportedHostsManifest } from "./paths";
import { asRecord } from "./json";
import { compareVersions } from "./policy";

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


/** Compare JSON meaning without making property order part of the manifest contract. */
function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  const record = asRecord(value);
  return record ? `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}` : JSON.stringify(value);
}

/** The accepted executable aliases must describe exactly the accepted active support. */
function acceptedAliasesFailure(accepted: Record<string, unknown>, support: SupportedHostsManifest): string | undefined {
  const expected = Object.fromEntries(support.versions.map(row => [row.package, `npm:@oh-my-pi/pi-coding-agent@${row.version}`]));
  const actual = Object.fromEntries(Object.entries(asRecord(accepted.devDependencies) ?? {}).filter(([name]) => name.startsWith("omp-host-")));
  return canonicalJSON(actual) === canonicalJSON(expected) ? undefined : "accepted-active-aliases-invalid";
}

interface ValidatedSupportTransition {
  readonly base: SupportedHostsManifest;
  readonly after: SupportedHostsManifest;
  readonly baseSnapshots: readonly BaselineSnapshot[];
  readonly afterSnapshots: readonly BaselineSnapshot[];
}

/** Freeze every preexisting row and snapshot before installing any candidate dependency. */
async function validatedSupportTransition(worktree: string, baseSha: string, candidateVersion: string): Promise<ValidatedSupportTransition> {
  const blob = gitBytes(worktree, ["show", `${baseSha}:${SUPPORTED_HOSTS}`]);
  if (blob.code !== 0) throw new Error("supported-hosts-baseline-unavailable");
  const base = validateSupportedHostsManifest(JSON.parse(new TextDecoder().decode(blob.stdout)));
  const after = validateSupportedHostsManifest(await Bun.file(join(worktree, SUPPORTED_HOSTS)).json());
  const {versions: _beforeActive, historical: _beforeHistory, ...baseFields} = base;
  const {versions: _afterActive, historical: _afterHistory, ...afterFields} = after;
  if (canonicalJSON(baseFields) !== canonicalJSON(afterFields)) throw new Error("supported-fields-changed");
  const oldRows = evidenceHosts(base);
  if (oldRows.some(row => row.version === candidateVersion)) throw new Error(`supported-candidate-already-present:${candidateVersion}`);
  if (base.versions.some(row => compareVersions(row.version, candidateVersion) >= 0)) throw new Error("supported-candidate-not-newer");
  const active = supportWindow([...base.versions.map(row => row.version), candidateVersion]);
  if (canonicalJSON(after.versions.map(row => row.version)) !== canonicalJSON(active)) throw new Error("supported-active-transition-invalid");
  const history = [...(base.historical ?? []), ...base.versions.filter(row => !active.includes(row.version))].sort((a,b) => compareVersions(a.version,b.version));
  if (canonicalJSON(after.historical) !== canonicalJSON(history)) throw new Error("supported-history-transition-invalid");
  for (const row of base.versions.filter(row => active.includes(row.version))) {
    if (canonicalJSON(after.versions.find(next => next.version === row.version)) !== canonicalJSON(row)) throw new Error(`supported-row-changed:${row.version}`);
  }
  const baseSnapshots: BaselineSnapshot[] = [];
  for (const row of oldRows) for (const platform of row.platforms) {
    const path = snapshotPath(row.version,platform);
    const accepted = gitBytes(worktree,["show",`${baseSha}:${path}`]);
    const file = Bun.file(join(worktree,path));
    if (accepted.code !== 0 || !await file.exists()) throw new Error(`historical-snapshot-changed:${row.version}-${platform}`);
    const bytes = await file.bytes();
    if (!Buffer.from(accepted.stdout).equals(Buffer.from(bytes)) || createHash("sha256").update(bytes).digest("hex") !== row.baselines?.[platform]) throw new Error(`historical-snapshot-changed:${row.version}-${platform}`);
    baseSnapshots.push(snapshotValue(JSON.parse(new TextDecoder().decode(bytes)),row.version,platform));
  }
  const candidate = after.versions.find(row => row.version === candidateVersion)!;
  const candidateSnapshots: BaselineSnapshot[] = [];
  for (const platform of SNAPSHOT_PLATFORMS) {
    try {
      const bytes = await Bun.file(join(worktree,snapshotPath(candidateVersion,platform))).bytes();
      if (createHash("sha256").update(bytes).digest("hex") !== candidate.baselines?.[platform]) throw new Error("baseline-mismatch");
      candidateSnapshots.push(snapshotValue(JSON.parse(new TextDecoder().decode(bytes)),candidateVersion,platform));
    } catch { throw new Error(`candidate-snapshot-source-mismatch:${candidateVersion}-${platform}`); }
  }
  return {base,after,baseSnapshots,afterSnapshots:[...baseSnapshots,...candidateSnapshots]};
}

/**
 * Манифест против базы: ранний отказ на посторонние поля и зависимости.
 * Полная допустимость дельты и сгенерированный граф lockfile проверяются доверенной средой ниже;
 * сравнение байтов lockfile здесь намеренно не применяется.
 */
export async function packageChanges(worktree: string, baseSha: string, candidateVersion: string): Promise<readonly string[]> {
  const blob = gitBytes(worktree, ["show", `${baseSha}:package.json`]);
  if (blob.code !== 0) throw new Error("package-baseline-unavailable");
  const file = Bun.file(`${worktree}/package.json`);
  if (!await file.exists()) throw new Error("package-json-missing");
  const before = JSON.parse(new TextDecoder().decode(blob.stdout)) as Record<string, unknown>;
  const after = JSON.parse(await file.text()) as Record<string, unknown>;
  const baseSupported = gitBytes(worktree, ["show", `${baseSha}:${SUPPORTED_HOSTS}`]);
  if (baseSupported.code !== 0) return ["supported-hosts-baseline-unavailable"];
  const manifest = validateSupportedHostsManifest(JSON.parse(new TextDecoder().decode(baseSupported.stdout)));
  const aliasFailure = acceptedAliasesFailure(before, manifest);
  if (aliasFailure) return [aliasFailure];
  const approved = approvedDelta(before, after, candidateVersion);
  if ("failure" in approved) return [approved.failure];
  if (!await Bun.file(`${worktree}/bun.lock`).exists()) return ["bun-lock-missing"];
  return [];
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
  try { parsed = JSON.parse(await file.text()) as unknown; } catch { throw new Error("supported-hosts-unreadable"); }
  return validateSupportedHostsManifest(parsed).versions.map(row => row.version);
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
export interface SemanticPreflight {
  readonly transition: ValidatedSupportTransition;
  readonly entries: readonly CatalogEntry[];
  readonly before: readonly CatalogEntry[];
  readonly acceptedManifest: string;
  readonly delta: ApprovedDelta;
}

/** Shared file/git-only gate: no dependency resolution, installation or candidate execution. */
export async function semanticPreflight(
  worktree: string, baseSha: string, candidateVersion: string,
): Promise<SemanticPreflight | { readonly failure: string }> {
  // Reject changed measurement code before any dependency subprocess.
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
  let transition: ValidatedSupportTransition;
  try { transition = await validatedSupportTransition(worktree,baseSha,candidateVersion); }
  catch (error) { return { failure: error instanceof Error ? error.message : String(error) }; }
  // Catalog/history validation also precedes every dependency subprocess.
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
  const accepted = JSON.parse(new TextDecoder().decode(acceptedManifest.stdout)) as Record<string, unknown>;
  const aliasFailure = acceptedAliasesFailure(accepted, transition.base);
  if (aliasFailure) return {failure:aliasFailure};
  const approved = approvedDelta(accepted, JSON.parse(await Bun.file(`${worktree}/package.json`).text()), candidateVersion);
  if ("failure" in approved) return approved;
  return { transition, entries, before, acceptedManifest: new TextDecoder().decode(acceptedManifest.stdout), delta: approved.delta };
}

/** Measure accepted code with the independently reconstructed approved graph. */
export async function collectSemanticEvidence(
  worktree: string, baseSha: string, candidateVersion: string,
  _supportedVersions: readonly string[], changedPaths: readonly string[],
  review?: readonly ReviewRow[], environment: MeasurementEnvironmentOptions = {},
): Promise<SemanticEvidence | { readonly failure: string }> {
  const deadlineMs = environment.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) return { failure: "measurement-deadline-invalid" };
  const preflight = await semanticPreflight(worktree, baseSha, candidateVersion);
  if ("failure" in preflight) return preflight;
  const { transition, entries, before, delta } = preflight;
  const manifest = transition.after;
  const versions = manifest.versions.map(row => row.version);
  const prepared = await prepareToolRoot({
    checkout: worktree, baseSha, root: join(tmpdir(), `omp-measurement-${randomUUID()}`),
    delta, deadlineMs, registry: environment.registry,
  });
  if ("failure" in prepared) return prepared;
  try {
    for (const version of versions) {
      if (!prepared.hosts.some(host => host.alias === hostAliasOf(version) && host.version === version)) {
        return { failure: `host-identity-missing:${hostAliasOf(version)}` };
      }
    }
    const candidateRow = manifest.versions.find(row => row.version === candidateVersion);
    if (!candidateRow) return { failure: `supported-version-missing:${candidateVersion}` };
    for (const platform of candidateRow.platforms) {
      const exported = await exportHostSnapshot({ root: prepared.root, alias: candidateRow.package, version: candidateRow.version, platform, lock: prepared.lock, deadlineMs });
      if ("failure" in exported) return { failure: `candidate-snapshot-source-mismatch:${candidateRow.version}-${platform}` };
      const expected = transition.afterSnapshots.find(snapshot => snapshot.version === candidateRow.version && snapshot.platform === platform)!;
      let actual: BaselineSnapshot;
      try { actual = snapshotValue(exported.snapshot, candidateRow.version, platform); }
      catch { return { failure: `candidate-snapshot-source-mismatch:${candidateRow.version}-${platform}` }; }
      if (canonicalJSON(actual) !== canonicalJSON(expected)) return { failure: `candidate-snapshot-source-mismatch:${candidateRow.version}-${platform}` };
    }
    const lock = lockVerdict(prepared.lock, await Bun.file(`${worktree}/bun.lock`).text(), Bun.version);
    if ("failure" in lock) return lock;
    const measured = await collectCoverageAndDrift(prepared.root, versions);
    if ("failure" in measured) return measured;
    const requirements = catalogDelta(entries,before,transition.afterSnapshots,transition.baseSnapshots);
    if ("failure" in requirements) return requirements;
    const snapshots = transition.afterSnapshots;
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

/** Pure semantic delta over the complete active + historical source corpus on both sides. */
export function catalogDelta(
  currentEntries: readonly CatalogEntry[], baseEntries: readonly CatalogEntry[],
  afterSnapshots: readonly BaselineSnapshot[], baseSnapshots: readonly BaselineSnapshot[],
): { readonly variants: SemanticEvidence["changedCatalogVariants"] } | { readonly failure: string } {
  const identities = new Set(identitiesOf(currentEntries));
  const removed = identitiesOf(baseEntries).find(identity => !identities.has(identity));
  if (removed) return { failure: `historical-identity-removed:${removed}` };
  const translations = new Set(translationIdentitiesOf(currentEntries));
  const changed = translationIdentitiesOf(baseEntries).find(identity => !translations.has(identity));
  if (changed) return { failure: `historical-translation-changed:${changed}` };
  const observations = (snapshots: readonly BaselineSnapshot[]) => {
    const result = new Map<string,Set<string>>();
    for (const snapshot of snapshots) for (const [path,setting] of Object.entries(snapshot.settings)) {
      const key = `${path}\0${setting.sourceHash}`;
      const platforms = result.get(key) ?? new Set<string>();
      platforms.add(snapshot.platform); result.set(key,platforms);
    }
    return result;
  };
  const observed = observations(afterSnapshots);
  const oldObserved = observations(baseSnapshots);
  const variants: {path:string;sourceHash:string;translationHash:string;platforms:readonly string[]}[] = [];
  for (const entry of currentEntries) {
    const key = `${entry.path}\0${entry.sourceHash}`;
    const previous = baseEntries.filter(old => old.path === entry.path && old.sourceHash === entry.sourceHash && old.translationHash === entry.translationHash);
    const platforms = [...(observed.get(key) ?? [])].filter(platform => entry.platforms.includes(platform as SourcePlatform)).sort();
    const extended = entry.platforms.some(platform => !previous.some(old => old.platforms.includes(platform)))
      || platforms.some(platform => !oldObserved.get(key)?.has(platform));
    if (!previous.length || extended) {
      if (!platforms.length) return { failure: `catalog-variant-without-baseline:${entry.path}:${entry.sourceHash}` };
      if (platforms.join(",") !== [...entry.platforms].sort().join(",")) return { failure: `catalog-platform-mismatch:${entry.path}:${entry.sourceHash}` };
      variants.push({path:entry.path,sourceHash:entry.sourceHash,translationHash:entry.translationHash,platforms});
    }
  }
  return {variants};
}

/** File adapter: registry/active window arguments never narrow the historical source corpus. */
export async function changedCatalogRequirements(
  worktree: string, baseSha: string, _versions: readonly string[],
): Promise<{ readonly variants: SemanticEvidence["changedCatalogVariants"] } | { readonly failure: string }> {
  try {
    const current = await readCatalog(worktree);
    const before = readCatalogAtCommit(worktree,baseSha);
    const afterManifest = validateSupportedHostsManifest(await Bun.file(join(worktree,SUPPORTED_HOSTS)).json());
    const blob = gitBytes(worktree,["show",`${baseSha}:${SUPPORTED_HOSTS}`]);
    if (blob.code !== 0) return {failure:"supported-hosts-baseline-unavailable"};
    const baseManifest = validateSupportedHostsManifest(JSON.parse(new TextDecoder().decode(blob.stdout)));
    const afterSnapshots: BaselineSnapshot[] = [];
    const baseSnapshots: BaselineSnapshot[] = [];
    for (const row of evidenceHosts(afterManifest)) for (const platform of row.platforms) {
      afterSnapshots.push(snapshotValue(await Bun.file(join(worktree,snapshotPath(row.version,platform))).json(),row.version,platform));
    }
    for (const row of evidenceHosts(baseManifest)) for (const platform of row.platforms) {
      const source = gitBytes(worktree,["show",`${baseSha}:${snapshotPath(row.version,platform)}`]);
      if (source.code !== 0) return {failure:`baseline-missing:${row.version}-${platform}`};
      baseSnapshots.push(snapshotValue(JSON.parse(new TextDecoder().decode(source.stdout)),row.version,platform));
    }
    return catalogDelta(current,before,afterSnapshots,baseSnapshots);
  } catch (error) { return {failure:error instanceof Error ? error.message : String(error)}; }
}

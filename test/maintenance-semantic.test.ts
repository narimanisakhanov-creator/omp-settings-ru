import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogFromSource, changedCatalogRequirements, claimedVersions, collectSemanticEvidence, identitiesOf,
  markerPairsOf, markers, measurementChanges, missingMarkers, packageChanges, readCatalog, readCatalogAtCommit,
  translationHash, validateSemantic, type CatalogEntry, type SemanticEvidence,
} from "../scripts/maintenance/semantic";
import { ACCEPTANCE_SCENARIO_FILES } from "../scripts/maintenance/acceptance-scenarios";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";
import { semanticRuntimeFixture } from "./maintenance-runtime-fixture";
import { parseLock } from "../scripts/maintenance/measurement-environment";

const policy = validatePolicy(rawPolicy);
const VERSIONS = ["18.6.1", "18.8.0", "18.8.4", "18.8.7"] as const;
const CANDIDATE = "18.8.9";
const T = "src/translations/ru-part-1.ts";
/** Пути, разрешённые политикой и не являющиеся файлами перевода: строки ревью они не требуют. */
const PLAIN_PATHS = ["package.json", "baseline/supported-hosts.json"] as const;

/** Настоящая форма каталога: `Record<путь настройки, SettingTranslationFields>` с sourceHash из метаданных хоста. */
const CATALOG = `import type { SettingTranslationFields } from "./types";
export const ruPart1: Readonly<Record<string, SettingTranslationFields>> = {
  "theme.dark": {
    sourceHash: "e14e408d3c42b38c7ccd2cdf7f9eead7e708b0662589c657f390577406358f19",
    label: "Тёмная тема",
    description: "Тема, используемая когда фон терминала тёмный",
  },
  "spelling.autocomplete": {
    sourceHash: "d84b17e49e184329c94a1eac34ba67d51fcbb4452d4e55c3328a1031c318168f",
    label: "Автодополнение",
    descriptionSource: "Suggest words from the {dictionary} as you type",
    description: "Подсказывать слова из {dictionary} при вводе",
    options: {
      system: { label: "Системный", description: "Словарь системы" },
      apple: { label: "Apple", description: "Словарь macOS" },
    },
  },
};
`;

const VERSION_SET = [...VERSIONS, CANDIDATE];
const PLATFORMS = ["win32", "linux", "darwin"] as const;

function evidence(overrides: Partial<SemanticEvidence> = {}): SemanticEvidence {
  const entries = catalogFromSource(CATALOG);
  return {
    candidateVersion: CANDIDATE,
    supportedVersions: VERSIONS,
    coverage: VERSION_SET.flatMap(version =>
      PLATFORMS.map(platform => ({ version, platform, complete: 404, total: 404 }))),
    drift: VERSION_SET.flatMap(version =>
      PLATFORMS.map(platform => ({ version, platform, added: 0, removed: 0, changed: 0 }))),
    // Изменены только не-переводные пути, поэтому строк ревью нет: их набор обязан совпасть с файлами перевода.
    reviewRows: [],
    reviewRequired: false,
    changedCatalogVariants: [],
    changedPaths: [...PLAIN_PATHS],
    identities: identitiesOf(entries),
    identitiesBefore: identitiesOf(entries),
    markerPairs: markerPairsOf(entries),
    ...overrides,
  };
}

/** Требование к строке ревью, выведенное из варианта каталога и базовых снимков. */
function requirement(entry: CatalogEntry, platforms: readonly string[] = ["win32"]) {
  return { path: entry.path, sourceHash: entry.sourceHash, translationHash: entry.translationHash, platforms };
}

function reviewRow(entry: CatalogEntry, platforms: readonly string[] = ["win32"]) {
  return {
    path: entry.path, sourceHash: entry.sourceHash, translationHash: entry.translationHash,
    reviewedAtVersion: CANDIDATE, platforms,
  };
}

describe("разбор реального каталога", () => {
  test("читает sourceHash, label, description, descriptionSource и вложенные options", () => {
    const entries = catalogFromSource(CATALOG);
    expect(entries.map(entry => entry.path)).toEqual(["theme.dark", "spelling.autocomplete"]);
    const spelling = entries.find(entry => entry.path === "spelling.autocomplete")!;
    expect(spelling.sourceHash).toBe("d84b17e49e184329c94a1eac34ba67d51fcbb4452d4e55c3328a1031c318168f");
    expect(spelling.descriptionSource).toBe("Suggest words from the {dictionary} as you type");
    expect(Object.keys(spelling.options ?? {})).toEqual(["system", "apple"]);
    expect(spelling.options?.apple?.description).toBe("Словарь macOS");
    expect(spelling.translationHash).toBe(translationHash({
      sourceHash: spelling.sourceHash, label: spelling.label, description: spelling.description,
      descriptionSource: spelling.descriptionSource, warning: spelling.warning, options: spelling.options,
    }));
  });

  test("код каталога не исполняется, а нелитеральные значения отклоняются", () => {
    // Вызов в значении свойства — не литерал: разбор обязан отказать, а не исполнить код.
    expect(() => catalogFromSource(`export const bad = { x: dangerous() };`)).toThrow("nonliteral-catalog");
    expect(() => catalogFromSource(`export const bad = { a: { sourceHash: "${"a".repeat(64)}", label: \`T\` } };`))
      .toThrow("nonliteral-catalog");
    expect(() => catalogFromSource(`export const bad = { a: { sourceHash: "${"a".repeat(64)}", ...rest } };`))
      .toThrow("nonliteral-catalog");
  });

  test("файл каталога — только данные: посторонние утверждения уровня модуля отклоняются", () => {
    const map = `export const ru = { a: { sourceHash: "${"a".repeat(64)}", label: "A" } };`;
    // Значимый импорт выполнил бы код зависимости при импорте файла.
    expect(() => catalogFromSource(`import "./side-effect";\n${map}`)).toThrow("catalog-module-side-effect:import");
    expect(() => catalogFromSource(`import { helper } from "./util";\n${map}`)).toThrow("catalog-module-side-effect:import");
    // Вызов, объявление функции и присваивание — исполняемый код, а не данные.
    expect(() => catalogFromSource(`await Bun.write("x", "y");\n${map}`)).toThrow(/catalog-module-side-effect/);
    expect(() => catalogFromSource(`function boot() {}\n${map}`)).toThrow(/catalog-module-side-effect/);
    expect(() => catalogFromSource(`let counter = 0;\n${map}`)).toThrow("catalog-module-side-effect:variable");
    // Type-импорт и единственная экспортируемая карта — допустимая форма данных.
    const valid = `import type { SettingTranslationFields } from "./types";\n${map}\n`;
    expect(catalogFromSource(valid).map(entry => entry.path)).toEqual(["a"]);
    expect(() => catalogFromSource(`export const {ru = dangerous()} = {a: {sourceHash: "${"a".repeat(64)}", label:"A"}};`))
      .toThrow("catalog-module-side-effect:binding");
  });

  test("запись без sourceHash в форме sha256 отклоняется, а не выбрасывается", () => {
    // Молчаливый пропуск записи — потеря каталога: нераспознанная форма обязана отказать.
    expect(() => catalogFromSource(`export const ru = { a: { sourceHash: "nope", label: "A" } };`))
      .toThrow("invalid-source-hash:a");
    expect(() => catalogFromSource(`export const ru = { a: { label: "A" } };`)).toThrow("invalid-source-hash:a");
    expect(() => catalogFromSource(`export const ru = { a: "строка" };`)).toThrow("malformed-catalog-entry:a");
  });

  test("неизвестное динамическое выражение карты отклоняется", () => {
    expect(() => catalogFromSource(`export const ru = loadCatalog();`)).toThrow("nonliteral-catalog");
    expect(() => catalogFromSource(`export const ru = baseCatalog;`)).toThrow("nonliteral-catalog");
    expect(() => catalogFromSource(`export const ru = { ...baseCatalog };`)).toThrow("nonliteral-catalog");
  });

  test("идентичности включают путь настройки, sourceHash и хеш перевода", () => {
    const identities = identitiesOf(catalogFromSource(CATALOG));
    expect(identities).toHaveLength(2);
    expect(identities.some(identity => identity.startsWith("theme.dark:e14e408d"))).toBe(true);
  });

  test("пары маркеров берутся из descriptionSource, а не из произвольного текста", () => {
    const pairs = markerPairsOf(catalogFromSource(CATALOG));
    expect(pairs).toEqual([{
      path: "spelling.autocomplete",
      source: "Suggest words from the {dictionary} as you type",
      ru: "Подсказывать слова из {dictionary} при вводе",
    }]);
  });
});

describe("подстановочные маркеры", () => {
  test("распознаёт фигурные, двойные фигурные, printf и угловые маркеры", () => {
    expect(markers("{path} {{name}} %s <key>")).toEqual(["%s", "<key>", "{path}", "{{name}}"]);
    expect(markers("без маркеров")).toEqual([]);
  });

  test("находит утраченные маркеры", () => {
    expect(missingMarkers("{path} файл", "файл {path}")).toEqual([]);
    expect(missingMarkers("{path} файл", "файл")).toEqual(["{path}"]);
    expect(missingMarkers("{{a}} %d", "{{a}}")).toEqual(["%d"]);
  });
});

describe("содержательный гейт", () => {
  test("полный набор с нулевым дрейфом проходит", () => {
    expect(validateSemantic(evidence(), policy)).toEqual({ ok: true });
  });

  test("неполное покрытие кандидата отклоняется", () => {
    const broken = evidence().coverage.map(pair =>
      pair.version === CANDIDATE && pair.platform === "linux" ? { ...pair, complete: 400 } : pair);
    expect(validateSemantic(evidence({ coverage: broken }), policy))
      .toEqual({ ok: false, reason: `coverage-incomplete:${CANDIDATE}-linux` });
  });

  test("нулевой total в покрытии отклоняется", () => {
    const broken = evidence().coverage.map(pair =>
      pair.version === "18.8.0" && pair.platform === "win32" ? { ...pair, complete: 0, total: 0 } : pair);
    expect(validateSemantic(evidence({ coverage: broken }), policy))
      .toEqual({ ok: false, reason: "coverage-incomplete:18.8.0-win32" });
  });

  test("пропущенная версия в покрытии отклоняется", () => {
    const broken = evidence().coverage.filter(pair => pair.version !== "18.8.4");
    expect(validateSemantic(evidence({ coverage: broken }), policy))
      .toEqual({ ok: false, reason: "coverage-missing:18.8.4" });
  });

  test("версия покрытия вне набора поддержки отклоняется", () => {
    const extra = [...evidence().coverage, { version: "18.9.0", platform: "win32", complete: 404, total: 404 }];
    expect(validateSemantic(evidence({ coverage: extra }), policy))
      .toEqual({ ok: false, reason: "coverage-unexpected-version:18.9.0" });
  });

  test("ненулевой дрейф отклоняется", () => {
    const broken = evidence().drift.map(pair =>
      pair.version === "18.8.7" && pair.platform === "darwin" ? { ...pair, changed: 1 } : pair);
    expect(validateSemantic(evidence({ drift: broken }), policy))
      .toEqual({ ok: false, reason: "drift-nonzero:18.8.7-darwin" });
  });

  test("неполный дрейф отклоняется", () => {
    const broken = evidence().drift.slice(1);
    expect(validateSemantic(evidence({ drift: broken }), policy))
      .toEqual({ ok: false, reason: "drift-incomplete" });
  });

  test("изменение вне разрешённых путей отклоняется", () => {
    expect(validateSemantic(evidence({ changedPaths: [".github/workflows/check.yml"] }), policy))
      .toEqual({ ok: false, reason: "path-outside-policy:.github/workflows/check.yml" });
  });

  test("удаление исторической идентичности отклоняется даже при том же количестве записей", () => {
    const entries = catalogFromSource(CATALOG);
    const swapped: CatalogEntry[] = [{ ...entries[0]!, sourceHash: "b".repeat(64), translationHash: "c".repeat(64) }, entries[1]!];
    expect(validateSemantic(evidence({ identities: identitiesOf(swapped) }), policy).ok).toBe(false);
    const verdict = validateSemantic(evidence({ identities: identitiesOf(swapped) }), policy);
    expect(verdict.ok === false && verdict.reason.startsWith("historical-identity-removed")).toBe(true);
  });

  test("строки ревью по вариантам изменённого файла каталога кандидата принимаются", () => {
    const entries = catalogFromSource(CATALOG);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: entries.map(entry => requirement(entry)),
      reviewRows: entries.map(entry => reviewRow(entry)),
    }), policy)).toEqual({ ok: true });
  });

  test("пропущенный вариант изменённого файла каталога отклоняется", () => {
    const entries = catalogFromSource(CATALOG);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: entries.map(entry => requirement(entry)),
      reviewRows: [reviewRow(entries[0]!)],
    }), policy)).toEqual({ ok: false, reason: `review-row-missing:${entries[1]!.path}:${entries[1]!.sourceHash}` });
  });

  test("строка ревью по варианту вне изменённых файлов каталога отклоняется", () => {
    const entries = catalogFromSource(CATALOG);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entries[0]!)],
      reviewRows: entries.map(entry => reviewRow(entry)),
    }), policy)).toEqual({ ok: false, reason: `review-row-unknown:${entries[1]!.path}:${entries[1]!.sourceHash}` });
  });

  test("дубли строк ревью по одному варианту отклоняются", () => {
    const entries = catalogFromSource(CATALOG);
    const entry = entries[0]!;
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry)],
      reviewRows: [reviewRow(entry), reviewRow(entry)],
    }), policy)).toEqual({ ok: false, reason: `review-row-duplicate:${entry.path}:${entry.sourceHash}` });
  });

  test("чужой отпечаток перевода в строке ревью отклоняется", () => {
    const entry = catalogFromSource(CATALOG)[0]!;
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry)],
      reviewRows: [{ ...reviewRow(entry), translationHash: "e".repeat(64) }],
    }), policy)).toEqual({ ok: false, reason: `review-translation-mismatch:${entry.path}:${entry.sourceHash}` });
  });

  test("неточный набор платформ в строке ревью отклоняется", () => {
    const entry = catalogFromSource(CATALOG)[0]!;
    // Вариант отдаётся трём платформам, а строка ревью называет одну: набор обязан совпасть точно.
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry, ["darwin", "linux", "win32"])],
      reviewRows: [reviewRow(entry, ["win32"])],
    }), policy)).toEqual({ ok: false, reason: `review-platform-mismatch:${entry.path}:${entry.sourceHash}` });
  });

  test("пропущенный исторический вариант того же пути отклоняется", () => {
    // Один путь настройки с двумя sourceHash — два исторических варианта: строка ревью обязана быть на каждый.
    const older = "a".repeat(64);
    const newer = "b".repeat(64);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [
        { path: "composer.tokenRate", sourceHash: newer, translationHash: "d".repeat(64), platforms: ["win32"] },
        { path: "composer.tokenRate", sourceHash: older, translationHash: "c".repeat(64), platforms: ["win32"] },
      ],
      identities: [`composer.tokenRate:${older}:${"c".repeat(64)}`, `composer.tokenRate:${newer}:${"d".repeat(64)}`],
      identitiesBefore: [`composer.tokenRate:${older}:${"c".repeat(64)}`, `composer.tokenRate:${newer}:${"d".repeat(64)}`],
      reviewRows: [{
        path: "composer.tokenRate", sourceHash: newer, translationHash: "d".repeat(64),
        reviewedAtVersion: CANDIDATE, platforms: ["win32"],
      }],
    }), policy)).toEqual({ ok: false, reason: `review-row-missing:composer.tokenRate:${older}` });
  });

  test("перенесённая версия ревью не принимается", () => {
    const entry = catalogFromSource(CATALOG)[0]!;
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry)],
      reviewRows: [{ ...reviewRow(entry), reviewedAtVersion: "18.8.7" }],
    }), policy)).toEqual({ ok: false, reason: `review-stale-version:${entry.path}` });
  });

  test("отпечаток ревью, не совпавший с каталогом, отклоняется", () => {
    const entry = catalogFromSource(CATALOG)[0]!;
    const foreign = "f".repeat(64);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [{ ...requirement(entry), sourceHash: foreign }],
      reviewRows: [{ ...reviewRow(entry), sourceHash: foreign }],
    }), policy)).toEqual({ ok: false, reason: `review-hash-mismatch:${entry.path}` });
  });

  test("манифест ревью, не запрошенный стадией, отклоняется", () => {
    const entry = catalogFromSource(CATALOG)[0]!;
    expect(validateSemantic(evidence({ reviewRows: [reviewRow(entry)] }), policy))
      .toEqual({ ok: false, reason: "review-rows-unexpected" });
  });

  test("изменение файла перевода вне известных файлов каталога отклоняется", () => {
    const changed = "src/translations/ru.ts";
    expect(validateSemantic(evidence({ changedPaths: [...PLAIN_PATHS, changed] }), policy))
      .toEqual({ ok: false, reason: `unknown-catalog-file:${changed}` });
  });

  test("утраченный маркер отклоняется", () => {
    const pairs = [{ path: "spelling.autocomplete", source: "from the {dictionary} as you type", ru: "слова при вводе" }];
    expect(validateSemantic(evidence({ markerPairs: pairs }), policy))
      .toEqual({ ok: false, reason: "placeholder-lost:spelling.autocomplete:{dictionary}" });
  });

  test("пустой фактический каталог или пустая база — отказ, а не успех", () => {
    // Каталог проекта никогда не пуст: пустые идентичности означают непрочитанный каталог.
    expect(validateSemantic(evidence({ identities: [] }), policy)).toEqual({ ok: false, reason: "catalog-empty" });
    expect(validateSemantic(evidence({ identitiesBefore: [] }), policy))
      .toEqual({ ok: false, reason: "baseline-catalog-empty" });
  });

  test("неполная сетка «версия × платформа» и дубли в покрытии/дрейфе отклоняются", () => {
    const missingPlatform = evidence().coverage.filter(pair => !(pair.version === "18.8.4" && pair.platform === "darwin"));
    expect(validateSemantic(evidence({ coverage: missingPlatform }), policy))
      .toEqual({ ok: false, reason: "coverage-missing:18.8.4-darwin" });
    const duplicated = [...evidence().coverage, evidence().coverage[0]!];
    expect(validateSemantic(evidence({ coverage: duplicated }), policy))
      .toEqual({ ok: false, reason: `coverage-duplicate:${VERSIONS[0]}-win32` });
    const extraDrift = [...evidence().drift, evidence().drift[0]!];
    expect(validateSemantic(evidence({ drift: extraDrift }), policy))
      .toEqual({ ok: false, reason: `drift-duplicate:${VERSIONS[0]}-win32` });
    // Длина совпадает и дублей нет, но один ключ сетки подменён версией вне набора — сетка обязана отказать.
    const driftedKeys = evidence().drift.map((pair, index) =>
      index === 0 ? { ...pair, version: "18.9.0", platform: "win32" } : pair);
    expect(validateSemantic(evidence({ drift: driftedKeys }), policy))
      .toEqual({ ok: false, reason: `drift-missing:${VERSIONS[0]}-win32` });
  });
});

const REPO_ROOT = join(import.meta.dir, "..");
const CATALOG_DIR = "src/translations";
const CATALOG_FILE_NAMES = ["ru-part-1.ts", "ru-part-2.ts", "ru-part-3.ts", "ru-variants.ts"] as const;

function catalogSource(entries: readonly string[]): string {
  return `import type { SettingTranslationFields } from "./types";
export const ru: Readonly<Record<string, SettingTranslationFields>> = {
${entries.join(",\n")}
};
`;
}

function catalogEntry(path: string, hashChar: string, label = "Метка"): string {
  return `  "${path}": { sourceHash: "${hashChar.repeat(64)}", label: "${label}" }`;
}

function writeCatalog(dir: string, contents: Readonly<Record<string, string>>): void {
  mkdirSync(join(dir, CATALOG_DIR), { recursive: true });
  for (const name of CATALOG_FILE_NAMES) {
    const body = contents[name] ?? catalogSource([]);
    writeFileSync(join(dir, CATALOG_DIR, name), body);
  }
}

async function failureMessage(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("ожидался отказ, но вызов завершился успешно");
}

/** Манифест поддержки хостов в форме контракта: пары «версия × платформы» объявляет сам фикстурный тест. */
function hostManifest(versions: readonly (readonly [string, readonly string[]])[]): unknown {
  return { schemaVersion: 1, versions: versions.map(([version, platforms]) => ({ version, platforms, package: `omp-host-${version.replaceAll(".","")}` })) };
}

/** Корни принадлежат коллектору: ни успех, ни ранний отказ после установки не должны оставлять их в temp. */
function measurementRoots(): string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith("omp-measurement-")).sort();
}


describe("каталог рабочего дерева и базы", () => {
  test("readCatalog отказывает на отсутствующем файле каталога, а не пропускает его", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-missing-file-"));
    try {
      writeCatalog(root, {});
      rmSync(join(root, CATALOG_DIR, "ru-variants.ts"));
      expect(await failureMessage(() => readCatalog(root))).toBe("catalog-file-missing:ru-variants.ts");
      expect(await failureMessage(() => readCatalog(join(root, "нет-такого-каталога"))))
        .toBe("catalog-file-missing:ru-part-1.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readCatalogAtCommit читает коммит и отказывает на отсутствующем блобе", () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-commit-"));
    try {
      const git = (...args: readonly string[]) => Bun.spawnSync(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(git("init").exitCode).toBe(0);
      writeCatalog(root, {
        "ru-part-1.ts": catalogSource([catalogEntry("part.one", "a")]),
        "ru-part-2.ts": catalogSource([catalogEntry("part.two", "b")]),
        "ru-part-3.ts": catalogSource([catalogEntry("part.three", "c")]),
      });
      rmSync(join(root, CATALOG_DIR, "ru-variants.ts"));
      expect(git("add", "-A").exitCode).toBe(0);
      expect(git("commit", "-m", "partial").exitCode).toBe(0);
      expect(() => readCatalogAtCommit(root, "HEAD")).toThrow("catalog-blob-missing");
      writeFileSync(join(root, CATALOG_DIR, "ru-variants.ts"), catalogSource([catalogEntry("part.variant", "d")]));
      expect(git("add", "-A").exitCode).toBe(0);
      expect(git("commit", "-m", "full").exitCode).toBe(0);
      expect(readCatalogAtCommit(root, "HEAD").map(entry => entry.path))
        .toEqual(["part.one", "part.three", "part.two", "part.variant"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("изменённый исторический вариант каталога блокируется до установки", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const file = join(fixture.checkout,T);
      const text = await Bun.file(file).text();
      const before = catalogFromSource(text).find(entry=>entry.path==="theme.dark")!;
      writeFileSync(file,text.replace("Перевод theme.dark","Переписанный перевод"));
      const requests = fixture.requests();
      expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
        .toEqual({failure:`historical-identity-removed:${before.path}:${before.sourceHash}:${before.translationHash}`});
      expect(fixture.requests()).toEqual(requests);
    } finally { await fixture.close(); }
  },90_000);

  test("требования строк ревью выводятся из базовых снимков поддерживаемых версий", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-requirements-"));
    try {
      writeCatalog(root, { "ru-part-2.ts": catalogSource([catalogEntry("theme.dark", "a", "Тёмная")]) });
      const snapshot = (settings: Readonly<Record<string, string>>): string => JSON.stringify({
        version: "18.8.7", platform: "win32",
        settings: Object.fromEntries(Object.entries(settings).map(([path, hash]) => [path, { sourceHash: hash }])),
      });
      mkdirSync(join(root, "baseline"), { recursive: true });
      for (const platform of ["win32", "linux", "darwin"]) {
        writeFileSync(join(root, `baseline/18.8.7-${platform}.json`), snapshot({ "theme.dark": "a".repeat(64) }));
      }
      const collected = await changedCatalogRequirements(root, ["src/translations/ru-part-2.ts"], ["18.8.7"]);
      if ("failure" in collected) throw new Error(collected.failure);
      const variant = collected.variants[0]!;
      expect(variant.path).toBe("theme.dark");
      expect(variant.platforms).toEqual(["darwin", "linux", "win32"]);
      expect(variant.translationHash).toBe(catalogFromSource(catalogSource([catalogEntry("theme.dark", "a", "Тёмная")]))[0]!.translationHash);
      // Снимок платформы без этого варианта не должен попасть в требуемый набор.
      writeFileSync(join(root, "baseline/18.8.7-darwin.json"), snapshot({}));
      const narrowed = await changedCatalogRequirements(root, ["src/translations/ru-part-2.ts"], ["18.8.7"]);
      if ("failure" in narrowed) throw new Error(narrowed.failure);
      expect(narrowed.variants[0]!.platforms).toEqual(["linux", "win32"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("переписанный измерительный код обесценивает доказательство до запуска скриптов", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-measurement-"));
    try {
      const git = (...args: readonly string[]) => Bun.spawnSync(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(git("init").exitCode).toBe(0);
      writeCatalog(root, {});
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, "src/translations"), { recursive: true });
      writeFileSync(join(root, "scripts/check-coverage.ts"), "// измерительный код\n");
      writeFileSync(join(root, "src/report.ts"), "// вспомогательный модуль измерения\n");
      expect(git("add", "-A").exitCode).toBe(0);
      expect(git("commit", "-m", "base").exitCode).toBe(0);
      // Не тронуто — изменений измерительного кода нет.
      expect(await measurementChanges(root, "HEAD")).toEqual([]);
      // Точка входа и вспомогательный модуль одинаково отменяют силу измерения.
      writeFileSync(join(root, "scripts/check-coverage.ts"), "// подмена\n");
      expect(await measurementChanges(root, "HEAD")).toEqual(["scripts/check-coverage.ts"]);
      writeFileSync(join(root, "scripts/check-coverage.ts"), "// измерительный код\n");
      writeFileSync(join(root, "src/report.ts"), "// подмена вспомогательного модуля\n");
      expect(await measurementChanges(root, "HEAD")).toEqual(["src/report.ts"]);
      // Данные каталога перевода — исключение: их изменение измерение не отменяет.
      writeFileSync(join(root, "src/translations/ru-part-2.ts"), catalogSource([catalogEntry("theme.dark", "a")]));
      expect(await measurementChanges(root, "HEAD")).toEqual(["src/report.ts"]);
      writeFileSync(join(root, "src/report.ts"), "// вспомогательный модуль измерения\n");
      expect(await measurementChanges(root, "HEAD")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("манифест: версия и пин хоста кандидата допустимы, прочее изменение — отказ", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-package-"));
    try {
      const git = (...args: readonly string[]) => Bun.spawnSync(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(git("init").exitCode).toBe(0);
      const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({
        name: "omp-settings-ru", version: "0.5.0",
        dependencies: { "omp-host-1884": "npm:@oh-my-pi/pi-coding-agent@18.8.4" },
        peerDependencies: { "@oh-my-pi/pi-coding-agent": "18.6.1 || 18.8.4" },
        scripts: { test: "bun test" }, ...extra,
      });
      writeFileSync(join(root, "package.json"), manifest());
      writeFileSync(join(root, "bun.lock"), "lock\n");
      expect(git("add", "-A").exitCode).toBe(0);
      expect(git("commit", "-m", "base").exitCode).toBe(0);
      expect(await packageChanges(root, "HEAD", "18.8.7")).toEqual([]);
      // Версия плагина и новый пин хоста кандидата — законная часть выпуска.
      writeFileSync(join(root, "package.json"), manifest({
        version: "0.6.0",
        dependencies: { "omp-host-1884": "npm:@oh-my-pi/pi-coding-agent@18.8.4", "omp-host-1887": "npm:@oh-my-pi/pi-coding-agent@18.8.7" },
        peerDependencies: { "@oh-my-pi/pi-coding-agent": "18.6.1 || 18.8.4 || 18.8.7" },
      }));
      expect(await packageChanges(root, "HEAD", "18.8.7")).toEqual([]);
      // Произвольная зависимость, тестовый скрипт и постороннее поле — отказ.
      const pinned = (extra: Record<string, unknown> = {}) => manifest({
        ...extra,
        dependencies: { "omp-host-1884": "npm:@oh-my-pi/pi-coding-agent@18.8.4", ...(extra.dependencies as object ?? {}) },
      });
      writeFileSync(join(root, "package.json"), pinned({ dependencies: { left: "1.0.0" } }));
      expect(await packageChanges(root, "HEAD", "18.8.7")).toEqual(["package-dependency-changed:left"]);
      writeFileSync(join(root, "package.json"), pinned({ scripts: { test: "bun test", postinstall: "curl evil" } }));
      expect(await packageChanges(root, "HEAD", "18.8.7")).toEqual(["package-field-changed:scripts"]);
      writeFileSync(join(root, "package.json"), pinned({ omp: { preload: "./evil.ts" } }));
      expect(await packageChanges(root, "HEAD", "18.8.7")).toEqual(["package-field-changed:omp"]);
      // Пин хоста, не упоминающий версию кандидата, не подтверждён.
      writeFileSync(join(root, "package.json"), manifest({ dependencies: { "omp-host-1884": "npm:@oh-my-pi/pi-coding-agent@18.8.9" } }));
      expect(await packageChanges(root, "HEAD", "18.8.7")).toEqual(["package-dependency-unverified:omp-host-1884"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("вариант без следа в базовых снимках не подтверждается платформенно", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-unbaselined-"));
    try {
      writeCatalog(root, { "ru-part-2.ts": catalogSource([catalogEntry("theme.dark", "a", "Тёмная")]) });
      mkdirSync(join(root, "baseline"), { recursive: true });
      for (const platform of ["win32", "linux", "darwin"]) {
        writeFileSync(join(root, `baseline/18.8.7-${platform}.json`), JSON.stringify({ settings: {} }));
      }
      const collected = await changedCatalogRequirements(root, ["src/translations/ru-part-2.ts"], ["18.8.7"]);
      expect(collected).toEqual({ failure: `catalog-variant-without-baseline:theme.dark:${"a".repeat(64)}` });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("варианты одного пути с разными sourceHash сосуществуют, точный дубль схлопывается", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-variants-"));
    try {
      // Один путь с двумя разными sourceHash — два исторических варианта, оба обязаны выжить.
      writeCatalog(root, {
        "ru-part-1.ts": catalogSource([catalogEntry("theme.dark", "a", "Тёмная")]),
        "ru-part-2.ts": catalogSource([catalogEntry("theme.dark", "b", "Тёмная (историческая)")]),
      });
      const kept = await readCatalog(root);
      expect(kept.map(entry => entry.path)).toEqual(["theme.dark", "theme.dark"]);
      expect(new Set(kept.map(entry => entry.sourceHash)).size).toBe(2);
      // Точный дубль (тот же путь и sourceHash, тот же перевод) схлопывается в одну запись.
      writeCatalog(root, {
        "ru-part-1.ts": catalogSource([catalogEntry("theme.dark", "a", "Тёмная")]),
        "ru-part-2.ts": catalogSource([catalogEntry("theme.dark", "a", "Тёмная")]),
      });
      expect(await readCatalog(root)).toHaveLength(1);
      // Тот же путь и sourceHash, но другой перевод — противоречие, а не тихая замена.
      writeCatalog(root, {
        "ru-part-1.ts": catalogSource([catalogEntry("theme.dark", "a", "Тёмная")]),
        "ru-part-2.ts": catalogSource([catalogEntry("theme.dark", "a", "Иначе")]),
      });
      expect(await failureMessage(() => readCatalog(root))).toBe(`conflicting-translation:theme.dark:${"a".repeat(64)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("реальный каталог: 138+137+135+10 = 420 записей, 420 идентичностей, 410 путей", async () => {
    const perFile: Record<string, number> = {
      "ru-part-1.ts": 138, "ru-part-2.ts": 137, "ru-part-3.ts": 135, "ru-variants.ts": 10,
    };
    for (const [name, count] of Object.entries(perFile)) {
      const text = await Bun.file(join(REPO_ROOT, CATALOG_DIR, name)).text();
      expect(catalogFromSource(text)).toHaveLength(count);
    }
    const entries = await readCatalog(REPO_ROOT);
    expect(entries).toHaveLength(420);
    expect(identitiesOf(entries)).toHaveLength(420);
    expect(new Set(entries.map(entry => entry.path)).size).toBe(410);
    // Исторические варианты действительно сохраняются как пары одного пути.
    expect(entries.filter(entry => entry.path === "composer.tokenRate")).toHaveLength(2);
  });
});

/**
 * Набор измеряемых версий — объединение принятой поддержки, поддержки, заявленной манифестом кандидата, и
 * версии кандидата. Заявленную версию нельзя пропустить: она либо измерена целиком по сетке «версия ×
 * платформа», либо сбор отказывает. Принятая поддержка при этом не вытесняется манифестом кандидата.
 */
describe("реальная сетка принятых и заявленных версий", () => {
  test("все базовые алиасы и кандидат измерены по трём реальным платформенным источникам", async () => {
    const fixture = await semanticRuntimeFixture(VERSIONS.slice(0,3),VERSIONS[3]);
    try {
      fixture.applyCandidate(fixture.checkout);
      const rootsBefore = measurementRoots();
      // Кандидатская установленная копия — приманка, её код не должен исполняться измерением.
      const decoy = join(fixture.checkout,"node_modules/omp-host-1887/config/all-settings.js");
      writeFileSync(decoy,"throw new Error('candidate-node-modules-decoy');");
      const result = await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000});
      if ("failure" in result) throw new Error(result.failure);
      expect(result.coverage).toHaveLength(12);
      expect(result.drift).toHaveLength(12);
      for (const version of [...fixture.versions,fixture.candidate]) for (const platform of PLATFORMS) {
        const expected = version===fixture.candidate ? 7 : 1;
        expect(result.coverage.find(pair=>pair.version===version&&pair.platform===platform)).toEqual({version,platform,complete:expected,total:expected});
        expect(result.drift.find(pair=>pair.version===version&&pair.platform===platform)).toEqual({version,platform,added:0,removed:0,changed:0});
      }
      expect(result.changedCatalogVariants).toHaveLength(7);
      expect(result.changedCatalogVariants.every(variant=>variant.platforms.join(",")==="win32")).toBe(true);
      expect(validateSemantic(result,policy)).toEqual({ok:true});
      expect(fixture.requests().every(path=>path.startsWith("/@oh-my-pi/pi-")||/^\/pi-(coding-agent|utils)-[0-9.]+\.tgz$/.test(path))).toBe(true);
      expect(measurementRoots()).toEqual(rootsBefore);
    } finally { await fixture.close(); }
  },90_000);

  test("отсутствующая принятая версия и пропущенная платформа отказывают до установки", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const file = join(fixture.checkout,"baseline/supported-hosts.json");
      const requests = fixture.requests();
      writeFileSync(file,JSON.stringify(hostManifest([[fixture.candidate,PLATFORMS]])));
      expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
        .toEqual({failure:`supported-version-missing:${fixture.versions[0]}`});
      writeFileSync(file,JSON.stringify(hostManifest([[fixture.versions[0]!,PLATFORMS],[fixture.candidate,["win32","linux"]]])));
      expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
        .toEqual({failure:`supported-platform-missing:${fixture.candidate}:darwin`});
      expect(fixture.requests()).toEqual(requests);
    } finally { await fixture.close(); }
  },90_000);

  test("поддельный sourceHash снимка кандидата отклонён настоящим drift", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const rootsBefore = measurementRoots();
      const file = join(fixture.checkout,`baseline/${fixture.candidate}-darwin.json`);
      const snapshot = JSON.parse(await Bun.file(file).text());
      snapshot.settings["theme.dark"].sourceHash = "e".repeat(64);
      writeFileSync(file,JSON.stringify(snapshot));
      expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
        .toEqual({failure:`drift-run-failed:${fixture.candidate}-darwin`});
      expect(measurementRoots()).toEqual(rootsBefore);
    } finally { await fixture.close(); }
  },90_000);
});

/** Манифест поддержки в рабочем дереве кандидата — недоверенная граница: разбор строгий и с машинным кодом. */
describe("манифест поддержанных версий читается строго", () => {
  function manifestRoot(manifest: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "semantic-manifest-"));
    mkdirSync(join(root, "baseline"), { recursive: true });
    writeFileSync(join(root, "baseline/supported-hosts.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return root;
  }

  test("читает объявленные версии в порядке манифеста", async () => {
    const root = manifestRoot(hostManifest([["18.8.4", PLATFORMS], ["18.9.0", ["win32"]]]));
    try {
      expect(await claimedVersions(root)).toEqual(["18.8.4", "18.9.0"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("отказывает на дублях, невалидном semver и неизвестной форме", async () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [hostManifest([["18.8.4", PLATFORMS], ["18.8.4", ["linux"]]]), "supported-version-duplicate:18.8.4"],
      [hostManifest([["18.8.4", ["win32", "win32"]]]), "supported-platform-duplicate:18.8.4:win32"],
      [{ schemaVersion: 1, versions: [{ version: "18.8", platforms: ["win32"] }] }, "supported-version-invalid"],
      [{ schemaVersion: 1, versions: [{ version: "18.8.4" }] }, "supported-platforms-invalid:18.8.4"],
      [{ schemaVersion: 1, versions: [{ version: "18.8.4", platforms: [] }] }, "supported-platforms-invalid:18.8.4"],
      [{ schemaVersion: 1, versions: [{ version: "18.8.4", platforms: ["win 32"] }] }, "supported-platform-invalid:18.8.4"],
      [{ schemaVersion: 1, versions: [{ version: "18.8.4", platforms: ["win32"] }] }, "supported-package-invalid:18.8.4"],
      [{ schemaVersion: 1, versions: [] }, "supported-hosts-invalid"],
      [{ schemaVersion: 2, versions: [{ version: "18.8.4", platforms: ["win32"] }] }, "supported-hosts-invalid"],
      [{ versions: [{ version: "18.8.4", platforms: ["win32"] }] }, "supported-hosts-invalid"],
      [{ schemaVersion: 1, versions: [null] }, "supported-hosts-invalid"],
      ["{not-json", "supported-hosts-unreadable"],
    ];
    for (const [manifest, reason] of cases) {
      const root = manifestRoot(manifest);
      try {
        expect(await failureMessage(() => claimedVersions(root))).toBe(reason);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    // Отсутствующий манифест — тоже отказ, а не «нет заявленной поддержки».
    const missing = mkdtempSync(join(tmpdir(), "semantic-manifest-missing-"));
    try {
      expect(await failureMessage(() => claimedVersions(missing))).toBe("supported-hosts-unreadable");
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });
});

describe("реальный потребитель в доверенном корне", () => {
  test("пакет версии нельзя перенаправить на другой алиас или абсолютный путь", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const file = join(fixture.checkout,"baseline/supported-hosts.json");
      const manifest = JSON.parse(await Bun.file(file).text());
      const requests = fixture.requests();
      const marker = join(fixture.root,"selector-executed");
      writeFileSync(join(fixture.checkout,"node_modules/omp-host-1884/config/all-settings.js"),`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)},"executed"); throw new Error("untrusted-selector-executed");`);
      writeFileSync(join(fixture.checkout,"node_modules/omp-host-1887/config/all-settings.js"),`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)},"executed"); throw new Error("untrusted-selector-executed");`);
      for (const packageName of ["omp-host-1884",join(fixture.checkout,"node_modules/omp-host-1887")]) {
        manifest.versions[1].package = packageName;
        writeFileSync(file,JSON.stringify(manifest));
        expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
          .toEqual({failure:`supported-package-invalid:${fixture.candidate}`});
      }
      expect(fixture.requests()).toEqual(requests);
      expect(existsSync(marker)).toBe(false);
    } finally { await fixture.close(); }
  },90_000);

  test("деструктуризация каталога с исполняемым default отклоняется до установки и импорта", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const marker = join(fixture.root,"binding-executed");
      const file = join(fixture.checkout,T);
      const original = await Bun.file(file).text();
      const requests = fixture.requests();
      writeFileSync(file,original.replace("const ruPart1 =",`const {ruPart1 = (() => { Bun.write(${JSON.stringify(marker)},"executed"); return {}; })()} =`));
      expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
        .toEqual({failure:"catalog-module-side-effect:binding"});
      expect(fixture.requests()).toEqual(requests);
      expect(existsSync(marker)).toBe(false);
    } finally { await fixture.close(); }
  },90_000);

  test("посторонний пакет в lock кандидата отклонён, установленный доверенный корень удалён", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const file = join(fixture.checkout,"bun.lock");
      const lock = parseLock(await Bun.file(file).text())!;
      (lock.packages as Record<string,unknown>)["left-pad"] = ["left-pad@1.0.0","",{},"sha512-AAAA"];
      writeFileSync(file,JSON.stringify(lock));
      const rootsBefore = measurementRoots();
      expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
        .toEqual({failure:"lock-mismatch:packages"});
      expect(measurementRoots()).toEqual(rootsBefore);
      expect(fixture.requests().some(path=>path.includes("left-pad"))).toBe(false);
    } finally { await fixture.close(); }
  },90_000);
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogEntries, changedCatalogRequirements, claimedVersions, collectSemanticEvidence, identitiesOf,
  markerPairsOf, markers, measurementChanges, missingMarkers, packageChanges, readCatalog, readCatalogAtCommit,
  translationHash, translationIdentitiesOf, validateSemantic, type CatalogEntry, type SemanticEvidence,
} from "../scripts/maintenance/semantic";
import { parseCatalogJSON } from "../scripts/maintenance/catalog";
import { SNAPSHOT_DIR, SUPPORTED_HOSTS, snapshotPath } from "../scripts/maintenance/paths";
import type { BaselineSnapshot } from "../src/report";
import { fixtureGit } from "./maintenance-runtime-fixture";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";
import { semanticRuntimeFixture } from "./maintenance-runtime-fixture";
import { parseLock } from "../scripts/maintenance/measurement-environment";

const policy = validatePolicy(rawPolicy);
const VERSIONS = ["18.6.1", "18.8.0", "18.8.4", "18.8.7"] as const;
const CANDIDATE = "18.8.9";
const T = "src/translations/ru-catalog.json";
/** Пути, разрешённые политикой и не являющиеся файлами перевода: строки ревью они не требуют. */
const PLAIN_PATHS = ["package.json", SUPPORTED_HOSTS] as const;

const CATALOG = JSON.stringify({locale:"ru",settings:{
  "theme.dark":{variants:[{sourceHash:"e14e408d3c42b38c7ccd2cdf7f9eead7e708b0662589c657f390577406358f19",label:"Тёмная тема",description:"Тема, используемая когда фон терминала тёмный",platforms:["win32"],observedIn:["18.8.7"]}]},
  "spelling.autocomplete":{variants:[{sourceHash:"d84b17e49e184329c94a1eac34ba67d51fcbb4452d4e55c3328a1031c318168f",label:"Автодополнение",descriptionSource:"Suggest words from the {dictionary} as you type",description:"Подсказывать слова из {dictionary} при вводе",options:{system:{label:"Системный",description:"Словарь системы"},apple:{label:"Apple",description:"Словарь macOS"}},platforms:["darwin"],observedIn:["18.8.7"]}]},
}});
const entriesFromJSON = (text: string) => catalogEntries(parseCatalogJSON(text));
const SOURCES = [{version:"18.8.7",platform:"win32",settings:{
  "theme.dark":{sourceHash:entriesFromJSON(CATALOG).find(entry=>entry.path==="theme.dark")!.sourceHash,label:"Dark theme",description:"Theme when background is dark",warning:null,options:null},
  "spelling.autocomplete":{sourceHash:entriesFromJSON(CATALOG).find(entry=>entry.path==="spelling.autocomplete")!.sourceHash,label:"Autocomplete",description:"Suggest words from the {dictionary} as you type",warning:null,options:[{value:"system",label:"System",description:"System dictionary"},{value:"apple",label:"Apple",description:"macOS dictionary"}]},
}}] as unknown as BaselineSnapshot[];

const VERSION_SET = [...VERSIONS, CANDIDATE];
const PLATFORMS = ["win32", "linux", "darwin"] as const;

function evidence(overrides: Partial<SemanticEvidence> = {}): SemanticEvidence {
  const entries = entriesFromJSON(CATALOG);
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
    translationIdentities: translationIdentitiesOf(entries), translationIdentitiesBefore: translationIdentitiesOf(entries),
    markerPairs: markerPairsOf(entries, SOURCES),
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
    review: "independently-confirmed" as const, comparison: "Compared source and Russian", reviewTask: "123:1", evidence: REVIEW_SHA,
  };
}

const REVIEW_BYTES = '{"verdict":"approved","comparison":"Точный перевод сопоставлен с источником"}\n';
const REVIEW_SHA = createHash("sha256").update(REVIEW_BYTES, "utf8").digest("hex");
function reviewProof(entries: readonly CatalogEntry[]) {
  return {
    runId: "123", runAttempt: "1",
    artifacts: new Map(entries.map(entry => [`${entry.path}:${entry.sourceHash}`, { bytes: REVIEW_BYTES }])),
  };
}

describe("разбор реального каталога", () => {
  test("читает строгие JSON variants и сохраняет порядок полей", () => {
    const spelling = entriesFromJSON(CATALOG).find(entry=>entry.path==="spelling.autocomplete")!;
    expect(spelling.options?.apple?.description).toBe("Словарь macOS");
    expect(spelling.platforms).toEqual(["darwin"]);
    expect(spelling.observedIn).toEqual(["18.8.7"]);
    const {path:_path,translationHash:hash,...variant}=spelling;
    expect(hash).toBe(translationHash(variant));
  });
  test("идентичность включает платформу и каждое наблюдение", () => {
    const entries=entriesFromJSON(CATALOG);
    expect(identitiesOf(entries)).toHaveLength(2);
    expect(identitiesOf(entries).some(identity=>identity.endsWith(":darwin:18.8.7"))).toBe(true);
  });
  test("источник обязателен для каждого sourceHash; все поля участвуют", () => {
    const entries=entriesFromJSON(CATALOG);
    expect(()=>markerPairsOf(entries,[])).toThrow("catalog-source-missing");
    const pairs=markerPairsOf(entries,SOURCES);
    expect(pairs.some(pair=>pair.field==="options.apple.description")).toBe(true);
    expect(pairs.find(pair=>pair.path==="spelling.autocomplete"&&pair.field==="description")?.source).toBe("Suggest words from the {dictionary} as you type");
  });
  test("candidate descriptionSource cannot hide source placeholders",()=>{
    const entries=entriesFromJSON(CATALOG).map(entry=>entry.descriptionSource?{...entry,descriptionSource:"forged",description:"forged"}:entry);
    expect(()=>markerPairsOf(entries,SOURCES)).toThrow("catalog-description-source-mismatch");
  });
  test("all effective runtime variants pair against accepted baseline display fields",async()=>{
    const entries=await readCatalog(join(import.meta.dir,".."));
    const supported=JSON.parse(await Bun.file(join(import.meta.dir,"..",SUPPORTED_HOSTS)).text()) as { versions: { version: string; platforms: string[] }[] };
    const snapshots:BaselineSnapshot[]=[];
    for(const row of supported.versions)for(const platform of row.platforms)snapshots.push(await Bun.file(join(import.meta.dir,"..",snapshotPath(row.version,platform))).json() as BaselineSnapshot);
    const pairs=markerPairsOf(entries,snapshots);
    expect(new Set(pairs.map(pair=>`${pair.path}:${pair.sourceHash}`)).size).toBe(entries.length);
    const mismatches=pairs.filter(pair=>markers(pair.source).join("\0")!==markers(pair.ru).join("\0"));
    expect(mismatches.map(pair=>({path:pair.path,sourceHash:pair.sourceHash,field:pair.field}))).toEqual([
      {path:"statusLine.compactThinkingLevel",sourceHash:"d6bcd3d11e4d2ce2eba1cc7b75e5bc9c4589d1fe5bb1a174cfcd37d977ba285e",field:"description"},
      {path:"statusLine.compactThinkingLevel",sourceHash:"e0a244746eda55072d4fe4c3a75f3238565ccf3857190875d8aef6b58d323927",field:"description"},
    ]);
    expect(validateSemantic(evidence({markerPairs:pairs}),policy)).toEqual({ok:true});
    for(const original of mismatches) for(const altered of [
      {...original,translationHash:"f".repeat(64)}, {...original,sourceHash:"f".repeat(64)},
      {...original,field:"warning"}, {...original,path:"other.path"}, {...original,ru:original.ru+" {invented}"},
    ]) expect(validateSemantic(evidence({markerPairs:[altered]}),policy)).toEqual({ok:false,reason:`placeholder-mismatch:${altered.path}:${altered.field}`});
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
    const entries = entriesFromJSON(CATALOG);
    const swapped: CatalogEntry[] = [{ ...entries[0]!, sourceHash: "b".repeat(64), translationHash: "c".repeat(64) }, entries[1]!];
    expect(validateSemantic(evidence({ identities: identitiesOf(swapped) }), policy).ok).toBe(false);
    const verdict = validateSemantic(evidence({ identities: identitiesOf(swapped) }), policy);
    expect(verdict.ok === false && verdict.reason.startsWith("historical-identity-removed")).toBe(true);
  });
  test("same source identity cannot change historical Russian bytes even with review",()=>{
    const entries=entriesFromJSON(CATALOG);
    const changed=entries.map(entry=>({...entry,translationHash:"f".repeat(64)}));
    expect(identitiesOf(changed)).toEqual(identitiesOf(entries));
    expect(validateSemantic(evidence({translationIdentities:translationIdentitiesOf(changed)}),policy)).toEqual({ok:false,reason:`historical-translation-changed:${translationIdentitiesOf(entries)[0]}`});
    const entry=entries[0]!;
    expect(validateSemantic(evidence({changedCatalogVariants:[requirement(entry)],reviewRequired:false}),policy)).toEqual({ok:false,reason:`review-row-missing:${entry.path}:${entry.sourceHash}`});
  });

  test("disabled semantic review accepts new variants without rows but rejects fabricated rows", () => {
    const entry = entriesFromJSON(CATALOG)[0]!;
    const base = evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry)], reviewRows: [],
    });
    expect(validateSemantic(base, policy, undefined, true)).toEqual({ ok: true });
    expect(validateSemantic({ ...base, reviewRows: [reviewRow(entry)] }, policy, undefined, true)).toEqual({ ok: false, reason: "review-rows-unexpected" });
  });

  test("строки ревью по вариантам изменённого файла каталога кандидата принимаются", () => {
    const entries = entriesFromJSON(CATALOG);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: entries.map(entry => requirement(entry)),
      reviewRows: entries.map(entry => reviewRow(entry)),
    }), policy, reviewProof(entries))).toEqual({ ok: true });
  });

  test("пропущенный вариант изменённого файла каталога отклоняется", () => {
    const entries = entriesFromJSON(CATALOG);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: entries.map(entry => requirement(entry)),
      reviewRows: [reviewRow(entries[0]!)],
    }), policy)).toEqual({ ok: false, reason: `review-row-missing:${entries[1]!.path}:${entries[1]!.sourceHash}` });
  });

  test("строка ревью по варианту вне изменённых файлов каталога отклоняется", () => {
    const entries = entriesFromJSON(CATALOG);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entries[0]!)],
      reviewRows: entries.map(entry => reviewRow(entry)),
    }), policy)).toEqual({ ok: false, reason: `review-row-unknown:${entries[1]!.path}:${entries[1]!.sourceHash}` });
  });

  test("дубли строк ревью по одному варианту отклоняются", () => {
    const entries = entriesFromJSON(CATALOG);
    const entry = entries[0]!;
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry)],
      reviewRows: [reviewRow(entry), reviewRow(entry)],
    }), policy)).toEqual({ ok: false, reason: `review-row-duplicate:${entry.path}:${entry.sourceHash}` });
  });

  test("чужой отпечаток перевода в строке ревью отклоняется", () => {
    const entry = entriesFromJSON(CATALOG)[0]!;
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry)],
      reviewRows: [{ ...reviewRow(entry), translationHash: "e".repeat(64) }],
    }), policy)).toEqual({ ok: false, reason: `review-translation-mismatch:${entry.path}:${entry.sourceHash}` });
  });

  test("неточный набор платформ в строке ревью отклоняется", () => {
    const entry = entriesFromJSON(CATALOG)[0]!;
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
        review: "independently-confirmed", comparison: "Compared", reviewTask: "123:1", evidence: "a".repeat(64),
      }],
    }), policy)).toEqual({ ok: false, reason: `review-row-missing:composer.tokenRate:${older}` });
  });

  test("перенесённая версия ревью не принимается", () => {
    const entry = entriesFromJSON(CATALOG)[0]!;
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [requirement(entry)],
      reviewRows: [{ ...reviewRow(entry), reviewedAtVersion: "18.8.7" }],
    }), policy)).toEqual({ ok: false, reason: `review-stale-version:${entry.path}` });
  });

  test("отпечаток ревью, не совпавший с каталогом, отклоняется", () => {
    const entry = entriesFromJSON(CATALOG)[0]!;
    const foreign = "f".repeat(64);
    expect(validateSemantic(evidence({
      changedPaths: [...PLAIN_PATHS, T], reviewRequired: true,
      changedCatalogVariants: [{ ...requirement(entry), sourceHash: foreign }],
      reviewRows: [{ ...reviewRow(entry), sourceHash: foreign }],
    }), policy)).toEqual({ ok: false, reason: `review-hash-mismatch:${entry.path}` });
  });

  test("манифест ревью, не запрошенный стадией, отклоняется", () => {
    const entry = entriesFromJSON(CATALOG)[0]!;
    expect(validateSemantic(evidence({ reviewRows: [reviewRow(entry)] }), policy))
      .toEqual({ ok: false, reason: "review-rows-unexpected" });
  });

  test("изменение файла перевода вне известных файлов каталога отклоняется", () => {
    const changed = "src/translations/ru.ts";
    expect(validateSemantic(evidence({ changedPaths: [...PLAIN_PATHS, changed] }), policy))
      .toEqual({ ok: false, reason: `path-outside-policy:${changed}` });
  });

  test("утраченный маркер отклоняется", () => {
    const pairs = [{ path: "spelling.autocomplete", sourceHash:"a".repeat(64), translationHash:"b".repeat(64), field:"description", source: "from the {dictionary} as you type", ru: "слова при вводе" }];
    expect(validateSemantic(evidence({ markerPairs: pairs }), policy))
      .toEqual({ ok: false, reason: "placeholder-mismatch:spelling.autocomplete:description" });
  });
  test("invented markers and invalid independent proof are rejected",()=>{
    const markerPairs=[{path:"setting",sourceHash:"a".repeat(64),translationHash:"b".repeat(64),field:"options.value.label",source:"Plain",ru:"Текст {invented}"}];
    expect(validateSemantic(evidence({markerPairs}),policy)).toEqual({ok:false,reason:"placeholder-mismatch:setting:options.value.label"});
    const entry=entriesFromJSON(CATALOG)[0]!;
    expect(validateSemantic(evidence({reviewRequired:true,changedCatalogVariants:[requirement(entry)],reviewRows:[{...reviewRow(entry),reviewTask:"unbound"}]}),policy)).toEqual({ok:false,reason:`review-proof-invalid:${entry.path}:${entry.sourceHash}`});
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

describe("trusted review run and content binding", () => {
  const entry = entriesFromJSON(CATALOG)[0]!;
  const key = `${entry.path}:${entry.sourceHash}`;
  const bound = () => evidence({
    reviewRequired: true, changedCatalogVariants: [requirement(entry)], reviewRows: [reviewRow(entry)],
  });
  test("accepts exact UTF-8 reviewer bytes or their independently measured digest", () => {
    expect(validateSemantic(bound(), policy, reviewProof([entry]))).toEqual({ ok: true });
    expect(validateSemantic(bound(), policy, {
      runId: "123", runAttempt: "1", artifacts: new Map([[key, { sha256: REVIEW_SHA }]]),
    })).toEqual({ ok: true });
  });
  test("requires caller-owned proof context for a nonempty semantic delta", () => {
    expect(validateSemantic(bound(), policy)).toEqual({ ok: false, reason: "review-context-missing" });
  });
  test("rejects a different run or rerun attempt even when both are well formed", () => {
    for (const [runId, runAttempt] of [["124", "1"], ["123", "2"]]) {
      expect(validateSemantic(bound(), policy, { ...reviewProof([entry]), runId: runId!, runAttempt: runAttempt! }))
        .toEqual({ ok: false, reason: `review-task-mismatch:${key}` });
    }
  });
  test("rejects malformed trusted run identity", () => {
    for (const identity of [{ runId: "run-123", runAttempt: "1" }, { runId: "123", runAttempt: "" }]) {
      expect(validateSemantic(bound(), policy, { ...reviewProof([entry]), ...identity }))
        .toEqual({ ok: false, reason: "review-context-invalid" });
    }
  });
  test("rejects missing artifacts rather than trusting the row's own evidence", () => {
    expect(validateSemantic(bound(), policy, reviewProof([])))
      .toEqual({ ok: false, reason: `review-artifact-missing:${key}` });
    const otherSource = { ...entry, sourceHash: "f".repeat(64) };
    expect(validateSemantic(bound(), policy, reviewProof([otherSource])))
      .toEqual({ ok: false, reason: `review-artifact-missing:${key}` });
    expect(validateSemantic(bound(), policy, reviewProof([{ ...entry, path: "other.path" }])))
      .toEqual({ ok: false, reason: `review-artifact-missing:${key}` });
  });
  test("rejects byte tampering, digest tampering and a conflicting supplied byte digest", () => {
    for (const artifact of [
      { bytes: REVIEW_BYTES.trimEnd() },
      { bytes: REVIEW_BYTES.replace("approved", "rejected") },
      { sha256: "f".repeat(64) },
      { bytes: REVIEW_BYTES, sha256: "f".repeat(64) },
    ]) {
      expect(validateSemantic(bound(), policy, { ...reviewProof([]), artifacts: new Map([[key, artifact]]) }))
        .toEqual({ ok: false, reason: `review-evidence-mismatch:${key}` });
    }
    const tampered = bound();
    expect(validateSemantic({ ...tampered, reviewRows: [{ ...reviewRow(entry), evidence: "f".repeat(64) }] }, policy, reviewProof([entry])))
      .toEqual({ ok: false, reason: `review-evidence-mismatch:${key}` });
  });
  test("unchanged catalogs need no review context", () => {
    expect(validateSemantic(evidence(), policy)).toEqual({ ok: true });
  });
});

const REPO_ROOT = join(import.meta.dir, "..");
const CATALOG_DIR = "src/translations";

function catalogEntry(path: string, hashChar: string, label = "Метка"): string {
  return JSON.stringify({path,sourceHash:hashChar.repeat(64),label,platforms:["win32","linux","darwin"],observedIn:["18.8.7"]});
}
function catalogSource(entries: readonly string[]): string {
  const settings: Record<string,{variants:unknown[]}>={};
  for(const text of entries){const {path,...variant}=JSON.parse(text);(settings[path]??={variants:[]}).variants.push(variant);}
  return JSON.stringify({locale:"ru",settings});
}
function writeCatalog(dir: string, text = catalogSource([])): void {
  mkdirSync(join(dir,CATALOG_DIR),{recursive:true});
  writeFileSync(join(dir,T),text);
}
function commitBase(root:string):string {
  fixtureGit(root,["init","-q"]);fixtureGit(root,["add","-A"]);fixtureGit(root,["commit","-q","-m","base"]);
  return fixtureGit(root,["rev-parse","HEAD"]);
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
      writeCatalog(root);
      rmSync(join(root,T));
      expect(await failureMessage(() => readCatalog(root))).toBe("catalog-file-missing:ru-catalog.json");
      expect(await failureMessage(() => readCatalog(join(root,"absent")))).toBe("catalog-file-missing:ru-catalog.json");
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
      writeFileSync(join(root,"README.md"),"base");
      expect(git("add","-A").exitCode).toBe(0);
      expect(git("commit","-m","partial").exitCode).toBe(0);
      expect(()=>readCatalogAtCommit(root,"HEAD")).toThrow("catalog-blob-missing");
      writeCatalog(root,catalogSource([catalogEntry("part.one","a"),catalogEntry("part.two","b")]));
      expect(git("add","-A").exitCode).toBe(0);
      expect(git("commit","-m","full").exitCode).toBe(0);
      expect(readCatalogAtCommit(root,"HEAD").map(entry=>entry.path)).toEqual(["part.one","part.two"]);
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
      const before = entriesFromJSON(text).find(entry=>entry.path==="theme.dark"&&entry.platforms.includes("win32"))!;
      writeFileSync(file,text.replace("Перевод theme.dark","Переписанный перевод"));
      const requests = fixture.requests();
      expect(await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000}))
        .toEqual({failure:`historical-translation-changed:${translationIdentitiesOf([before])[0]}`});
      const requirements=await changedCatalogRequirements(fixture.checkout,fixture.base,[...fixture.versions,fixture.candidate]);
      expect(requirements).toEqual({failure:`historical-translation-changed:${translationIdentitiesOf([before])[0]}`});
      expect(fixture.requests()).toEqual(requests);
    } finally { await fixture.close(); }
  },90_000);

  test("требования строк ревью выводятся из базовых снимков поддерживаемых версий", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-requirements-"));
    try {
      writeCatalog(root,catalogSource([catalogEntry("old.setting","b")]));
      const base=commitBase(root);
      writeCatalog(root,catalogSource([catalogEntry("old.setting","b"),catalogEntry("theme.dark","a","Тёмная")]));
      const snapshot = (settings: Readonly<Record<string, string>>): string => JSON.stringify({
        version: "18.8.7", platform: "win32",
        settings: Object.fromEntries(Object.entries(settings).map(([path, hash]) => [path, { sourceHash: hash }])),
      });
      mkdirSync(join(root, SNAPSHOT_DIR), { recursive: true });
      for (const platform of ["win32", "linux", "darwin"]) {
        writeFileSync(join(root, snapshotPath("18.8.7", platform)), snapshot({ "theme.dark": "a".repeat(64) }));
      }
      const collected = await changedCatalogRequirements(root,base,["18.8.7"]);
      if ("failure" in collected) throw new Error(collected.failure);
      const variant = collected.variants[0]!;
      expect(variant.path).toBe("theme.dark");
      expect(variant.platforms).toEqual(["darwin", "linux", "win32"]);
      expect(variant.translationHash).toBe(entriesFromJSON(catalogSource([catalogEntry("theme.dark","a","Тёмная")]))[0]!.translationHash);
      writeFileSync(join(root,snapshotPath("18.8.7","darwin")),snapshot({}));
      expect(await changedCatalogRequirements(root,base,["18.8.7"])).toEqual({failure:`catalog-platform-mismatch:theme.dark:${"a".repeat(64)}`});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("unchanged data and added observations need no review; platform extension does",async()=>{
    const root=mkdtempSync(join(tmpdir(),"semantic-platform-extension-"));
    const variant={sourceHash:"a".repeat(64),label:"Метка",platforms:["win32"],observedIn:["18.8.7"]};
    const pack=(platforms:string[],observedIn=["18.8.7"])=>JSON.stringify({locale:"ru",settings:{setting:{variants:[{...variant,platforms,observedIn}]}}});
    try {
      writeCatalog(root,pack(["win32"]));mkdirSync(join(root,SNAPSHOT_DIR),{recursive:true});
      for(const platform of PLATFORMS) writeFileSync(join(root,snapshotPath("18.8.7",platform)),JSON.stringify({settings:platform==="win32"?{setting:{sourceHash:variant.sourceHash}}:{}}));
      const base=commitBase(root);
      expect(await changedCatalogRequirements(root,base,["18.8.7"])).toEqual({variants:[]});
      writeCatalog(root,pack(["win32"],["18.8.7","18.8.9"]));
      expect(await changedCatalogRequirements(root,base,["18.8.7"])).toEqual({variants:[]});
      writeCatalog(root,pack(["win32","linux"]));
      writeFileSync(join(root,snapshotPath("18.8.7","linux")),JSON.stringify({settings:{setting:{sourceHash:variant.sourceHash}}}));
      const extended=await changedCatalogRequirements(root,base,["18.8.7"]);
      if("failure" in extended)throw new Error(extended.failure);
      expect(extended.variants).toEqual([{path:"setting",sourceHash:variant.sourceHash,translationHash:translationHash(variant),platforms:["linux","win32"]}]);
      writeCatalog(root,pack(["win32"],["18.8.9"]));
      const removed=await changedCatalogRequirements(root,base,["18.8.7"]);
      expect("failure" in removed&&removed.failure.startsWith("historical-identity-removed:")).toBe(true);
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  test("переписанный измерительный код обесценивает доказательство до запуска скриптов", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-measurement-"));
    try {
      const git = (...args: readonly string[]) => Bun.spawnSync(
        ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(git("init").exitCode).toBe(0);
      writeCatalog(root);
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
      writeFileSync(join(root,T),catalogSource([catalogEntry("theme.dark","a")]));
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
  }, 30000);

  test("вариант без следа в базовых снимках не подтверждается платформенно", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-unbaselined-"));
    try {
      writeCatalog(root,catalogSource([catalogEntry("old.setting","b")]));
      const base=commitBase(root);
      writeCatalog(root,catalogSource([catalogEntry("old.setting","b"),catalogEntry("theme.dark","a","Тёмная")]));
      mkdirSync(join(root, SNAPSHOT_DIR), { recursive: true });
      for (const platform of ["win32", "linux", "darwin"]) {
        writeFileSync(join(root, snapshotPath("18.8.7", platform)), JSON.stringify({ settings: {} }));
      }
      const collected = await changedCatalogRequirements(root,base,["18.8.7"]);
      expect(collected).toEqual({ failure: `catalog-variant-without-baseline:theme.dark:${"a".repeat(64)}` });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("разные sourceHash сосуществуют; перекрывающаяся платформа отклоняется",async()=>{
    const root=mkdtempSync(join(tmpdir(),"semantic-variants-"));
    try {
      writeCatalog(root,catalogSource([catalogEntry("theme.dark","a"),catalogEntry("theme.dark","b")]));
      expect(await readCatalog(root)).toHaveLength(2);
      writeCatalog(root,catalogSource([catalogEntry("theme.dark","a"),catalogEntry("theme.dark","a")]));
      expect(await failureMessage(()=>readCatalog(root))).toBe("duplicate-source-variant:theme.dark:win32");
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  test("полный эффективный каталог не теряет исторические пути и не дублирует identity",async()=>{
    const entries=await readCatalog(REPO_ROOT);
    expect(entries.length).toBeGreaterThanOrEqual(424);
    expect(entries.reduce((count,entry)=>count+entry.platforms.length,0)).toBeGreaterThanOrEqual(1269);
    expect(new Set(entries.map(entry=>entry.path)).size).toBeGreaterThanOrEqual(410);
    expect(new Set(entries.map(entry=>`${entry.path}:${entry.sourceHash}`)).size).toBe(entries.length);
    expect(entries.every(entry=>entry.platforms.length>0)).toBe(true);
    expect(entries.filter(entry=>entry.path==="title.icons").length).toBeGreaterThanOrEqual(3);
    expect(entries.filter(entry=>entry.path==="spelling.autocomplete").length).toBeGreaterThanOrEqual(2);
    expect(entries.filter(entry=>entry.path==="tools.xdev").length).toBeGreaterThanOrEqual(2);
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
      expect(result.changedCatalogVariants).toHaveLength(18);
      for(const platform of PLATFORMS) expect(result.changedCatalogVariants.filter(variant=>variant.platforms.join(",")===platform)).toHaveLength(6);
      expect(result.reviewRequired).toBe(true);
      expect(validateSemantic(result,policy)).toEqual({ok:false,reason:`review-row-missing:${result.changedCatalogVariants[0]!.path}:${result.changedCatalogVariants[0]!.sourceHash}`});
      const reviewRows=result.changedCatalogVariants.map(variant=>({...variant,reviewedAtVersion:fixture.candidate,review:"independently-confirmed" as const,comparison:"Compared independently",reviewTask:"123:1",evidence:REVIEW_SHA}));
      const artifacts = new Map(result.changedCatalogVariants.map(variant => [`${variant.path}:${variant.sourceHash}`, { bytes: REVIEW_BYTES }]));
      expect(validateSemantic({...result,reviewRows},policy,{runId:"123",runAttempt:"1",artifacts})).toEqual({ok:true});
      expect(fixture.requests().every(path=>path.startsWith("/@oh-my-pi/pi-")||/^\/pi-(coding-agent|utils)-[0-9.]+\.tgz$/.test(path))).toBe(true);
      expect(measurementRoots()).toEqual(rootsBefore);
    } finally { await fixture.close(); }
  },90_000);

  test("отсутствующая принятая версия и пропущенная платформа отказывают до установки", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const file = join(fixture.checkout,SUPPORTED_HOSTS);
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
      const file = join(fixture.checkout,snapshotPath(fixture.candidate,"darwin"));
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
    mkdirSync(join(root, SNAPSHOT_DIR), { recursive: true });
    writeFileSync(join(root, SUPPORTED_HOSTS),
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
      const file = join(fixture.checkout,SUPPORTED_HOSTS);
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

  test("исполняемый текст вместо JSON отклоняется до установки и импорта", async () => {
    const fixture = await semanticRuntimeFixture();
    try {
      fixture.applyCandidate(fixture.checkout);
      const marker = join(fixture.root,"binding-executed");
      const file = join(fixture.checkout,T);
      const requests = fixture.requests();
      writeFileSync(file,`export const ru = (()=>{Bun.write(${JSON.stringify(marker)},"executed");return {};})();`);
      const result=await collectSemanticEvidence(fixture.checkout,fixture.base,fixture.candidate,fixture.versions,[T],undefined,{registry:fixture.registry,deadlineMs:30_000});
      expect("failure" in result).toBe(true);
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

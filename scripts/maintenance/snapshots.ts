import { computeSourceHash } from "../../src/source";
import type { BaselineSnapshot } from "../../src/report";
import { asRecord } from "./json";
import { stableVersion } from "./actions-bundle";
import { SNAPSHOT_PLATFORMS } from "./paths";

/**
 * Проверка снимка метаданных хоста.
 *
 * Снимок — граница данных: и данные кандидата, и коммит базы проходят одну и ту же проверку идентичности и
 * пересчёта `sourceHash`, поэтому «снимок» нельзя выдать за другую версию или платформу и нельзя подменить
 * источник, не изменив хэш. Модуль отдельный, потому что его читают и подготовка кандидата, и генерация
 * пользовательских документов: общий импорт между этими модулями замкнул бы цикл.
 */
const platforms = SNAPSHOT_PLATFORMS;

export function snapshotValue(value: unknown, version?: string, platform?: string): BaselineSnapshot {
  const snapshot = asRecord(value);
  if (!snapshot || Object.keys(snapshot).sort().join(",") !== "platform,settings,version" || typeof snapshot.version !== "string" || !stableVersion.test(snapshot.version) || !platforms.includes(snapshot.platform as typeof platforms[number]) || (version && snapshot.version !== version) || (platform && snapshot.platform !== platform)) throw new Error("snapshot-identity-invalid");
  const settings = asRecord(snapshot.settings);
  if (!settings || !Object.keys(settings).length || Object.keys(settings).length > 10000) throw new Error("snapshot-settings-invalid");
  for (const [path, raw] of Object.entries(settings)) {
    const source = asRecord(raw);
    if (!path || !source || Object.keys(source).sort().join(",") !== "description,group,label,options,sourceHash,tab,warning" || typeof source.tab !== "string" || (source.group !== null && typeof source.group !== "string") || typeof source.label !== "string" || typeof source.description !== "string" || (source.warning !== null && typeof source.warning !== "string") || !(source.options === null || source.options === "runtime" || Array.isArray(source.options))) throw new Error("snapshot-source-invalid");
    if (Array.isArray(source.options)) {
      const values = new Set<string>();
      for (const rawOption of source.options) {
        const option = asRecord(rawOption);
        if (!option || Object.keys(option).sort().join(",") !== "description,label,value" || typeof option.value !== "string" || typeof option.label !== "string" || (option.description !== null && typeof option.description !== "string") || values.has(option.value)) throw new Error("snapshot-option-invalid");
        values.add(option.value);
      }
    }
    const { sourceHash, ...metadata } = source;
    if (sourceHash !== computeSourceHash(metadata as unknown as BaselineSnapshot["settings"][string])) throw new Error("snapshot-source-hash-mismatch");
  }
  return snapshot as unknown as BaselineSnapshot;
}

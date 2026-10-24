import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LocalePack, SettingTranslationFields, SourceVariant } from "../../src/translations/types";
import { asRecord, parseStrictJSON } from "./json";

export const CATALOG_PATH = "src/translations/ru-catalog.json";
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLATFORMS: Readonly<Record<string, true>> = { win32: true, darwin: true, linux: true };
const FIELDS: Readonly<Record<string, true>> = { sourceHash: true, label: true, description: true, descriptionSource: true, warning: true, options: true, platforms: true, observedIn: true };

/** The shipped hash is insertion-order-sensitive; provenance is not display metadata. */
export function translationFieldsHash(variant: SettingTranslationFields | SourceVariant): string {
  const { sourceHash: _sourceHash, platforms: _platforms, observedIn: _observedIn, ...fields } = variant as SourceVariant;
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function strings(value: unknown, valid: (value: string) => boolean, reason: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || !valid(item)) || new Set(value).size !== value.length) throw new Error(reason);
}

/** Parse candidate data only, preserving JSON/JavaScript property order for historical hashes. */
export function parseCatalogJSON(text: string): LocalePack {
  const pack = asRecord(parseStrictJSON(text));
  if (!pack || Object.keys(pack).sort().join(",") !== "locale,settings" || pack.locale !== "ru") throw new Error("malformed-catalog");
  const settings = asRecord(pack.settings);
  if (!settings) throw new Error("malformed-catalog-settings");
  for (const [path, rawSetting] of Object.entries(settings)) {
    if (!path.trim()) throw new Error("invalid-catalog-path");
    const setting = asRecord(rawSetting);
    if (!setting || Object.keys(setting).join(",") !== "variants" || !Array.isArray(setting.variants) || setting.variants.length === 0) throw new Error(`malformed-catalog-entry:${path}`);
    const seen = new Set<string>();
    for (const raw of setting.variants) {
      const variant = asRecord(raw);
      if (!variant || Object.keys(variant).some(key => !Object.hasOwn(FIELDS, key))) throw new Error(`malformed-catalog-entry:${path}`);
      if (typeof variant.sourceHash !== "string" || !HASH.test(variant.sourceHash)) throw new Error(`invalid-source-hash:${path}`);
      for (const field of ["label", "description", "descriptionSource", "warning"]) {
        if (Object.hasOwn(variant, field) && typeof variant[field] !== "string") throw new Error(`invalid-catalog-field:${path}:${field}`);
      }
      if (variant.options !== undefined) {
        const options = asRecord(variant.options);
        if (!options) throw new Error(`invalid-catalog-options:${path}`);
        for (const [value, rawOption] of Object.entries(options)) {
          const option = asRecord(rawOption);
          if (!option || Object.entries(option).some(([key, text]) => !["label", "description"].includes(key) || typeof text !== "string")) throw new Error(`invalid-catalog-option:${path}:${value}`);
        }
      }
      strings(variant.platforms, platform => Object.hasOwn(PLATFORMS, platform), `invalid-catalog-platforms:${path}`);
      strings(variant.observedIn, version => VERSION.test(version), `invalid-catalog-versions:${path}`);
      for (const platform of variant.platforms as string[]) {
        const key = `${variant.sourceHash}:${platform}`;
        if (seen.has(key)) throw new Error(`duplicate-source-variant:${path}:${platform}`);
        seen.add(key);
      }
    }
  }
  return pack as unknown as LocalePack;
}

export async function readCatalogJSON(worktree: string): Promise<LocalePack> {
  const file = Bun.file(join(worktree, CATALOG_PATH));
  if (!await file.exists()) throw new Error("catalog-file-missing:ru-catalog.json");
  return parseCatalogJSON(await file.text());
}

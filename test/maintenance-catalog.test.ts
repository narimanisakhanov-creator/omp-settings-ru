import { describe, expect, test } from "bun:test";
import { parseCatalogJSON, translationFieldsHash } from "../scripts/maintenance/catalog";

const hash = "a".repeat(64);
const variant = { sourceHash: hash, label: "Метка", description: "Описание", platforms: ["linux" as const], observedIn: ["18.8.7"] };
const pack = (value: unknown) => JSON.stringify({ locale: "ru", settings: { setting: { variants: [value] } } });

describe("strict JSON catalog", () => {
  test("preserves display field order and excludes provenance from translation hashes", () => {
    const parsed = parseCatalogJSON(pack(variant));
    expect(parsed.settings.setting!.variants[0]).toEqual(variant);
    expect(translationFieldsHash(parsed.settings.setting!.variants[0]!)).toBe(translationFieldsHash({ ...variant, sourceHash: "b".repeat(64), platforms: ["darwin"], observedIn: ["18.8.9"] }));
    expect(translationFieldsHash(variant)).not.toBe(translationFieldsHash({ sourceHash: hash, description: "Описание", label: "Метка" }));
  });
  test("rejects duplicate escaped keys at every depth", () => {
    expect(() => parseCatalogJSON('{"locale":"ru","loc\\u0061le":"ru","settings":{}}')).toThrow();
    expect(() => parseCatalogJSON(pack(variant).replace('"label":"Метка"', '"label":"Метка","label":"Иное"'))).toThrow();
  });
  test("rejects malformed fields, platforms, versions and options", () => {
    for (const value of [
      { ...variant, sourceHash: "bad" }, { ...variant, label: null }, { ...variant, extra: "no" },
      { ...variant, platforms: [] }, { ...variant, platforms: ["linux", "linux"] },
      { ...variant, platforms: ["freebsd"] }, { ...variant, observedIn: ["18.8.7-beta"] },
      { ...variant, observedIn: [] }, { ...variant, options: { value: { label: 1 } } },
      { ...variant, options: { value: { value: "changed" } } },
    ]) expect(() => parseCatalogJSON(pack(value))).toThrow();
  });
  test("rejects overlapping source/platform identities even when translations match", () => {
    expect(() => parseCatalogJSON(JSON.stringify({ locale: "ru", settings: { setting: { variants: [variant, variant] } } }))).toThrow("duplicate-source-variant");
  });
  test("never accepts executable TypeScript as a catalog", () => {
    expect(() => parseCatalogJSON('export const ru = dangerous();')).toThrow();
  });
});

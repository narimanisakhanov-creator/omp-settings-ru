import { expect, test } from "bun:test";
import { applyTranslations } from "../src/apply-translations";
import { ru } from "../src/translations/ru";
import { resolveVariant } from "../src/translations/resolve";
import type { HostMetadata, HostUiMetadata } from "../src/host-types";

async function registry(version: string, platform = "win32"): Promise<HostMetadata> {
  const baseline = await Bun.file(`baseline/${version}-${platform}.json`).json();
  const schema: HostMetadata["schema"] = {};
  for (const [path, value] of Object.entries(baseline.settings)) {
    const source = value as HostUiMetadata & {sourceHash?: string};
    const ui = { ...source };
    delete ui.sourceHash;
    if (ui.group === null) delete ui.group;
    if (ui.warning === null) delete ui.warning;
    if (ui.options === null) delete ui.options;
    if (Array.isArray(ui.options)) for (const option of ui.options) if (option.description === null) delete option.description;
    schema[path] = {type: "string", default: "", ui};
  }
  return {version, platform, schema};
}
const historicalPaths = ["composer.tokenRate", "statusLine.compactThinkingLevel", "codexResets.salvageHorizonHours", "claudeResets.keepCredits", "claudeResets.salvageHorizonHours", "advisor.immuneTurns", "computer.display", "computer.maxWidth", "computer.maxHeight", "browser.tern"];
const additions = ["expandThinkingBlocks", "title.icons", "tui.autoGraph", "tui.renderSvg", "providers.muse-code.storeResponses", "title.generator"];

for (const version of ["18.6.1", "18.8.0"]) {
  test(`real ${version} registry selects its reviewed variant and restores`, async () => {
    const host = await registry(version);
    const originals = Object.fromEntries(Object.entries(host.schema).map(([path, definition]) => [path, Object.getOwnPropertyDescriptors(definition!.ui!)]));
    const selected = historicalPaths.map(path => {
      const entry = ru.settings[path]!;
      const variant = entry.variants.find(variant => variant.observedIn.includes(version))!;
      expect(resolveVariant(entry, host.schema[path]!.ui!, host.platform, new WeakMap())).toBe(variant);
      return {path, variant};
    });
    const result = applyTranslations(host, ru);
    expect(result.status).toBe("applied");
    for (const {path, variant} of selected) expect(host.schema[path]!.ui!.description).toBe(variant.description!);
    for (const path of additions) {
      if (version === "18.6.1") expect(host.schema[path]).toBeUndefined();
      else expect(host.schema[path]!.ui!.label).toBe(ru.settings[path]!.variants[0]!.label!);
    }
    if (result.status !== "applied") throw new Error("expected applied registry");
    expect(result.restore()).toEqual([]);
    for (const [path, descriptors] of Object.entries(originals)) expect(Object.getOwnPropertyDescriptors(host.schema[path]!.ui!)).toEqual(descriptors);
  });
}
test("future compatible registry translates known source but never changed or unknown source", async () => {
  const host = await registry("18.8.0");
  host.version = "99.0.0";
  const known = host.schema.autoResume!.ui!;
  const knownVariant = resolveVariant(ru.settings.autoResume!, known, host.platform, new WeakMap())!;
  const changed = host.schema["computer.display"]!.ui!;
  changed.description = "New monitor contract";
  const changedOriginal = Object.getOwnPropertyDescriptors(changed);
  host.schema.future = {type: "boolean", default: false, ui: {tab: "general", label: "Future", description: "New setting"}};
  const unknownOriginal = Object.getOwnPropertyDescriptors(host.schema.future.ui!);
  const result = applyTranslations(host, ru);
  expect(result.status).toBe("applied");
  expect(known.label).toBe(knownVariant.label!);
  expect(Object.getOwnPropertyDescriptors(changed)).toEqual(changedOriginal);
  expect(Object.getOwnPropertyDescriptors(host.schema.future.ui!)).toEqual(unknownOriginal);
  if (result.status === "applied") expect(result.restore()).toEqual([]);
});
test("malformed real registry refuses all mutation", async () => {
  const host = await registry("18.8.0");
  host.schema["computer.display"]!.ui!.options = [{value: "x", label: "A"}, {value: "x", label: "B"}];
  const before = host.schema.autoResume!.ui!.label;
  const result = applyTranslations(host, ru);
  expect(result).toEqual({status: "skipped", reason: "invalid-ui-options"});
  expect(host.schema.autoResume!.ui!.label).toBe(before);
});
test("18.8.4 selects its distinct title variant and restores actual original descriptors", async () => {
  const host = await registry("18.8.4");
  const ui = host.schema["title.icons"]!.ui!;
  const before = Object.getOwnPropertyDescriptors(ui);
  const values = Array.isArray(ui.options) ? ui.options.map(option => option.value) : [];
  const entry = ru.settings["title.icons"]!;
  const variant = entry.variants.find(variant => variant.observedIn.includes("18.8.4"));
  expect(variant).toBeDefined();
  expect(resolveVariant(entry, ui, host.platform, new WeakMap())).toBe(variant!);
  const result = applyTranslations(host, ru);
  expect(result.status).toBe("applied");
  expect(ui.description).toBe(variant!.description!);
  expect(Array.isArray(ui.options) ? ui.options.map(option => option.value) : []).toEqual(values);
  if (result.status !== "applied") throw new Error("expected actual candidate registry");
  expect(result.restore()).toEqual([]);
  expect(Object.getOwnPropertyDescriptors(ui)).toEqual(before);
});

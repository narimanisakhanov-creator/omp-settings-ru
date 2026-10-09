import { describe, expect, test } from "bun:test";
import type { HostMetadata } from "../src/host-types";
import type { LocalePack, SettingTranslationFields } from "../src/translations/types";

import { applyTranslations } from "../src/apply-translations";
import { computeSourceHash, normalizeSource } from "../src/source";
function setting(fields: SettingTranslationFields) {
  return { variants: [{ ...fields, platforms: ["win32", "darwin", "linux"] as const, observedIn: [] }] };
}
function fixture() {
  const host: HostMetadata = { version: "18.8.0", platform: "win32", schema: { "test.mode": { type: "string", default: "off", values: ["off", "on"], ui: { tab: "general", label: "Mode", description: "Choose mode", options: [{ value: "off", label: "Off" }, { value: "on", label: "On" }] } } } };
  const ui = host.schema["test.mode"]!.ui!;
  const pack: LocalePack = { locale: "ru", settings: { "test.mode": setting({ sourceHash: computeSourceHash(normalizeSource(ui)), label: "Режим", description: "Выберите режим", options: { off: { label: "Выключено" }, on: { label: "Включено" } } }) } };
  return { host, pack, ui };
}

describe("translation lifecycle", () => {
  test("round trip keeps enum values and the shared option source unchanged", () => {
    const { host, pack, ui } = fixture();
    const options = ui.options;
    const before = Object.getOwnPropertyDescriptors(ui);
    const result = applyTranslations(host, pack);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(ui.label).toBe("Режим");
    expect(ui.options).not.toBe(options);
    expect(Array.isArray(options) && options[0]!.label).toBe("Off");
    expect(Array.isArray(ui.options) && ui.options.map(option => option.value)).toEqual(["off", "on"]);
    expect(host.schema["test.mode"]!.values).toEqual(["off", "on"]);
    expect(result.restore()).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(ui)).toEqual(before);
    expect(result.restore()).toEqual([]);
  });
  test("unwritable fields refuse atomically before any label changes", () => {
    const { host, pack, ui } = fixture();
    Object.defineProperty(ui, "description", { writable: false, configurable: false });
    expect(applyTranslations(host, pack).status).toBe("skipped");
    expect(ui.label).toBe("Mode");
    expect(ui.description).toBe("Choose mode");
  });
  test("later foreign labels survive English restoration", () => {
    const { host, pack, ui } = fixture();
    const result = applyTranslations(host, pack);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    ui.label = "Foreign label";
    result.restore();
    expect(ui.label).toBe("Foreign label");
    expect(ui.description).toBe("Choose mode");
  });
  test("changed known sources and unknown settings stay English", () => {
    const { host, pack, ui } = fixture();
    ui.description = "New behavior";
    host.schema.unknown = { type: "boolean", default: false, ui: { tab: "general", label: "Unknown", description: "New" } };
    const result = applyTranslations(host, pack);
    expect(ui.label).toBe("Mode");
    expect(host.schema.unknown.ui!.label).toBe("Unknown");
    if (result.status === "applied") result.restore();
  });
  test("structurally compatible unreviewed versions preserve round-trip ownership", () => {
    for (const version of ["18.8.1", "18.8.0-beta", "19.0.0"]) {
      const { host, pack, ui } = fixture();
      host.version = version;
      const result = applyTranslations(host, pack);
      expect(result.status).toBe("applied");
      expect(ui.label).toBe("Режим");
      if (result.status === "applied") expect(result.restore()).toEqual([]);
      expect(ui.label).toBe("Mode");
    }
  });
  test("reapplication shares restoration ownership instead of nesting translations", () => {
    const { host, pack, ui } = fixture();
    const first = applyTranslations(host, pack);
    const second = applyTranslations(host, pack);
    expect(second).toBe(first);
    if (second.status !== "applied") throw new Error("Expected application");
    second.restore();
    expect(ui.label).toBe("Mode");
    const third = applyTranslations(host, pack);
    expect(third.status).toBe("applied");
    if (third.status === "applied") third.restore();
  });
  test("foreign descriptor edits survive even with the localized value unchanged", () => {
    const { host, pack, ui } = fixture();
    const result = applyTranslations(host, pack);
    if (result.status !== "applied") throw new Error("Expected application");
    Object.defineProperty(ui, "label", { value: "Режим", enumerable: false });
    const foreign = Object.getOwnPropertyDescriptor(ui, "label");
    result.restore();
    expect(Object.getOwnPropertyDescriptor(ui, "label")).toEqual(foreign);
    expect(ui.description).toBe("Choose mode");
  });
  test("foreign option fields and array descriptors keep the display copy alive", () => {
    const { host, pack, ui } = fixture();
    const original = ui.options;
    const result = applyTranslations(host, pack);
    if (result.status !== "applied" || !Array.isArray(ui.options)) throw new Error("Expected options");
    const copy = ui.options;
    Object.defineProperty(copy[0]!, "label", { value: "Выключено", enumerable: false });
    Object.defineProperty(copy, "foreign", { value: 1 });
    result.restore();
    expect(ui.options).toBe(copy);
    expect(copy[0]!.label).toBe("Выключено");
    expect(Object.getOwnPropertyDescriptor(copy[0]!, "label")!.enumerable).toBe(false);
    expect(Array.isArray(original) && original[0]!.label).toBe("Off");
    expect(copy[1]!.label).toBe("On");
  });
  test("live description getters retain key hints and fall back after wording drift", () => {
    const { host, pack, ui } = fixture();
    let key = "Ctrl+A";
    let changed = false;
    const getter = () => changed ? "Changed wording" : `Press ${key} to choose`;
    Object.defineProperty(ui, "description", { get: getter, configurable: true, enumerable: true });
    const template = "Press {key} to choose";
    const dynamicPack: LocalePack = { ...pack, settings: { "test.mode": setting({
      ...pack.settings["test.mode"]!.variants[0]!, sourceHash: computeSourceHash(normalizeSource(ui, template)),
      descriptionSource: template, description: "Нажмите {key} для выбора",
    }) } };
    const result = applyTranslations(host, dynamicPack);
    if (result.status !== "applied") throw new Error("Expected application");
    expect(ui.description).toBe("Нажмите Ctrl+A для выбора");
    key = "Alt+B";
    expect(ui.description).toBe("Нажмите Alt+B для выбора");
    changed = true;
    expect(ui.description).toBe("Changed wording");
    result.restore();
    expect(Object.getOwnPropertyDescriptor(ui, "description")!.get).toBe(getter);
  });
  test("unsafe setter and inherited fields refuse without invoking writes", () => {
    for (const kind of ["setter", "inherited", "getter"]) {
      const { host, pack, ui } = fixture();
      let writes = 0;
      if (kind === "inherited") {
        Reflect.deleteProperty(ui, "label");
        Object.setPrototypeOf(ui, { label: "Mode" });
      } else if (kind === "setter") {
        Object.defineProperty(ui, "label", { get: () => "Mode", set: () => { writes++; }, configurable: true });
      } else {
        Object.defineProperty(ui, "description", { get: () => "Choose mode", configurable: true });
      }
      expect(applyTranslations(host, pack).status).toBe("skipped");
      expect(writes).toBe(0);
      expect(ui.label).toBe("Mode");
    }
  });
  test("identical shared targets deduplicate while conflicting translations refuse atomically", () => {
    for (const conflicting of [false, true]) {
      const { host, pack, ui } = fixture();
      host.schema.alias = host.schema["test.mode"];
      const aliasPack: LocalePack = { ...pack, settings: { ...pack.settings,
        alias: setting({ ...pack.settings["test.mode"]!.variants[0]!, label: conflicting ? "Другой" : "Режим" }),
      } };
      const before = Object.getOwnPropertyDescriptors(ui);
      const options = ui.options;
      const result = applyTranslations(host, aliasPack);
      expect(result.status).toBe(conflicting ? "skipped" : "applied");
      if (result.status === "applied") {
        expect(host.schema.alias!.ui!.label).toBe("Режим");
        expect(ui.description).toBe("Выберите режим");
        expect(Array.isArray(options) && options[0]!.label).toBe("Off");
        expect(Array.isArray(ui.options) && ui.options.map(option => option.value)).toEqual(["off", "on"]);
        expect(result.restore()).toEqual([]);
        expect(Object.getOwnPropertyDescriptors(ui)).toEqual(before);
        expect(ui.options).toBe(options);
      }
      expect(ui.label).toBe("Mode");
    }
  });
  test("proxy rejection rolls back earlier writes with sanitized diagnostics", () => {
    const { host, pack, ui } = fixture();
    const before = Object.getOwnPropertyDescriptors(ui);
    host.schema["test.mode"]!.ui = new Proxy(ui, {
      defineProperty(target, key, descriptor) {
        if (key === "description") throw new Error("PRIVATE local path");
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
    const result = applyTranslations(host, pack);
    expect(result.status).toBe("rolled-back");
    if (result.status !== "rolled-back") throw new Error("Expected rollback");
    expect(result.reason).toBe("write-failed");
    expect(result.rollbackErrors).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(ui)).toEqual(before);
  });
  test("failed restoration can be retried without losing ownership", () => {
    const { host, pack, ui } = fixture();
    let rejectRestore = false;
    host.schema["test.mode"]!.ui = new Proxy(ui, {
      defineProperty(target, key, descriptor) {
        if (rejectRestore && key === "label") return false;
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
    const result = applyTranslations(host, pack);
    if (result.status !== "applied") throw new Error("Expected application");
    rejectRestore = true;
    expect(result.restore()).toEqual(["restore-failed"]);
    expect(ui.label).toBe("Режим");
    rejectRestore = false;
    expect(result.restore()).toEqual([]);
    expect(ui.label).toBe("Mode");
  });
  test("foreign replacement getters remain intact on restoration", () => {
    const { host, pack, ui } = fixture();
    const result = applyTranslations(host, pack);
    if (result.status !== "applied") throw new Error("Expected application");
    const foreign = () => "Режим";
    Object.defineProperty(ui, "label", { get: foreign, configurable: true });
    result.restore();
    expect(Object.getOwnPropertyDescriptor(ui, "label")!.get).toBe(foreign);
  });
  test("deleted fields and replaced options are not recreated on restoration", () => {
    const { host, pack, ui } = fixture();
    const result = applyTranslations(host, pack);
    if (result.status !== "applied") throw new Error("Expected application");
    Reflect.deleteProperty(ui, "label");
    ui.options = "runtime";
    result.restore();
    expect(Object.hasOwn(ui, "label")).toBe(false);
    expect(ui.options).toBe("runtime");
  });
  test("a proxy that mutates before throwing still restores exact descriptors", () => {
    const { host, pack, ui } = fixture();
    const before = Object.getOwnPropertyDescriptors(ui);
    let failed = false;
    host.schema["test.mode"]!.ui = new Proxy(ui, {
      defineProperty(target, key, descriptor) {
        const success = Reflect.defineProperty(target, key, descriptor);
        if (key === "description" && !failed) {
          failed = true;
          throw new Error("PRIVATE");
        }
        return success;
      },
    });
    const result = applyTranslations(host, pack);
    expect(result.status).toBe("rolled-back");
    if (result.status !== "rolled-back") throw new Error("Expected rollback");
    expect(result.rollbackErrors).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(ui)).toEqual(before);
  });
  test("platform overrides are complete rather than inherited base fields", () => {
    const { host, pack, ui } = fixture();
    const platformPack: LocalePack = { ...pack, settings: { "test.mode": { variants: [{
      sourceHash: pack.settings["test.mode"]!.variants[0]!.sourceHash, label: "Режим Windows",
      platforms: ["win32"], observedIn: [],
    }] } } };
    const result = applyTranslations(host, platformPack);
    if (result.status !== "applied") throw new Error("Expected application");
    expect(ui.label).toBe("Режим Windows");
    expect(ui.description).toBe("Choose mode");
    expect(Array.isArray(ui.options) && ui.options[0]!.label).toBe("Off");
    result.restore();
  });
  test("restoring a stale handle cannot orphan a newer application", () => {
    const { host, pack, ui } = fixture();
    const first = applyTranslations(host, pack);
    if (first.status !== "applied") throw new Error("Expected application");
    first.restore();
    const second = applyTranslations(host, pack);
    if (second.status !== "applied") throw new Error("Expected application");
    first.restore();
    expect(applyTranslations(host, pack)).toBe(second);
    expect(ui.label).toBe("Режим");
    second.restore();
  });
  test("invalid metadata and throwing reads refuse before mutation", () => {
    const { host, pack, ui } = fixture();
    Object.defineProperty(ui, "warning", { get() { throw new Error("PRIVATE"); } });
    const result = applyTranslations(host, pack);
    expect(result).toEqual({ status: "skipped", reason: "host-read-failed" });
    expect(ui.label).toBe("Mode");
  });
  test("added warnings restore absence rather than creating undefined fields", () => {
    const { host, pack, ui } = fixture();
    const warningPack: LocalePack = { ...pack, settings: { "test.mode": setting({
      ...pack.settings["test.mode"]!.variants[0]!, warning: "Осторожно",
    }) } };
    const result = applyTranslations(host, warningPack);
    if (result.status !== "applied") throw new Error("Expected application");
    expect(ui.warning).toBe("Осторожно");
    result.restore();
    expect(Object.hasOwn(ui, "warning")).toBe(false);
  });
  test("nonconfigurable live getters refuse atomically", () => {
    const { host, pack, ui } = fixture();
    const source = "Press {key} to choose";
    Object.defineProperty(ui, "description", { get: () => "Press Ctrl+A to choose", configurable: false });
    const dynamicPack: LocalePack = { ...pack, settings: { "test.mode": setting({
      ...pack.settings["test.mode"]!.variants[0]!, sourceHash: computeSourceHash(normalizeSource(ui, source)),
      descriptionSource: source, description: "Нажмите {key}",
    }) } };
    expect(applyTranslations(host, dynamicPack).status).toBe("skipped");
    expect(ui.label).toBe("Mode");
  });
  test("distinct UIs sharing completion options localize independently", () => {
    const { host, pack, ui } = fixture();
    const otherUi = { ...ui };
    host.schema.alias = { ...host.schema["test.mode"]!, ui: otherUi };
    const original = ui.options;
    const aliasPack: LocalePack = { ...pack, settings: { ...pack.settings, alias: setting({
      ...pack.settings["test.mode"]!.variants[0]!, options: { off: { label: "Иной вариант" } },
    }) } };
    const result = applyTranslations(host, aliasPack);
    if (result.status !== "applied") throw new Error("Expected application");
    expect(Array.isArray(ui.options) && ui.options[0]!.label).toBe("Выключено");
    expect(Array.isArray(otherUi.options) && otherUi.options[0]!.label).toBe("Иной вариант");
    expect(Array.isArray(original) && original[0]!.label).toBe("Off");
    result.restore();
    expect(ui.options).toBe(original);
    expect(otherUi.options).toBe(original);
  });
  test("write verification catches a proxy falsely claiming success", () => {
    const { host, pack, ui } = fixture();
    host.schema["test.mode"]!.ui = new Proxy(ui, {
      defineProperty(target, key, descriptor) {
        return key === "description" || Reflect.defineProperty(target, key, descriptor);
      },
    });
    const result = applyTranslations(host, pack);
    expect(result.status).toBe("rolled-back");
    if (result.status !== "rolled-back") throw new Error("Expected rollback");
    expect(result.rollbackErrors).toEqual([]);
    expect(ui.label).toBe("Mode");
    expect(ui.description).toBe("Choose mode");
  });
  test("rollback failures are stable codes rather than thrown local data", () => {
    const { host, pack, ui } = fixture();
    host.schema["test.mode"]!.ui = new Proxy(ui, {
      defineProperty(target, key, descriptor) {
        if (key === "description" || key === "label" && descriptor.value === "Mode") {
          throw new Error("PRIVATE local data");
        }
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
    const result = applyTranslations(host, pack);
    expect(result).toMatchObject({ status: "rolled-back", reason: "write-failed", rollbackErrors: ["restore-failed"] });
    expect(ui.description).toBe("Choose mode");
  });
  test("shared option translation conflicts refuse before any mutation", () => {
    const { host, pack, ui } = fixture();
    host.schema.alias = host.schema["test.mode"];
    const conflictPack: LocalePack = { ...pack, settings: { ...pack.settings, alias: setting({
      ...pack.settings["test.mode"]!.variants[0]!, options: { off: { label: "Противоречие" } },
    }) } };
    expect(applyTranslations(host, conflictPack)).toEqual({ status: "skipped", reason: "conflicting-translations" });
    expect(ui.label).toBe("Mode");
    expect(Array.isArray(ui.options) && ui.options[0]!.label).toBe("Off");
  });
});

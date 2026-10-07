import { describe, expect, test } from "bun:test";
import type { HostMetadata, HostSettingDefinition, HostUiMetadata } from "../src/host-types";
import { buildCoverageReport, buildDriftReport, buildSourceSnapshot, resolveSettingTranslation } from "../src/report";
import { computeSourceHash, normalizeSource } from "../src/source";
import { descriptionTemplates } from "../src/source-templates";
import type { LocalePack, SettingTranslation } from "../src/translations/types";

// Reviewed template path; the literal wording stays owned by src/source-templates.ts.
const TEMPLATED_PATH = "spelling.autocomplete";
const TEMPLATE = descriptionTemplates[TEMPLATED_PATH]!;
const templatedUi: HostUiMetadata = {
  tab: "completion",
  label: "Autocomplete",
  description: TEMPLATE.replace("{accept}", "Ctrl+Space").replace("{right}", "Ctrl+F"),
};

function setting(ui?: HostUiMetadata): HostSettingDefinition {
  return ui ? { type: "string", default: "off", ui } : { type: "boolean", default: false };
}

function hostOf(schema: Record<string, HostSettingDefinition>, platform = "win32"): HostMetadata {
  return { version: "18.8.0", platform, schema };
}

function entry(ui: HostUiMetadata, template: string | undefined, fields: Omit<SettingTranslation, "sourceHash"> & { sourceHash?: string }): SettingTranslation {
  return { ...fields, sourceHash: fields.sourceHash ?? computeSourceHash(normalizeSource(ui, template)) };
}

function pack(settings: Record<string, SettingTranslation>): LocalePack {
  return { locale: "ru", sourceOmpVersion: "18.8.0", settings };
}

describe("coverage report", () => {
  test("separates complete, partial, untranslated and stale entries", () => {
    const completeUi: HostUiMetadata = {
      tab: "general", group: "Core", label: "Mode", description: "Choose mode", warning: "Restart required",
      options: [{ value: "off", label: "Off", description: "No mode" }],
    };
    const partialUi: HostUiMetadata = { tab: "general", label: "Limit", description: "Retry limit", warning: "Costs money" };
    const untranslatedUi: HostUiMetadata = { tab: "general", label: "Timeout", description: "Request timeout" };
    const host = hostOf({
      "a.complete": setting(completeUi),
      "b.partial": setting(partialUi),
      "c.untranslated": setting(untranslatedUi),
      "d.noUi": setting(),
    });
    const locale = pack({
      "a.complete": entry(completeUi, undefined, {
        label: "Режим", description: "Выберите режим", warning: "Нужен перезапуск",
        options: { off: { label: "Выкл", description: "Без режима" } },
      }),
      "b.partial": entry(partialUi, undefined, { label: "Лимит" }),
      "d.noUi": { sourceHash: "0".repeat(64), label: "Устарело" },
    });

    const report = buildCoverageReport(host, locale);
    expect(report.totalUiSettings).toBe(3);
    expect(report.translatedSettings).toBe(2);
    expect(report.completeSettings).toBe(1);
    expect(report.partialSettings).toBe(1);
    expect(report.untranslatedPaths).toEqual(["c.untranslated"]);
    expect(report.partialPaths).toEqual(["b.partial"]);
    expect(report.stalePaths).toEqual(["d.noUi"]);
    expect(report.optionMismatches).toEqual([]);
    expect(report.sourceHashMismatches).toEqual([]);
  });

  test("does not credit a translation that invents a warning", () => {
    const ui: HostUiMetadata = { tab: "general", label: "Mode", description: "Choose mode" };
    const locale = pack({ mode: entry(ui, undefined, { label: "Режим", description: "Выберите режим", warning: "Опасно" }) });

    const report = buildCoverageReport(hostOf({ mode: setting(ui) }), locale);
    expect(report.completeSettings).toBe(0);
    expect(report.partialPaths).toEqual(["mode"]);
  });

  test("reports missing and stale option values separately", () => {
    const ui: HostUiMetadata = {
      tab: "general", label: "Mode", description: "Choose mode",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
    };
    const locale = pack({ mode: entry(ui, undefined, { label: "Режим", description: "Выберите режим", options: { a: { label: "А" }, z: { label: "З" } } }) });

    const report = buildCoverageReport(hostOf({ mode: setting(ui) }), locale);
    expect(report.optionMismatches).toEqual([{ path: "mode", missingValues: ["b"], staleValues: ["z"] }]);
    expect(report.completeSettings).toBe(0);
    expect(report.partialPaths).toEqual(["mode"]);
  });

  test("requires an option description only where the source option has one", () => {
    const ui: HostUiMetadata = {
      tab: "general", label: "Mode", description: "Choose mode",
      options: [{ value: "a", label: "A", description: "Explains A" }, { value: "b", label: "B" }],
    };
    const locale = pack({ mode: entry(ui, undefined, { label: "Режим", description: "Выберите режим", options: { a: { label: "А" }, b: { label: "Б" } } }) });

    const report = buildCoverageReport(hostOf({ mode: setting(ui) }), locale);
    expect(report.optionMismatches).toEqual([{ path: "mode", missingValues: ["a"], staleValues: [] }]);
    expect(report.partialPaths).toEqual(["mode"]);
  });

  test("static catalog options for dynamic or absent sources are stale, never missing", () => {
    const runtimeUi: HostUiMetadata = { tab: "general", label: "Mode", description: "Choose mode", options: "runtime" };
    const absentUi: HostUiMetadata = { tab: "general", label: "Mode", description: "Choose mode" };
    const fields = { label: "Режим", description: "Выберите режим", options: { x: { label: "Х" } } };

    const runtime = buildCoverageReport(hostOf({ mode: setting(runtimeUi) }), pack({ mode: entry(runtimeUi, undefined, fields) }));
    expect(runtime.optionMismatches).toEqual([{ path: "mode", missingValues: [], staleValues: ["x"] }]);

    const absent = buildCoverageReport(hostOf({ mode: setting(absentUi) }), pack({ mode: entry(absentUi, undefined, fields) }));
    expect(absent.optionMismatches).toEqual([{ path: "mode", missingValues: [], staleValues: ["x"] }]);

    const textOnly = buildCoverageReport(hostOf({ mode: setting(runtimeUi) }), pack({ mode: entry(runtimeUi, undefined, { label: "Режим", description: "Выберите режим" }) }));
    expect(textOnly.optionMismatches).toEqual([]);
    expect(textOnly.completeSettings).toBe(1);
  });

  test("flags a source hash mismatch even when every text is translated", () => {
    const ui: HostUiMetadata = { tab: "general", label: "Mode", description: "Choose mode" };
    const locale = pack({ mode: entry(ui, undefined, { sourceHash: "0".repeat(64), label: "Режим", description: "Выберите режим" }) });

    const report = buildCoverageReport(hostOf({ mode: setting(ui) }), locale);
    expect(report.translatedSettings).toBe(1);
    expect(report.sourceHashMismatches).toEqual(["mode"]);
    expect(report.completeSettings).toBe(0);
    expect(report.partialPaths).toEqual(["mode"]);
  });
});

describe("reviewed templates", () => {
  test("tolerate live keybinding changes but not changed wording", () => {
    const locale = pack({
      [TEMPLATED_PATH]: entry(templatedUi, TEMPLATE, {
        label: "Автодополнение", description: "Показывает подсказки", descriptionSource: TEMPLATE,
      }),
    });
    const withKeybindings = (description: string) => hostOf({ [TEMPLATED_PATH]: setting({ ...templatedUi, description }) });

    const rebound = buildCoverageReport(withKeybindings(TEMPLATE.replace("{accept}", "Ctrl+Alt+A").replace("{right}", "Ctrl+G")), locale);
    expect(rebound.completeSettings).toBe(1);
    expect(rebound.sourceHashMismatches).toEqual([]);

    const reworded = buildCoverageReport(withKeybindings("Completions are shown while typing"), locale);
    expect(reworded.sourceHashMismatches).toEqual([TEMPLATED_PATH]);
    expect(reworded.partialPaths).toEqual([TEMPLATED_PATH]);
  });

  test("a translation cannot claim a template the source does not have", () => {
    const ui: HostUiMetadata = { tab: "general", label: "Mode", description: "Choose mode" };
    const locale = pack({ mode: entry(ui, undefined, { label: "Режим", description: "Выберите режим", descriptionSource: TEMPLATE }) });

    const report = buildCoverageReport(hostOf({ mode: setting(ui) }), locale);
    expect(report.sourceHashMismatches).toEqual([]);
    expect(report.partialPaths).toEqual(["mode"]);
  });

  test("a platform entry that drops the reviewed template stays partial", () => {
    const platformHost = hostOf({ [TEMPLATED_PATH]: setting(templatedUi) }, "darwin");
    const base = entry(templatedUi, TEMPLATE, { label: "Автодополнение", description: "Показывает подсказки", descriptionSource: TEMPLATE });
    const darwin = entry(templatedUi, TEMPLATE, { label: "Автодополнение", description: "Показывает подсказки" });
    const locale = pack({ [TEMPLATED_PATH]: { ...base, byPlatform: { darwin } } });

    const report = buildCoverageReport(platformHost, locale);
    expect(report.sourceHashMismatches).toEqual([]);
    expect(report.partialPaths).toEqual([TEMPLATED_PATH]);
  });
});

describe("platform resolution", () => {
  const base: SettingTranslation = { sourceHash: "base", label: "База", description: "Базовое описание" };
  const platformPack = pack({ mode: { ...base, byPlatform: { win32: { sourceHash: "win", label: "Windows" } } } });

  test("platform entries replace the whole entry, not single fields", () => {
    expect(resolveSettingTranslation(platformPack, "mode", "win32")).toEqual({ sourceHash: "win", label: "Windows" });
    expect(resolveSettingTranslation(platformPack, "mode", "linux")).toMatchObject({ sourceHash: "base", label: "База", description: "Базовое описание" });
    expect(resolveSettingTranslation(platformPack, "absent", "win32")).toBeUndefined();
  });

  test("coverage uses the override for the host platform", () => {
    const ui: HostUiMetadata = { tab: "general", label: "Mode", description: "Choose mode" };
    const locale = pack({
      mode: {
        ...entry(ui, undefined, { label: "Режим" }),
        byPlatform: { win32: entry(ui, undefined, { label: "Режим", description: "Выберите режим" }) },
      },
    });

    const onWindows = buildCoverageReport(hostOf({ mode: setting(ui) }, "win32"), locale);
    expect(onWindows.completeSettings).toBe(1);
    expect(onWindows.partialPaths).toEqual([]);
    expect(onWindows.sourceHashMismatches).toEqual([]);

    const onLinux = buildCoverageReport(hostOf({ mode: setting(ui) }, "linux"), locale);
    expect(onLinux.completeSettings).toBe(0);
    expect(onLinux.partialPaths).toEqual(["mode"]);
  });
});

describe("upstream drift", () => {
  const mode: HostUiMetadata = { tab: "general", label: "Mode", description: "Choose mode" };
  const other: HostUiMetadata = { tab: "general", label: "Timeout", description: "Request timeout" };
  const previousMode: HostUiMetadata = { ...mode, label: "Old Mode" };
  const baseline = {
    version: "18.8.0",
    platform: "win32",
    settings: {
      keep: { sourceHash: computeSourceHash(normalizeSource(mode)), ...normalizeSource(mode) },
      changed: { sourceHash: computeSourceHash(normalizeSource(previousMode)), ...normalizeSource(previousMode) },
      removed: { sourceHash: "0".repeat(64), ...normalizeSource(other) },
    },
  };
  const host = hostOf({ keep: setting(mode), changed: setting(mode), added: setting(other) });

  test("reports added, removed and changed paths explicitly", () => {
    const drift = buildDriftReport(host, baseline);
    expect(drift.addedPaths).toEqual(["added"]);
    expect(drift.removedPaths).toEqual(["removed"]);
    expect(drift.changedPaths).toEqual(["changed"]);
  });

  test("an unchanged registry and a different platform label are not drift", () => {
    const snapshot = buildSourceSnapshot(host);
    expect(buildDriftReport(host, snapshot)).toEqual({ addedPaths: [], removedPaths: [], changedPaths: [] });
    expect(buildDriftReport(hostOf({ keep: setting(mode), changed: setting(mode), added: setting(other) }, "linux"), snapshot))
      .toEqual({ addedPaths: [], removedPaths: [], changedPaths: [] });
  });

  test("snapshot hashes normalized metadata and skips settings without ui", () => {
    const snapshot = buildSourceSnapshot(hostOf({ keep: setting(mode), plain: setting() }));
    expect(Object.keys(snapshot.settings)).toEqual(["keep"]);
    expect(snapshot.settings.keep!.sourceHash).toBe(computeSourceHash(normalizeSource(mode)));
    expect(snapshot.version).toBe("18.8.0");
    expect(JSON.stringify(buildSourceSnapshot(host))).toBe(JSON.stringify(buildSourceSnapshot(host)));
  });
});

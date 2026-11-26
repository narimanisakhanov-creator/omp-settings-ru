import { strict as assert } from "node:assert";
import type * as LegacySelector from "omp-tui-1911/overlays/settings-selector";
import type * as LegacyTheme from "omp-tui-1911/theme/theme";
import type * as LegacySettings from "omp-api-1911/config/settings";
import type * as LegacyHost from "omp-api-1911/config/settings-ui";
import type * as LegacyPlugins from "omp-api-1911/extensibility/plugins/settings-host";
import type * as ModernSettings from "omp-api-1920/config/settings";
import type * as ModernHost from "omp-api-1920/config/settings-ui";
import type * as ModernPlugins from "omp-api-1920/extensibility/plugins/settings-host";
import type * as ModernWindow from "omp-api-1920/ui/overlays/settings/settings";
import type * as ModernTheme from "omp-api-1920/ui/theme/service";
import type * as ModernTerminal from "omp-tui-1920/testing/terminal";
import type * as ModernRuntime from "omp-tui-1920/theme/runtime";
import { getHostMetadata } from "../src/host-adapter";
import { LanguageController } from "../src/language-controller";
import { ru } from "../src/translations/ru";
import { GLYPH_PRESETS, RU_ENUM_QUERY, RU_ENUM_SETTLED, RU_SEARCH_QUERY, RU_SEARCH_SETTLED, glyphKeyAway, glyphPreset, glyphTarget, searchToggle } from "./panel-search";
import { panelHostRoute } from "./panel-host-routing";

// Host generations have incompatible modules; aliases provide types only, never runtime state.
const root = "@oh-my-pi/pi-coding-agent";
const tui = "@oh-my-pi/pi-tui";
const hostVersion = (await getHostMetadata()).version;
let panel: () => Pick<LegacySelector.SettingsSelectorComponent, "handleInput" | "render">;
let initThemeSync: typeof LegacyTheme.initThemeSync;
let createSettingsHost: typeof LegacyHost.createSettingsHost | typeof ModernHost.createSettingsHost;
let disposePanel: (() => void) | undefined;
if (panelHostRoute(hostVersion) === "modern") {
  const [settingsModule, hostModule, pluginsModule, themeModule, terminalModule, runtimeModule, windowModule]: [
    typeof ModernSettings, typeof ModernHost, typeof ModernPlugins, typeof ModernTheme,
    typeof ModernTerminal, typeof ModernRuntime, typeof ModernWindow,
  ] = await Promise.all([
    import(`${root}/config/settings`), import(`${root}/config/settings-ui`),
    import(`${root}/extensibility/plugins/settings-host`), import(`${root}/ui/theme/service`),
    import(`${tui}/testing/terminal`), import(`${tui}/theme/runtime`),
    // The host's wildcard export maps to .ts, but this file is shipped as .tsx.
    import(new URL("../ui/overlays/settings/settings.tsx", import.meta.resolve(`${root}/config/settings`)).href),
  ]);
  await settingsModule.Settings.init({ inMemory: true, cwd: process.cwd(), configFiles: [] });
  createSettingsHost = hostModule.createSettingsHost;
  initThemeSync = preset => themeModule.initTheme({ symbolPreset: preset });
  let activeTerminal: ModernTerminal.TestTerminal | undefined;
  disposePanel = () => {
    const terminal = activeTerminal;
    activeTerminal = undefined;
    terminal?.dispose();
  };
  panel = () => {
    disposePanel?.();
    const terminal = terminalModule.createTestTerminal(() => ({ dock: windowModule.SettingsWindow({
      context: { settings: hostModule.createSettingsHost(), plugins: pluginsModule.createPluginSettingsHost(process.cwd()), availableThinkingLevels: [], availableThemes: [], providers: [] },
      callbacks: { onChange: () => {}, onCancel: () => {} },
    }) }), { columns: 120, rows: 40, theme: runtimeModule.currentTheme() });
    activeTerminal = terminal;
    const node = terminal.surface.dock()[0];
    assert.ok(node && node.kind === "prefs", "settings window did not mount its prefs node");
    terminal.focus(node);
    return {
      handleInput(input) {
        if (input === "\r") terminal.press("enter");
        else if (input === "\x1b[A") terminal.press("up");
        else if (input === "\x1b[B") terminal.press("down");
        else terminal.type(input);
      },
      render: () => terminal.screen(),
    };
  };
} else {
  const [settingsModule, hostModule, pluginsModule, selectorModule, themeModule]: [
    typeof LegacySettings, typeof LegacyHost, typeof LegacyPlugins, typeof LegacySelector, typeof LegacyTheme,
  ] = await Promise.all([
    import(`${root}/config/settings`), import(`${root}/config/settings-ui`),
    import(`${root}/extensibility/plugins/settings-host`), import(`${tui}/overlays/settings-selector`),
    import(`${tui}/theme/theme`),
  ]);
  await settingsModule.Settings.init({ inMemory: true, cwd: process.cwd(), configFiles: [] });
  createSettingsHost = hostModule.createSettingsHost;
  initThemeSync = themeModule.initThemeSync;
  panel = () => new selectorModule.SettingsSelectorComponent({
    settings: hostModule.createSettingsHost(), plugins: pluginsModule.createPluginSettingsHost(process.cwd()),
    availableThinkingLevels: [], thinkingLevel: undefined, availableThemes: [], providers: [],
  }, { onChange: () => {}, onCancel: () => {} });
}
let scenarioFailed = false;
try {
initThemeSync();
const controller = new LanguageController(getHostMetadata, ru);
assert.equal(await controller.setLanguage("ru", "main"), undefined);


const russian = panel();
russian.handleInput("дальтоников");
let surface = russian.render(120).join("\n");
assert.match(surface, /Режим для дальтоников/);
assert.match(surface, /1 match/);
russian.handleInput("\r");
assert.equal(createSettingsHost().get("colorBlindMode"), true);

// The native PTY sessions (scripts/distribution-session.ts, scripts/smoke-installed-worker.ts) must not
// press Enter until the searched setting is the only row Enter can activate: the panel re-ranks its fuzzy
// corpus on every keystroke, so the label is rendered long before the selection reaches it. Prove the
// settled invariant for every prefix the sessions type, under each supported symbol preset, then toggle
// the setting for real. The nerd preset matters because a confirmed Glyph Protocol handshake upgrades an
// unconfigured session to it, where the pointer is U+F054 instead of U+276F.
let settledPrefixes = 0;
for (const preset of ["unicode", "nerd", "ascii"] as const) {
  initThemeSync(preset);
  for (let length = 1; length <= RU_SEARCH_QUERY.length; length++) {
    const probe = panel();
    probe.handleInput(RU_SEARCH_QUERY.slice(0, length));
    const probeSurface = probe.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    if (!RU_SEARCH_SETTLED.test(probeSurface)) continue;
    settledPrefixes++;
    // The settled wait may only report one match: a partial prefix still lists other rows.
    assert.equal(probeSurface.match(/(?<!\d)\d+ match(?:es)?/g)?.join(","), "1 match", `preset=${preset} length=${length}`);
    assert.match(probeSurface, /Скорость генерации/);
  }
}
assert.ok(settledPrefixes > 0, "the settled search wait never matched a rendered panel");
initThemeSync("unicode");

for (const preset of ["unicode", "nerd", "ascii"] as const) {
  initThemeSync(preset);
  const settled = panel();
  settled.handleInput(RU_SEARCH_QUERY);
  let settledSurface = settled.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(settledSurface, RU_SEARCH_SETTLED, `preset=${preset}`);
  const toggle = searchToggle(settledSurface);
  assert.equal(createSettingsHost().get("composer.tokenRate"), toggle.current === "true");
  settled.handleInput("\r");
  settledSurface = settled.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(settledSurface, toggle.flipped, `preset=${preset} toggle`);
  assert.equal(createSettingsHost().get("composer.tokenRate"), toggle.current !== "true");
  settled.handleInput("\r");
  settledSurface = settled.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(settledSurface, toggle.restored, `preset=${preset} restore`);
  assert.equal(createSettingsHost().get("composer.tokenRate"), toggle.current === "true");
}
initThemeSync("unicode");

// The glyph-set step must work from ANY starting value and under ANY rendered preset: a session can start
// upgraded (a confirmed Glyph Protocol handshake) or carry a persisted value, so it reads the row, moves one
// deterministic step away and restores the original. Static option labels are asserted on the first pass.
let enumPasses = 0;
for (const start of GLYPH_PRESETS) {
  for (const rendered of GLYPH_PRESETS) {
    // CI's real shape is "setting unicode, rendered upgraded" — the setting/rendered pair must not matter.
    if (rendered !== start && start !== "unicode") continue;
    initThemeSync(rendered);
    const host = createSettingsHost();
    host.set("symbolPreset", start);
    const enumPanel = panel();
    enumPanel.handleInput(RU_ENUM_QUERY);
    enumPanel.handleInput("\r");
    let enumSurface = enumPanel.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(enumSurface, /Стандартные символы/);
    assert.match(enumSurface, /Максимальная совместимость/);
    const away = glyphKeyAway(start);
    // Use the real host submenu keyboard path; select the exact next original enum value.
    enumPanel.handleInput(away);
    enumPanel.handleInput("\r");
    assert.equal(await controller.setLanguage("en", "task"), "язык настроек управляется основной сессией");
    enumSurface = enumPanel.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(enumSurface, new RegExp(`Набор символов\\s+${glyphTarget(start, away)}\\b`), `start=${start} rendered=${rendered} changed`);
    assert.equal(controller.language, "ru");
    enumPanel.handleInput("\r");
    enumPanel.handleInput(away === "\x1b[B" ? "\x1b[A" : "\x1b[B");
    enumPanel.handleInput("\r");
    enumSurface = enumPanel.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(glyphPreset(enumSurface), start, `start=${start} rendered=${rendered} restored`);
    assert.equal(createSettingsHost().get("symbolPreset"), start, `start=${start} host value restored`);
    enumPasses++;
  }
}
assert.ok(enumPasses >= GLYPH_PRESETS.length, "the enum step was not exercised from every starting value");
initThemeSync("unicode");
assert.equal(await controller.setLanguage("en", "main"), undefined);
const english = panel();
english.handleInput("Color-Blind Mode");
assert.match(english.render(120).join("\n"), /Color-Blind Mode/);
assert.equal(createSettingsHost().get("colorBlindMode"), true);
assert.equal(await controller.setLanguage("ru", "main"), undefined);
assert.equal(await controller.shutdown("main"), undefined);
assert.equal(createSettingsHost().entries.find(entry => entry.path === "colorBlindMode")?.ui?.label, "Color-Blind Mode");
} catch (error) {
  scenarioFailed = true;
  throw error;
} finally {
  if (scenarioFailed) {
    try { disposePanel?.(); } catch (error) { console.error("panel-dispose-failed:", error); }
  } else {
    disposePanel?.();
  }
}
console.log(JSON.stringify({ hostVersion, platform: process.platform, russianSearch: true, nativeBooleanEdit: true, staticOptions: true, originalEnumValue: true, englishRestore: true, childOwnership: true, shutdownRestore: true, isolated: true, ok: true }, null, 2));

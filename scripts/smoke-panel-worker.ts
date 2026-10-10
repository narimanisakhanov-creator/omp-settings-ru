import { strict as assert } from "node:assert";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { getHostMetadata } from "../src/host-adapter";
import { LanguageController } from "../src/language-controller";
import { ru } from "../src/translations/ru";
import { RU_SEARCH_QUERY, RU_SEARCH_SETTLED, searchToggle } from "./panel-search";

await Settings.init({ inMemory: true, cwd: process.cwd(), configFiles: [] });
initThemeSync();
const controller = new LanguageController(getHostMetadata, ru);
assert.equal(await controller.setLanguage("ru", "main"), undefined);

function panel() {
  return new SettingsSelectorComponent({
    settings: createSettingsHost(), plugins: createPluginSettingsHost(process.cwd()),
    availableThinkingLevels: [], thinkingLevel: undefined, availableThemes: [], providers: [],
  }, { onChange: () => {}, onCancel: () => {} });
}

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

const enumPanel = panel();
enumPanel.handleInput("Набор символов");
enumPanel.handleInput("\r");
surface = enumPanel.render(120).join("\n");
assert.match(surface, /Стандартные символы/);
assert.match(surface, /Максимальная совместимость/);
// Use the real host submenu keyboard path; select next original enum value.
enumPanel.handleInput("\x1b[B");
enumPanel.handleInput("\r");
assert.equal(await controller.setLanguage("en", "task"), "язык настроек управляется основной сессией");
assert.equal(createSettingsHost().get("symbolPreset"), "nerd");
assert.equal(controller.language, "ru");
assert.equal(await controller.setLanguage("en", "main"), undefined);
const english = panel();
english.handleInput("Color-Blind Mode");
assert.match(english.render(120).join("\n"), /Color-Blind Mode/);
assert.equal(createSettingsHost().get("colorBlindMode"), true);
assert.equal(createSettingsHost().get("symbolPreset"), "nerd");
assert.equal(await controller.setLanguage("ru", "main"), undefined);
assert.equal(await controller.shutdown("main"), undefined);
assert.equal(createSettingsHost().entries.find(entry => entry.path === "colorBlindMode")?.ui?.label, "Color-Blind Mode");
const hostVersion = (await getHostMetadata()).version;
console.log(JSON.stringify({ hostVersion, platform: process.platform, russianSearch: true, nativeBooleanEdit: true, staticOptions: true, originalEnumValue: true, englishRestore: true, childOwnership: true, shutdownRestore: true, isolated: true, ok: true }, null, 2));

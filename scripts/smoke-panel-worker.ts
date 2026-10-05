import { strict as assert } from "node:assert";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { getHostMetadata } from "../src/host-adapter";
import { LanguageController } from "../src/language-controller";
import { ru } from "../src/translations/ru";

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
console.log(JSON.stringify({ hostVersion: "18.6.1", platform: process.platform, russianSearch: true, nativeBooleanEdit: true, staticOptions: true, originalEnumValue: true, englishRestore: true, childOwnership: true, shutdownRestore: true, isolated: true, ok: true }, null, 2));

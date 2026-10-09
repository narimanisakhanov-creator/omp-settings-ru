import { strict as assert } from "node:assert";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { getHostMetadata } from "../src/host-adapter";
import { LanguageController } from "../src/language-controller";
import { ru } from "../src/translations/ru";
import { RU_SEARCH_OFF, RU_SEARCH_ON, RU_SEARCH_QUERY } from "./panel-search";

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
// press Enter until the pointer is on the row they are about to activate: the panel ranks its fuzzy corpus
// on every keystroke and renders a matching label while the pointer still sits on another row. Prove the
// anchor holds for every prefix of the query the sessions type, then toggle the setting for real.
let anchoredPrefixes = 0;
for (let length = 1; length <= RU_SEARCH_QUERY.length; length++) {
  const probe = panel();
  probe.handleInput(RU_SEARCH_QUERY.slice(0, length));
  const probeSurface = probe.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  if (!RU_SEARCH_OFF.test(probeSurface)) continue;
  anchoredPrefixes++;
  assert.match(probeSurface.split("\n").find(line => line.includes("❯")) ?? "", /❯\s*Скорость генерации/);
}
assert.ok(anchoredPrefixes > 0, "the anchored search wait never matched a rendered panel");

const anchored = panel();
anchored.handleInput(RU_SEARCH_QUERY);
let anchoredSurface = anchored.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
assert.match(anchoredSurface, RU_SEARCH_OFF);
assert.match(anchoredSurface.split("\n").find(line => line.includes("❯")) ?? "", /❯\s*Скорость генерации/);
anchored.handleInput("\r");
anchoredSurface = anchored.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
assert.match(anchoredSurface, RU_SEARCH_ON);
assert.match(anchoredSurface.split("\n").find(line => line.includes("❯")) ?? "", /❯\s*Скорость генерации/);
assert.equal(createSettingsHost().get("composer.tokenRate"), true);
anchored.handleInput("\r");
anchoredSurface = anchored.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
assert.match(anchoredSurface, RU_SEARCH_OFF);
assert.match(anchoredSurface.split("\n").find(line => line.includes("❯")) ?? "", /❯\s*Скорость генерации/);
assert.equal(createSettingsHost().get("composer.tokenRate"), false);

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

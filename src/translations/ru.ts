import type { LocalePack, SettingTranslation, SourceVariant } from "./types";
import { ruPart1 } from "./ru-part-1";
import { ruPart2 } from "./ru-part-2";
import { ruPart3 } from "./ru-part-3";
import { historical1861 } from "./ru-variants";

const settings: Record<string, SettingTranslation> = {};
const commonPlatforms = ["win32", "darwin", "linux"] as const;
const addedIn1880: Readonly<Record<string, true>> = { expandThinkingBlocks: true, "providers.muse-code.storeResponses": true, "title.generator": true, "title.icons": true, "tui.autoGraph": true, "tui.renderSvg": true };
const addedIn1887: Readonly<Record<string, true>> = { "bash.gitGuard": true, "speech.speed": true, "terminal.programStatus": true, "tts.localSpeed": true, "worktree.onExit": true, "worktree.onStart": true };
for (const [path, fields] of Object.entries({ ...ruPart1, ...ruPart2, ...ruPart3 })) {
  const historical = historical1861[path];
  const observedIn = path === "title.icons" ? ["18.8.0"] : addedIn1887[path] ? ["18.8.7"] : historical || addedIn1880[path] ? ["18.8.0", "18.8.4"] : ["18.6.1", "18.8.0", "18.8.4"];
  const variants: SourceVariant[] = [{ ...fields, platforms: path === "spelling.autocomplete" ? ["win32", "linux"] : commonPlatforms, observedIn }];
  if (historical) variants.push({ ...historical, platforms: commonPlatforms, observedIn: ["18.6.1"] });
  settings[path] = { variants };
}
const spelling = ruPart1["spelling.autocomplete"]!;
settings["spelling.autocomplete"] = { variants: [
  ...settings["spelling.autocomplete"]!.variants,
  { ...spelling, platforms: ["darwin"], observedIn: ["18.6.1", "18.8.0", "18.8.4"],
    sourceHash: "d84b17e49e184329c94a1eac34ba67d51fcbb4452d4e55c3328a1031c318168f",
    options: { ...spelling.options, apple: { label: "Apple", description: "Дополнение слов из словаря macOS" } },
  },
] };
// Description-only drift approved independently; preserve the old variant and shared option translations.
settings["title.icons"] = { variants: [
  ...settings["title.icons"]!.variants,
  { ...ruPart1["title.icons"]!, platforms: commonPlatforms, observedIn: ["18.8.4"],
    sourceHash: "12f17559bb8210b11510ed4c42ea7da2534b972864bb0b71f1187fedefdcb031",
    description: "Иконка и короткий код в начале новых автоматически созданных заголовков сессий",
  },
  { ...ruPart1["title.icons"]!, platforms: commonPlatforms, observedIn: ["18.8.7"],
    sourceHash: "02f941604096c7628fcd21e408f7655bd019d7411de67c23c330b9412a393e93",
    description: "Иконка и короткий код в начале новых заголовков сессий, созданных автоматически или заданных через /rename",
  },
] };
// 18.8.7 clarifies the writable local:// scratch surface; the 18.6.1–18.8.4 wording stays for those hosts.
settings["tools.xdev"] = { variants: [
  ...settings["tools.xdev"]!.variants,
  { ...ruPart3["tools.xdev"]!, platforms: commonPlatforms, observedIn: ["18.8.7"],
    sourceHash: "aef279287594846271d548c41381f6c9a662df6427ebfe27ebde5790c1b921c7",
    description: "Монтирует редко используемые (обнаруживаемые) инструменты под URL устройств xd://, управляемые через read/write, вместо передачи их схем в каждом запросе. Сессии, чей явный список инструментов даёт read, но не даёт write, монтируют устройства через транспорт write только для устройств (помимо устройств запись разрешена только во временное пространство local://). Отключите, чтобы выставить каждый включённый инструмент на верхнем уровне.",
  },
] };
export const ru: LocalePack = { locale: "ru", settings };

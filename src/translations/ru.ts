import type { LocalePack, SettingTranslation, SourceVariant } from "./types";
import { ruPart1 } from "./ru-part-1";
import { ruPart2 } from "./ru-part-2";
import { ruPart3 } from "./ru-part-3";
import { historical1861 } from "./ru-variants";

const settings: Record<string, SettingTranslation> = {};
const commonPlatforms = ["win32", "darwin", "linux"] as const;
const addedIn1880: Readonly<Record<string, true>> = { expandThinkingBlocks: true, "providers.muse-code.storeResponses": true, "title.generator": true, "title.icons": true, "tui.autoGraph": true, "tui.renderSvg": true };
for (const [path, fields] of Object.entries({ ...ruPart1, ...ruPart2, ...ruPart3 })) {
  const historical = historical1861[path];
  const observedIn = path === "title.icons" ? ["18.8.0"] : historical || addedIn1880[path] ? ["18.8.0", "18.8.4"] : ["18.6.1", "18.8.0", "18.8.4"];
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
] };
export const ru: LocalePack = { locale: "ru", settings };

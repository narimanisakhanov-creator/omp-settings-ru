import type { LocalePack } from "./types";
import { ruPart1 } from "./ru-part-1";
import { ruPart2 } from "./ru-part-2";
import { ruPart3 } from "./ru-part-3";

const spelling = ruPart1["spelling.autocomplete"]!;

export const ru: LocalePack = {
  locale: "ru",
  sourceOmpVersion: "18.6.1",
  settings: {
    ...ruPart1,
    ...ruPart2,
    ...ruPart3,
    "spelling.autocomplete": {
      ...spelling,
      byPlatform: {
        darwin: {
          ...spelling,
          sourceHash: "d84b17e49e184329c94a1eac34ba67d51fcbb4452d4e55c3328a1031c318168f",
          options: { ...spelling.options, apple: { label: "Apple", description: "Дополнение слов из словаря macOS" } },
        },
      },
    },
  },
};

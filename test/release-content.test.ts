import { describe, expect, test } from "bun:test";
import {
  buildReleaseDocuments, BADGES_END, BADGES_START, COVERAGE_END, COVERAGE_START, COMPATIBILITY_END, COMPATIBILITY_START, hasReleaseHeading, renderCompatibility,
  renderCoverageBadge, replaceCoverageBadge, renderVersionBadge, replaceVersionBadge, renderTranslationUpdate, replaceCompatibility,
  type ReleaseContentInput,
} from "../scripts/maintenance/release-content";
import type { CatalogEntry, CoveragePair } from "../scripts/maintenance/semantic";
import type { BaselineSnapshot } from "../src/report";
import type { SourcePlatform } from "../src/translations/types";

const PREV = "18.8.7";
const NEXT = "18.12.6";
const RELEASE = "0.7.1";
const VERSIONS = [PREV, NEXT] as const;
const PLATFORMS: readonly SourcePlatform[] = ["win32", "linux", "darwin"];

/** SHA-256 каталога: 64 строчных hex-символа. Значение не проверяется генератором, важна только форма. */
const hash = (digit: string): string => digit.repeat(64);
const H_THEME_OLD = hash("1");
const H_THEME_NEW = hash("2");
const H_SPELLING = hash("3");
const H_PREDICTIONS = hash("4");
const H_LEGACY = hash("5");
const H_REMOVED = hash("6");
const H_GONE = hash("7");
const H_FRESH = hash("8");
const H_GHOST = hash("9");
const TRANSLATION_HASH = "b".repeat(64);

function entry(
  path: string, sourceHash: string, label: string,
  platforms: readonly SourcePlatform[], observedIn: readonly string[] = [NEXT],
): CatalogEntry {
  return { path, sourceHash, translationHash: TRANSLATION_HASH, label, platforms, observedIn };
}

type SnapshotSettings = Readonly<Record<string, { readonly sourceHash: string; readonly label?: string }>>;

function snapshotFor(version: string, platform: SourcePlatform, settings: SnapshotSettings): BaselineSnapshot {
  return {
    version,
    platform,
    settings: Object.fromEntries(Object.entries(settings).map(([path, value]) => [path, {
      tab: "main", group: null, label: value.label ?? "English label", description: "English description",
      warning: null, options: null, sourceHash: value.sourceHash,
    }])),
  };
}

/** Снимки трёх платформ одной версии: отсутствующая платформа остаётся пустой, но присутствует. */
function snapshots(version: string, byPlatform: Partial<Record<SourcePlatform, SnapshotSettings>> = {}): BaselineSnapshot[] {
  return PLATFORMS.map(platform => snapshotFor(version, platform, byPlatform[platform] ?? {}));
}

function coverage(
  versions: readonly string[],
  cell: (version: string, platform: SourcePlatform) => { readonly complete: number; readonly total: number }
    = () => ({ complete: 419, total: 419 }),
): CoveragePair[] {
  return versions.flatMap(version => PLATFORMS.map(platform => ({ version, platform, ...cell(version, platform) })));
}

function makeInput(overrides: Partial<ReleaseContentInput> = {}): ReleaseContentInput {
  return {
    releaseVersion: RELEASE,
    previousHostVersion: PREV,
    upstreamVersion: NEXT,
    versions: [...VERSIONS],
    before: [],
    after: [],
    previousSnapshots: snapshots(PREV),
    currentSnapshots: snapshots(NEXT),
    coverage: coverage(VERSIONS),
    ...overrides,
  };
}

describe("renderCompatibility", () => {
  test("показывает все переданные версии и измеренное покрытие каждой платформы", () => {
    const section = renderCompatibility([NEXT, PREV], coverage(VERSIONS, (version, platform) =>
      version === PREV && platform === "linux" ? { complete: 400, total: 419 } : { complete: 419, total: 419 }));
    expect(section).toContain("| OMP | Windows | Linux | macOS |");
    // Порядок версий числовой, а не порядок аргументов: старая версия остаётся в таблице.
    expect(section).toContain("| 18.8.7 | 419/419 | 400/419 | 419/419 |");
    expect(section).toContain("| 18.12.6 | 419/419 | 419/419 | 419/419 |");
    // Разное покрытие платформ не усредняется до одного числа.
    expect(section).not.toContain("| 18.8.7 | 419/419 | 419/419 | 419/419 |");
    expect(section).toContain("test/fixtures/host-snapshots/supported-hosts.json");
    expect(section).toContain(".github/workflows/check.yml");
  });

  test("неполное покрытие платформы блокирует таблицу", () => {
    const incomplete = coverage(VERSIONS).filter(pair => !(pair.version === PREV && pair.platform === "darwin"));
    expect(() => renderCompatibility(VERSIONS, incomplete)).toThrow("release-content-invalid:coverage-missing:18.8.7-darwin");
  });

  test("дубль версии и нестабильная версия блокируют таблицу", () => {
    expect(() => renderCompatibility([PREV, PREV], coverage([PREV]))).toThrow("release-content-invalid:versions-duplicate");
    expect(() => renderCompatibility(["18.8"], coverage(["18.8"]))).toThrow("release-content-invalid:version-invalid:18.8");
  });
});

describe("header badges", () => {
  test("печатает диапазон активного окна и полное покрытие самой новой версии", () => {
    expect(renderVersionBadge(VERSIONS)).toContain("https://img.shields.io/badge/OMP-18.8.7--18.12.6-8a2be2");
    const coverageBadge = renderCoverageBadge(VERSIONS, coverage(VERSIONS));
    expect(coverageBadge).toContain("https://img.shields.io/badge/перевод-419%2F419_(100%25)-brightgreen");
    expect(coverageBadge).toContain('alt="Покрытие каталога 419/419"');
  });

  test("неполное покрытие показывается честной дробью, а не 100%", () => {
    const badge = renderCoverageBadge(VERSIONS, coverage(VERSIONS, (version, platform) =>
      version === NEXT && platform === "linux" ? { complete: 400, total: 419 } : { complete: 419, total: 419 }));
    expect(badge).toContain("перевод-400%2F419-brightgreen");
    expect(badge).not.toContain("100%25");
  });

  test("отсутствующее покрытие версии блокирует бейдж покрытия", () => {
    expect(() => renderCoverageBadge(VERSIONS, coverage([PREV]))).toThrow("release-content-invalid:coverage-missing:18.12.6");
  });

  test("каждая пара маркеров заменяется отдельно и не пересекается", () => {
    const readme = `${BADGES_START}\n<img>\n${BADGES_END}\n${COVERAGE_START}\n<img>\n${COVERAGE_END}\n`;
    expect(replaceVersionBadge(readme, "V")).toBe(`${BADGES_START}\nV\n${BADGES_END}\n${COVERAGE_START}\n<img>\n${COVERAGE_END}\n`);
    expect(replaceCoverageBadge(readme, "C")).toBe(`${BADGES_START}\n<img>\n${BADGES_END}\n${COVERAGE_START}\nC\n${COVERAGE_END}\n`);
  });

  test("отсутствие или дубль маркеров — отказ", () => {
    expect(() => replaceVersionBadge("no markers", "V")).toThrow("readme-badges-markers-invalid");
    expect(() => replaceCoverageBadge("no markers", "C")).toThrow("readme-coverage-markers-invalid");
    const doubled = `${BADGES_START}\n${BADGES_END}\n${BADGES_START}\n${BADGES_END}\n`;
    expect(() => replaceVersionBadge(doubled, "V")).toThrow("readme-badges-markers-invalid");
  });
});

describe("replaceCompatibility", () => {
  const README = [
    "# omp-settings-ru",
    "",
    "bun add -g @oh-my-pi/pi-coding-agent@18.12.6",
    "",
    COMPATIBILITY_START,
    "## устаревшая таблица",
    COMPATIBILITY_END,
    "",
    "## подробнее",
    "текст после блока",
  ].join("\n");

  test("заменяет только управляемый блок и сохраняет остальные байты", () => {
    const section = renderCompatibility(VERSIONS, coverage(VERSIONS));
    const result = replaceCompatibility(README, section);
    const prefix = README.slice(0, README.indexOf(COMPATIBILITY_START) + COMPATIBILITY_START.length);
    const suffix = README.slice(README.indexOf(COMPATIBILITY_END));
    expect(result).toBe(`${prefix}\n${section}\n${suffix}`);
    expect(result).toContain("bun add -g @oh-my-pi/pi-coding-agent@18.12.6");
    expect(result).toContain("## подробнее\nтекст после блока");
    expect(result).not.toContain("## устаревшая таблица");
  });

  test("отсутствие маркеров блокирует замену", () => {
    expect(() => replaceCompatibility("# readme\n", "x")).toThrow("readme-support-markers-invalid");
  });

  test("дублированная пара маркеров блокирует замену", () => {
    const doubled = `${README}\n${COMPATIBILITY_START}\nещё\n${COMPATIBILITY_END}`;
    expect(() => replaceCompatibility(doubled, "x")).toThrow("readme-support-markers-invalid");
  });

  test("инвертированные маркеры блокируют замену", () => {
    const inverted = `${COMPATIBILITY_END}\nсередина\n${COMPATIBILITY_START}`;
    expect(() => replaceCompatibility(inverted, "x")).toThrow("readme-support-markers-invalid");
  });
});

describe("заголовок выпуска в CHANGELOG распознаётся по границе версии", () => {
  test("0.7.1 не совпадает с 0.7.10", () => {
    expect(hasReleaseHeading("## 0.7.10\n\n- следующая версия\n", "0.7.1")).toBe(false);
    expect(hasReleaseHeading("## [0.7.10](https://example.invalid/v0.7.10) — 2026-10-10\n", "0.7.1")).toBe(false);
  });

  test("принятые формы собственной секции распознаются", () => {
    for (const heading of ["## 0.7.1\n", "## 0.7.1 (2026-10-10)\n", "## [0.7.1](https://example.invalid/v0.7.1) — 2026-10-10\n", "## [0.7.1]\n"]) {
      expect(hasReleaseHeading(heading, "0.7.1")).toBe(true);
    }
  });

  test("существующая секция версии блокирует генерацию документов", () => {
    const input = makeInput();
    const base = { readme: `${COMPATIBILITY_START}\n\n${COMPATIBILITY_END}\n`, changelog: "## 0.7.1\n\n- написано человеком\n" };
    expect(() => buildReleaseDocuments(input, base)).toThrow("release-changelog-version-conflict");
  });
});

describe("название берётся только у варианта, обслуживающего платформу", () => {
  test("вариант того же sourceHash на чужой платформе не подменяет название", () => {
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      after: [
        entry("theme.dark", H_THEME_NEW, "Тема Windows", ["win32"]),
        entry("theme.dark", H_THEME_NEW, "Тема macOS", ["darwin"]),
      ],
      currentSnapshots: snapshots(NEXT, { win32: { "theme.dark": { sourceHash: H_THEME_NEW } } }),
    }));
    expect(changelogSection).toContain("Новые настройки на русском: 1 — Тема Windows (`theme.dark`).");
    expect(changelogSection).not.toContain("Тема macOS");
    expect(report).toContain("| Тема Windows | `theme.dark` |");
    expect(report).not.toContain("Тема macOS");
  });
});

describe("счётчики настроек и вариантов различаются", () => {
  test("две версии одного пути дают одну настройку и два варианта", () => {
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      before: [entry("theme.dark", H_THEME_OLD, "Старая тема", [...PLATFORMS], [PREV])],
      after: [
        entry("theme.dark", H_THEME_NEW, "Новая тема", [...PLATFORMS]),
        entry("theme.dark", H_FRESH, "Свежая тема", [...PLATFORMS]),
      ],
      currentSnapshots: snapshots(NEXT, {
        win32: { "theme.dark": { sourceHash: H_THEME_NEW } },
        linux: { "theme.dark": { sourceHash: H_FRESH } },
        darwin: { "theme.dark": { sourceHash: H_FRESH } },
      }),
    }));
    // Счётчик настроек — по путям: две платформы одного варианта и второй вариант не умножают его.
    expect(changelogSection).toContain("Обновлены переводы изменившихся настроек: 1 —");
    expect(report).toContain("## Обновлены переводы изменившихся настроек (1 настройка, 2 варианта)");
  });
});

describe("renderTranslationUpdate: новые и обновлённые переводы", () => {
  test("новый путь на трёх платформах считается один раз", () => {
    const settings = { "composer.predictions": { sourceHash: H_PREDICTIONS } };
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      after: [entry("composer.predictions", H_PREDICTIONS, "Предсказания композера", [...PLATFORMS])],
      currentSnapshots: snapshots(NEXT, { win32: settings, linux: settings, darwin: settings }),
    }));
    expect(changelogSection.startsWith(`## ${RELEASE}\n\nOMP ${PREV} → ${NEXT}.\n\n- `)).toBe(true);
    expect(changelogSection)
      .toContain("Новые настройки на русском: 1 — Предсказания композера (`composer.predictions`).");
    expect(changelogSection.match(/Новые настройки на русском/g)).toHaveLength(1);
    expect(changelogSection).not.toContain("Обновлены переводы");
    expect(changelogSection).not.toContain("Расширена доступность");
    expect(report).toContain("## Новые настройки на русском (1)");
    expect(report)
      .toContain(`| Предсказания композера | \`composer.predictions\` | \`${H_PREDICTIONS}\` | win32, linux, darwin |`);
  });

  test("тот же sourceHash существующего пути не считается новым переводом", () => {
    const settings = { "theme.dark": { sourceHash: H_THEME_OLD } };
    const before = [entry("theme.dark", H_THEME_OLD, "Тёмная тема", ["win32"], [PREV])];
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      before,
      after: [entry("theme.dark", H_THEME_OLD, "Тёмная тема", ["win32"], [PREV, NEXT])],
      previousSnapshots: snapshots(PREV, { win32: settings }),
      currentSnapshots: snapshots(NEXT, { win32: settings }),
    }));
    expect(changelogSection)
      .toContain("Новых переводов не потребовалось; существующий русский каталог подходит к исходным текстам этой версии.");
    expect(changelogSection).not.toContain("theme.dark");
    expect(report).not.toContain("Тёмная тема");
  });

  test("новый sourceHash существующего пути попадает в обновлённые", () => {
    const before = [entry("theme.dark", H_THEME_OLD, "Старое название", ["win32"], [PREV])];
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      before,
      after: [...before, entry("theme.dark", H_THEME_NEW, "Новое название", ["win32"])],
      previousSnapshots: snapshots(PREV, { win32: { "theme.dark": { sourceHash: H_THEME_OLD } } }),
      currentSnapshots: snapshots(NEXT, { win32: { "theme.dark": { sourceHash: H_THEME_NEW } } }),
    }));
    expect(changelogSection).toContain("Обновлены переводы изменившихся настроек: 1 — Новое название (`theme.dark`).");
    expect(changelogSection).not.toContain("Новые настройки на русском");
    expect(changelogSection).not.toContain("Старое название");
    expect(report).toContain("## Обновлены переводы изменившихся настроек (1)");
    expect(report).toContain(`| Новое название | \`theme.dark\` | \`${H_THEME_NEW}\` | win32 |`);
    expect(report).not.toContain(H_THEME_OLD);
  });

  test("рост платформ существующего перевода считается отдельно от новых вариантов", () => {
    const before = [entry("spelling.autocomplete", H_SPELLING, "Автодополнение", ["win32"], [PREV])];
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      before,
      after: [entry("spelling.autocomplete", H_SPELLING, "Автодополнение", ["win32", "linux"], [PREV, NEXT])],
      previousSnapshots: snapshots(PREV, { win32: { "spelling.autocomplete": { sourceHash: H_SPELLING } } }),
      currentSnapshots: snapshots(NEXT, {
        win32: { "spelling.autocomplete": { sourceHash: H_SPELLING } },
        linux: { "spelling.autocomplete": { sourceHash: H_SPELLING } },
      }),
    }));
    expect(changelogSection).toContain("Расширена доступность существующих переводов на платформах: 1 настройка.");
    expect(changelogSection).not.toContain("Новые настройки на русском");
    expect(changelogSection).not.toContain("Обновлены переводы");
    expect(report).toContain("## Расширена доступность существующих переводов (1)");
    // В таблице расширения перечислены только добавленные платформы, а не все платформы варианта.
    expect(report).toContain(`| Автодополнение | \`spelling.autocomplete\` | \`${H_SPELLING}\` | linux |`);
  });

  test("вариант только из observedIn не увеличивает счётчики", () => {
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      after: [entry("legacy.only", H_LEGACY, "Историческая настройка", ["win32"], [PREV])],
    }));
    expect(changelogSection).toContain("Новых переводов не потребовалось;");
    expect(changelogSection).not.toContain("legacy.only");
    expect(changelogSection).not.toContain("Историческая настройка");
    expect(report).not.toContain("Историческая настройка");
  });
});

describe("renderTranslationUpdate: исчезнувшие настройки и пустая дельта", () => {
  test("исчезнувшая из OMP настройка называется, но каталог её сохраняет", () => {
    const before = [entry("removed.setting", H_REMOVED, "Удалённая настройка", ["win32"], [PREV])];
    const input = makeInput({
      before,
      after: before,
      previousSnapshots: snapshots(PREV, {
        win32: { "removed.setting": { sourceHash: H_REMOVED, label: "Removed setting" } },
      }),
    });
    const { changelogSection, report } = renderTranslationUpdate(input);
    expect(changelogSection)
      .toContain(`Больше не доступны в OMP ${NEXT}: 1 настройка; исторические переводы сохранены.`);
    expect(changelogSection).not.toContain("Удалённая настройка");
    expect(changelogSection).not.toMatch(/удал[её]н\w* перевод/i);
    expect(report).toContain(`## Больше не доступны в OMP ${NEXT} (1)`);
    // Название исчезнувшей настройки берётся из снимка старого хоста: это уже не то, что отдаёт новая версия.
    expect(report).toContain("| Removed setting | `removed.setting` | win32 |");
    expect(report).not.toContain("## Новые настройки на русском");
    expect(report).not.toContain("## Обновлены переводы");
    // Ожидание каталога не чистится: исторический перевод остаётся на месте.
    expect(input.after.map(item => item.path)).toContain("removed.setting");
  });

  test("пустая дельта даёт честную строку вместо пустых пунктов", () => {
    const { changelogSection } = renderTranslationUpdate(makeInput());
    expect(changelogSection)
      .toContain("- Новых переводов не потребовалось; существующий русский каталог подходит к исходным текстам этой версии.");
    expect(changelogSection).not.toContain("Новые настройки на русском");
    expect(changelogSection).not.toContain("Обновлены переводы");
    expect(changelogSection).not.toContain("Расширена доступность");
    expect(changelogSection).not.toContain("Больше не доступны");
  });
});

describe("renderTranslationUpdate: формат сводки", () => {
  test("более четырёх названий показывают честный остаток", () => {
    const paths = ["opt.1", "opt.2", "opt.3", "opt.4", "opt.5", "opt.6"];
    const labels = ["Настройка 1", "Настройка 2", "Настройка 3", "Настройка 4", "Настройка 5", "Настройка 6"];
    const after = paths.map((path, index) => entry(path, hash(String(index + 1)), labels[index]!, ["win32"]));
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      after,
      currentSnapshots: snapshots(NEXT, {
        win32: Object.fromEntries(after.map(item => [item.path, { sourceHash: item.sourceHash }])),
      }),
    }));
    expect(changelogSection).toContain(
      "Новые настройки на русском: 6 — Настройка 1 (`opt.1`), Настройка 2 (`opt.2`), Настройка 3 (`opt.3`), "
      + "Настройка 4 (`opt.4`); ещё 2.",
    );
    expect(changelogSection).not.toContain("Настройка 5");
    expect(report).toContain("## Новые настройки на русском (6)");
    expect(report).toContain("Настройка 5");
    expect(report).toContain("Настройка 6");
  });

  test("Markdown, HTML и перевод строки в названии экранируются", () => {
    const tricky = "Тема *тёмная* _новая_ <b>|#\nвторая строка";
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      after: [entry("theme.dark", H_THEME_NEW, tricky, ["win32"])],
      currentSnapshots: snapshots(NEXT, { win32: { "theme.dark": { sourceHash: H_THEME_NEW } } }),
    }));
    const escaped = "Тема \\*тёмная\\* \\_новая\\_ \\<b\\>\\|\\# вторая строка";
    expect(changelogSection).toContain(escaped);
    expect(changelogSection).not.toContain("*тёмная*");
    expect(changelogSection).not.toContain("<b>");
    // Перевод строки внутри названия не создаёт новый пункт списка.
    const bullets = changelogSection.split("\n").filter(line => line.startsWith("- "));
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toContain("вторая строка");
    expect(report).toContain("\\<b\\>");
    expect(report).not.toContain("<b>");
  });

  test("сводка ссылается на полный отчёт и печатает измеренное покрытие", () => {
    const { changelogSection, report } = renderTranslationUpdate(makeInput());
    expect(changelogSection)
      .toContain("Покрытие: 18.8.7 419/419, 18.12.6 419/419.");
    expect(changelogSection)
      .toContain("(https://github.com/narimanisakhanov-creator/omp-settings-ru/blob/v0.7.1/upgrade-report.md)");
    expect(report).toContain("| 18.8.7 | win32 | 419/419 |");
    expect(report).toContain("| 18.12.6 | darwin | 419/419 |");
  });

  test("различное покрытие платформ не усредняется в одно число", () => {
    // README показывает измеренные числа как есть: это таблица фактов, а не утверждение о полноте.
    const block = renderCompatibility(VERSIONS, coverage(VERSIONS, (version, platform) =>
      version === PREV && platform === "linux" ? { complete: 400, total: 419 } : { complete: 419, total: 419 }));
    expect(block).toContain("| 18.8.7 | 419/419 | 400/419 | 419/419 |");
    expect(block).not.toContain("406/419");
  });

  test("неполное покрытие блокирует сводку перевода", () => {
    // Сводка утверждает, что каталог подходит к исходным текстам версии; при complete < total это неправда.
    expect(() => renderTranslationUpdate(makeInput({
      coverage: coverage(VERSIONS, (version, platform) =>
        version === PREV && platform === "linux" ? { complete: 400, total: 419 } : { complete: 419, total: 419 }),
    }))).toThrow("release-content-invalid:coverage-incomplete:18.8.7-linux");
  });
});

describe("renderTranslationUpdate: исторические строки и детерминизм", () => {
  test("исторические неизменённые варианты не попадают в отчёт", () => {
    const before = [
      entry("theme.dark", H_THEME_OLD, "Старое название темы", ["win32"], [PREV]),
      entry("legacy.only", H_LEGACY, "Только историческая", ["win32"], [PREV]),
    ];
    const { changelogSection, report } = renderTranslationUpdate(makeInput({
      before,
      after: [...before, entry("theme.dark", H_THEME_NEW, "Новое название темы", ["win32"])],
      previousSnapshots: snapshots(PREV, { win32: { "theme.dark": { sourceHash: H_THEME_OLD } } }),
      currentSnapshots: snapshots(NEXT, { win32: { "theme.dark": { sourceHash: H_THEME_NEW } } }),
    }));
    expect(report).toContain("Новое название темы");
    expect(report).not.toContain("Старое название темы");
    expect(report).not.toContain("Только историческая");
    expect(report).not.toContain("legacy.only");
    expect(report).not.toContain(H_THEME_OLD);
    expect(changelogSection).not.toContain("Старое название темы");
  });

  test("одинаковый вход даёт те же байты", () => {
    const before = [
      entry("theme.dark", H_THEME_OLD, "Старая тема", ["win32"], [PREV]),
      entry("gone.setting", H_GONE, "Пропавшая", ["win32"], [PREV]),
    ];
    const input = makeInput({
      before,
      after: [...before, entry("theme.dark", H_THEME_NEW, "Новая тема", ["win32"]), entry("fresh.setting", H_FRESH, "Свежая", ["win32"])],
      previousSnapshots: snapshots(PREV, {
        win32: { "theme.dark": { sourceHash: H_THEME_OLD }, "gone.setting": { sourceHash: H_GONE } },
      }),
      currentSnapshots: snapshots(NEXT, {
        win32: { "theme.dark": { sourceHash: H_THEME_NEW }, "fresh.setting": { sourceHash: H_FRESH } },
      }),
    });
    const first = renderTranslationUpdate(input);
    const second = renderTranslationUpdate(input);
    expect(first.changelogSection).toContain("Новые настройки на русском: 1 — Свежая (`fresh.setting`).");
    expect(first.changelogSection).toContain("Обновлены переводы изменившихся настроек: 1 — Новая тема (`theme.dark`).");
    expect(first.changelogSection).toContain(`Больше не доступны в OMP ${NEXT}: 1 настройка`);
    expect(second.changelogSection).toBe(first.changelogSection);
    expect(second.report).toBe(first.report);
    const coveragePairs = coverage(VERSIONS);
    expect(renderCompatibility(VERSIONS, coveragePairs)).toBe(renderCompatibility(VERSIONS, coveragePairs));
  });
});

describe("renderTranslationUpdate: отказы вместо нулей", () => {
  test("пропущенный снимок платформы блокирует сводку", () => {
    const input = makeInput({ currentSnapshots: snapshots(NEXT).filter(snapshot => snapshot.platform !== "darwin") });
    expect(() => renderTranslationUpdate(input)).toThrow("release-content-invalid:snapshot-missing:current-darwin");
  });

  test("несовпадающая версия снимка блокирует сводку", () => {
    expect(() => renderTranslationUpdate(makeInput({ previousSnapshots: snapshots(NEXT) })))
      .toThrow("release-content-invalid:snapshot-version-mismatch:previous-win32");
  });

  test("пропущенное покрытие версии блокирует сводку", () => {
    const incomplete = coverage(VERSIONS).filter(pair => !(pair.version === NEXT && pair.platform === "linux"));
    expect(() => renderTranslationUpdate(makeInput({ coverage: incomplete })))
      .toThrow("release-content-invalid:coverage-missing:18.12.6-linux");
  });

  test("версия вне набора покрытия блокирует сводку", () => {
    expect(() => renderTranslationUpdate(makeInput({ upstreamVersion: "18.13.0" })))
      .toThrow("release-content-invalid:version-missing:18.13.0");
  });

  test("используемый вариант обязан существовать в каталоге", () => {
    const input = makeInput({
      currentSnapshots: snapshots(NEXT, { win32: { "ghost.setting": { sourceHash: H_GHOST } } }),
    });
    expect(() => renderTranslationUpdate(input))
      .toThrow(`release-content-invalid:catalog-variant-missing:ghost.setting:${H_GHOST}`);
  });

  test("используемый вариант обязан быть объявлен на платформе", () => {
    const input = makeInput({
      after: [entry("ghost.setting", H_GHOST, "Призрак", ["darwin"])],
      currentSnapshots: snapshots(NEXT, { win32: { "ghost.setting": { sourceHash: H_GHOST } } }),
    });
    expect(() => renderTranslationUpdate(input))
      .toThrow("release-content-invalid:catalog-platform-missing:ghost.setting:win32");
  });

  test("пустой label блокирует сводку", () => {
    const input = makeInput({
      after: [entry("ghost.setting", H_GHOST, "", ["win32"])],
      currentSnapshots: snapshots(NEXT, { win32: { "ghost.setting": { sourceHash: H_GHOST } } }),
    });
    expect(() => renderTranslationUpdate(input)).toThrow("release-content-invalid:label-empty:ghost.setting");
  });
});

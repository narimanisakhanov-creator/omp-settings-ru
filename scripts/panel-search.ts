/**
 * The RU settings-search step shared by the native PTY sessions (`distribution-session.ts`,
 * `smoke-installed-worker.ts`) and the in-process panel proof (`smoke-panel-worker.ts`).
 *
 * The panel re-ranks its fuzzy corpus on every keystroke, so the searched label is rendered long before
 * the selection reaches it; pressing Enter at that moment edits a different setting, and the following
 * observation never matches. The host's own banner count is the settled condition: it reads
 * `1 match` only when the searched row is the single row Enter can activate.
 *
 * The wait is deliberately independent of both the pointer glyph and any assumed starting value:
 *
 * - Glyph: `nav.cursor` is `❯` for the unicode preset, U+F054 for nerd and `>` for ascii
 *   (`@oh-my-pi/pi-tui/src/theme/symbols.ts:403,715,1182`). The rendered preset is a layer of its own: a
 *   confirmed Glyph Protocol handshake upgrades an unconfigured session's *rendered* preset while the
 *   persisted setting is left alone (`omp-host-1887/src/modes/interactive-mode.ts:2451-2462`), so the
 *   rendered preset can differ from the setting. The failing dispatches showed both shapes — the footer
 *   rendered nerd key glyphs (U+F0311/U+F0312/U+F12B7) on 2026-10-09 and ascii key words
 *   (`Enter to change · Tab to jump tabs · Esc to exit search`) on 2026-10-10 — while every wait pattern
 *   here assumed the unicode pointer.
 * - Value: a profile can carry a stale value from an earlier session, so the step reads the value the
 *   settled row shows and asserts the flip it performs instead of assuming `false`.
 */

export const RU_SEARCH_QUERY = "Скорость генерации";
/**
 * The banner count of exactly one, bounded on both sides so a still-narrowing list (`11 matches`) can never
 * satisfy a settled wait, followed by whatever the frame must also show. Shared by both settled patterns so
 * they cannot drift apart.
 */
const SETTLED = "(?<!\\d)1 match(?!es)[\\s\\S]*";
export const RU_SEARCH_SETTLED = new RegExp(`${SETTLED}Скорость генерации`);
export const RU_SEARCH_TRUE = /Скорость генерации\s+true/;
export const RU_SEARCH_FALSE = /Скорость генерации\s+false/;

/**
 * The value the settled row shows, plus the patterns proving one toggle landed and the original came back.
 * Refuses to guess: an unobserved value and an ambiguous frame (both values rendered) are both errors.
 */
export function searchToggle(surface: string): {current: "true" | "false"; flipped: RegExp; restored: RegExp} {
  const on = RU_SEARCH_TRUE.test(surface);
  const off = RU_SEARCH_FALSE.test(surface);
  if (on === off) throw new Error(`native-search-value-unobserved:true=${on},false=${off}`);
  return on
    ? {current: "true", flipped: RU_SEARCH_FALSE, restored: RU_SEARCH_TRUE}
    : {current: "false", flipped: RU_SEARCH_TRUE, restored: RU_SEARCH_FALSE};
}

/** The glyph-set enum (`symbolPreset`, values in list order) proved through its own row, not a key count. */
export const GLYPH_PRESETS = ["unicode", "nerd", "ascii"] as const;
export type GlyphPreset = (typeof GLYPH_PRESETS)[number];
export const RU_ENUM_QUERY = "Набор символов";
export const RU_ENUM_SETTLED = new RegExp(`${SETTLED}Набор символов\\s+(?:${GLYPH_PRESETS.join("|")})`);

/** The glyph-set value the settled row shows, or undefined when the row does not render a known value. */
export function glyphPreset(surface: string): GlyphPreset | undefined {
  return new RegExp(`Набор символов\\s+(${GLYPH_PRESETS.join("|")})`).exec(surface)?.[1] as GlyphPreset | undefined;
}

/** The key that moves off `current`. Up for the last option avoids depending on list clamping or wrapping. */
export function glyphKeyAway(current: GlyphPreset): "\x1b[B" | "\x1b[A" {
  return current === GLYPH_PRESETS[GLYPH_PRESETS.length - 1] ? "\x1b[A" : "\x1b[B";
}

/** The option one step from `current` in that direction — asserted exactly, so a skipped or clamped move fails. */
export function glyphTarget(current: GlyphPreset, away: "\x1b[B" | "\x1b[A"): GlyphPreset {
  const target = GLYPH_PRESETS[GLYPH_PRESETS.indexOf(current) + (away === "\x1b[B" ? 1 : -1)];
  if (target === undefined) throw new Error(`native-glyph-target-unavailable:${current}`);
  return target;
}

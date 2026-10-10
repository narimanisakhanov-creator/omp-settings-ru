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
 *   (`@oh-my-pi/pi-tui/src/theme/symbols.ts:403,715,1182`), and a confirmed Glyph Protocol handshake
 *   upgrades an unconfigured session from unicode to nerd (`omp-host-1887/src/modes/interactive-mode.ts:2451-2462`).
 *   The failing marketplace-index dispatch of 2026-10-09 rendered the nerd footer glyphs
 *   (U+F0311/U+F0312/U+F12B7) instead of `⏎/⇥/⎋`, so a `❯`-anchored wait could never match there.
 * - Value: a profile can carry a stale value from an earlier session, so the step reads the value the
 *   settled row shows and asserts the flip it performs instead of assuming `false`.
 */

export const RU_SEARCH_QUERY = "Скорость генерации";
/** The banner count of exactly one, and the searched row rendered. No glyph or value assumption. */
export const RU_SEARCH_SETTLED = /(?<!\d)1 match(?!es)[\s\S]*Скорость генерации/;
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

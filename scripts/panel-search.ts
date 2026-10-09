/**
 * The RU settings-search step shared by the native PTY session (`distribution-session.ts`) and the
 * in-process panel proof (`smoke-panel-worker.ts`).
 *
 * The panel ranks its fuzzy corpus on every keystroke, so a matching row is already rendered while
 * the list is still narrowing and the pointer sits on another row. A wait that only matches the
 * label can therefore return before the row it is about to activate is the selected one, and the
 * following Enter edits a different setting. Every wait below is anchored to the pointer (❯), which
 * only the settled list puts on the target row.
 */

export const RU_SEARCH_QUERY = "Скорость генерации";
export const RU_SEARCH_OFF = /❯\s*Скорость генерации.*false/;
export const RU_SEARCH_ON = /❯\s*Скорость генерации.*true/;

// Source templates reviewed against OMP 18.6.1; key hints remain owned by the host.
export const descriptionTemplates: Readonly<Record<string, string>> = {
  "tui.codexResetFireworks": "Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until {escape}",
  "doubleEscapeAction": "What pressing {escape} twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing",
  "spelling.autocomplete": "Show predicted word completions as inline hints: {accept} accepts with a space, {right} without",
  "tui.mouse": "Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes {shift}+drag and wheel scroll becomes {shift}+wheel while on",
  "retry.waitForUsageReset": "When a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), sleep until the reset instead of failing fast past retry.maxDelayMs. Waits are abortable ({escape}) but also hold subagents, so leave off for unattended runs.",
  "tui.vimMode": "Modal prompt editing. {escape} leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes",
  "composer.recallClearedDrafts": "Keep drafts cleared with {clear} in local {history} history until exit; disabling affects future clears",
};

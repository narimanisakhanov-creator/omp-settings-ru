// Reviewed English source templates; key hints remain owned by the host. Each value lists the accepted
// editions of one description, oldest first and newest last, because editions are additive: a shipped
// snapshot must keep its sourceHash, so an upstream rewording adds an edition instead of replacing one.
// A live text that matches no edition is a degradation, not a refusal: it keeps its raw source identity
// and is translated without live hint substitution until a human adds the edition.
export const descriptionTemplates: Readonly<Record<string, readonly string[]>> = {
  "tui.codexResetFireworks": [
    "Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until {escape}",
  ],
  "doubleEscapeAction": [
    "What pressing {escape} twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing",
  ],
  "spelling.autocomplete": [
    "Show predicted word completions as inline hints: {accept} accepts with a space, {right} without",
  ],
  "tui.mouse": [
    "Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes {shift}+drag and wheel scroll becomes {shift}+wheel while on",
    "Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target, and clicks on extension-owned links reach their extension (the link-hint key picks them without the mouse). Native text selection becomes {shift}+drag and wheel scroll becomes {shift}+wheel while on",
  ],
  "retry.waitForUsageReset": [
    "When a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), sleep until the reset instead of failing fast past retry.maxDelayMs. Waits are abortable ({escape}) but also hold subagents, so leave off for unattended runs.",
  ],
  "tui.vimMode": [
    "Modal prompt editing. {escape} leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes",
  ],
  "composer.recallClearedDrafts": [
    "Keep drafts cleared with {clear} in local {history} history until exit; disabling affects future clears",
  ],
  "composer.predictions": [
    "After a completed turn, ask the active model to predict your next message and show it as ghost text in the empty composer; Tab or Right inserts it without sending. Extra usage: every completed turn sends one more billed request over the whole conversation (counted in /stats)",
  ],
};

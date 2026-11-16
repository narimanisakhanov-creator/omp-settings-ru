import { expect, test } from "bun:test";
import { cleanTerminalOutput, terminalObservationSummary, terminalObservationFailure } from "../scripts/terminal-output";

// Regresses a greedy OSC body swallowing the status line when a later welcome
// repaint emits another ST-terminated hyperlink. These are accumulated PTY bytes,
// not a terminal screen: unchanged status rows need not be written again.
test("OSC hyperlinks in later redraws do not erase the observed offline model marker", () => {
  const output = "\x1b]8;;https://omp.sh\x1b\\omp\x1b]8;;\x1b\\\r\n"
    + "\x1b[36mno-model\x1b[0m\r\nchange thinking effort\r\n"
    + "\x1b[4A████████████\r\n\x1b]8;;https://omp.sh/tips\x1b\\Tip\x1b]8;;\x1b\\";
  expect(cleanTerminalOutput(output)).toBe("omp\r\nno-model\r\nchange thinking effort\r\n████████████\r\nTip");
});

test("BEL and ST each end their own OSC without swallowing visible text", () => {
  expect(cleanTerminalOutput("\x1b]0;title\x07before\x1b]8;;https://omp.sh\x1b\\link\x1b]8;;\x1b\\after"))
    .toBe("beforelinkafter");
});

test("control cleanup cannot manufacture the required no-model marker", () => {
  expect(cleanTerminalOutput("\x1b]0;no-model\x1b\\\x1b[32m████\x1b[0m")).toBe("████");
});

// Contiguous footer/hint bytes from the isolated Linux 18.20.3 capture at
// 150x44, profile omp-settings-ru-proof-ci-18-20-3 (2026-11-16).
const nativeStartupFooter = "\x1b[48;5;233;39m \x1b[38;5;243mπ-omp-settings-ru-proof-ci-18-20-3\x1b[39m \x1b[38;5;236m>\x1b[39m \x1b[38;5;39m⬢ no-model\x1b[39m \x1b[38;5;236m>\x1b[39m \x1b[38;5;255m🗑 /tmp\x1b[39m \x1b[38;5;236m>\x1b[39m ◫ \x1b[38;5;248m1.8K/?\x1b[39m \x1b[38;5;248m⟲\x1b[39m \x1b[0;38;5;233m▶\x1b[0;49;38;5;39m──────────────────────────────────────────────────────────────────────────────\x1b[39m\x1b[0m\r\r\n\x1b[0m\x1b[K\x1b[38;5;39m╰─ \x1b[39;38;5;254m                                                                                                                       \x1b[38;5;39m⇧⇥\x1b[39;38;5;254m \x1b[38;5;243;3mto change thinking effort\x1b[23;39;38;5;254;39m\x1b[0m\r\x1b[14;1H\x1b[J\x1b[13;4H\x1b[?25h\x1b[?7h";

test("failure diagnostics distinguish observed native markers from a discarded observation window", () => {
  const summary = terminalObservationSummary(nativeStartupFooter, nativeStartupFooter.length);
  expect(summary.units).toBe("utf16");
  expect(summary.markers.noModel.raw.count).toBe(1);
  expect(summary.markers.noModel.clean.count).toBe(1);
  expect(summary.markers.noModel.window.count).toBe(0);
  expect(summary.markers.hint.raw.count).toBe(1);
  expect(summary.markers.setup.raw.count).toBe(0);
});

test("failure diagnostics distinguish OSC payloads from visible model markers", () => {
  const summary = terminalObservationSummary("\x1b]0;no-model\x07", 0);
  expect(summary.markers.noModel.raw.count).toBe(1);
  expect(summary.markers.noModel.clean.count).toBe(0);
  expect(summary.markers.noModel.window.first).toBe(-1);
});

test("failure diagnostics retain a bounded reset chronology without losing the total", () => {
  const resets = Array.from({length:12}, (_, index) => ({at:index,from:index,to:index+1}));
  const summary = terminalObservationSummary(nativeStartupFooter, 0, resets);
  expect(summary.setupResetCount).toBe(12);
  expect(summary.setupResets).toHaveLength(8);
  expect(summary.setupResets[0]).toEqual({at:4,from:4,to:5});
  expect(summary.setupResets[7]).toEqual({at:11,from:11,to:12});
  expect(summary.markers.noModel.window.count).toBe(1);
});

test("timeout evidence survives the outer 4000-character stderr tail", () => {
  const raw = "startup-header\n" + nativeStartupFooter + "\n" + "logo-redraw\n".repeat(1000);
  const payload = terminalObservationFailure(raw, raw.length);
  const outer = ("Error: native-timeout:" + payload + "\n" + "stack-frame\n".repeat(100)).slice(-4000);
  expect(payload.length).toBeLessThanOrEqual(2600);
  expect(outer).toContain("startup-header");
  expect(outer).toContain("rawControls");
  expect(outer).toContain("no-model");
  expect(JSON.parse(payload).markers.noModel.windowRaw).toEqual([0,-1,-1]);
});

test("timeout diagnostics redact owned paths and never expose OSC payloads", () => {
  const paths = ["/tmp/private-home", "C:\\private\\plugin", "/private/source"];
  const raw = paths.join("\n") + "\n\x1b]0;https://private.example/secret/no-model\x07";
  const payload = terminalObservationFailure(raw, 0, [], 0, paths);
  const evidence = JSON.parse(payload);
  for(const path of paths)expect(payload).not.toContain(path);
  expect(payload).not.toContain("private");
  expect(payload).not.toContain("private.example");
  expect(payload).not.toContain("secret");
  expect(evidence.markers.noModel.raw).toEqual([1,raw.indexOf("no-model"),raw.indexOf("no-model")]);
  expect(evidence.markers.noModel.clean).toEqual([0,-1,-1]);
  expect(evidence.rawControls).toContainEqual({offset:raw.indexOf("\x1b]"),end:raw.length,kind:"OSC",type:"0",terminator:"BEL"});
});

test("timeout excerpts omit incomplete OSC and application-control payloads", () => {
  const raw = "safe-header\n\x1b_private-apc-url\x1b\\no-model\n\x1b]8;;private-incomplete-url";
  const evidence = JSON.parse(terminalObservationFailure(raw, 0));
  expect(evidence.head).toContain("safe-header");
  expect(evidence.head).toContain("no-model");
  expect(JSON.stringify(evidence)).not.toContain("private");
});

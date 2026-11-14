import { expect, test } from "bun:test";
import { cleanTerminalOutput } from "../scripts/terminal-output";

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

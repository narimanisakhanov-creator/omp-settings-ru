import { PtySession } from "@oh-my-pi/pi-natives";
import { RU_ENUM_QUERY, RU_ENUM_SETTLED, RU_SEARCH_QUERY, RU_SEARCH_SETTLED, glyphKeyAway, glyphPreset, glyphTarget, searchToggle } from "./panel-search";

/**
 * Drive a real installed OMP through `/settings` in one profile and report what was observed.
 *
 * RU mode exercises the translated surface beyond the theme labels: Russian search
 * filtering, a real boolean change and restore with observed technical values, an
 * enum submenu change and restore, and a real ru→en→ru language cycle whose
 * expected confirmation is awaited before the panel is reopened. EN mode proves a
 * plain English session. Steps are reported individually so a partial run is never
 * mistaken for a pass.
 */

const [executable, profile, mode] = process.argv.slice(2) as [string, string, "ru" | "en" | "boot"];
if (executable === undefined || profile === undefined || (mode !== "ru" && mode !== "en" && mode !== "boot")) throw new Error("distribution-session-usage");
const observations: {kind: string; output: string}[] = [];
const clean = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>]/g, "");

class Session {
  readonly pty = new PtySession();
  text = "";
  offset = 0;
  run: Promise<unknown>;
  constructor() {
    this.run = this.pty.startArgv({application: executable, args: ["--profile", profile, "--no-session", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-title"], cwd: process.cwd(), cols: 150, rows: 44, timeoutMs: 180000}, (error, chunk) => {if (error) throw error;this.text += chunk;});
  }
  async wait(pattern: RegExp, timeout = 45000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = clean(this.text.slice(this.offset));
      if (pattern.test(text)) {await Bun.sleep(150);return clean(this.text.slice(this.offset));}
      if (/Setup step/.test(text)) {this.offset = this.text.length;this.pty.write("\x1b");await Bun.sleep(400);continue;}
      await Bun.sleep(50);
    }
    throw new Error("native-session-timeout:" + pattern.source + ":" + clean(this.text.slice(this.offset)).slice(-1800));
  }
  async send(text: string, pattern: RegExp): Promise<string> {this.offset = this.text.length;this.pty.write(text);return this.wait(pattern);}
  async escape() {this.offset = this.text.length;this.pty.write("\x1b");await Bun.sleep(300);}
  async close() {this.pty.kill();await this.run;}
}

const steps: {step: string; status: "ok" | "failed"; detail: string}[] = [];
async function step(name: string, action: (session: Session) => Promise<string>): Promise<void> {
  const session = new Session();
  try {
    await session.wait(/change thinking effort/);
    const detail = await action(session);
    steps.push({step: name, status: "ok", detail: detail.slice(-1200)});
  } catch (error) {
    steps.push({step: name, status: "failed", detail: error instanceof Error ? error.message : String(error)});
    throw error;
  } finally {
    await session.close();
  }
}

function line(text: string, pattern: RegExp): string {
  const found = text.split("\n").find(candidate => pattern.test(candidate));
  if (found === undefined) throw new Error("native-session-line-missing:" + pattern.source);
  return found;
}

if (mode === "boot") {
  // The launched OMP runs its marketplace auto-update in the background. Announce that the
  // session really reached the prompt, then stay alive until the parent has observed the
  // installed registry/catalog reach its expected state and closes our stdin. A fixed sleep
  // would either kill a slow clone mid-flight or let a mode look proven before startup ran.
  const session = new Session();
  try {
    await session.wait(/change thinking effort/);
    const started = Date.now();
    process.stdout.write(JSON.stringify({mode, ready: true}) + "\n");
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({mode, steps, ok: true, waitedMs: Date.now() - started}));
  } finally {
    await session.close();
  }
} else if (mode === "en") {
  try {
    await step("en-panel", async session => {
      const panel = await session.send("/settings\r", /Dark Theme/);
      return line(panel, /Dark Theme/);
    });
    console.log(JSON.stringify({mode, steps, ok: steps.every(entry => entry.status === "ok")}));
  } catch (error) {
    console.log(JSON.stringify({mode, steps, ok: false, error: String(error)}));
    process.exitCode = 1;
  }
} else {
  try {
    await step("ru-search-and-boolean", async session => {
      const panel = await session.send("/settings\r", /Тёмная тема/);
      const search = await session.send(RU_SEARCH_QUERY, RU_SEARCH_SETTLED);
      const toggle = searchToggle(search);
      observations.push({kind: "ru-search", output: line(search, /Скорость генерации/) });
      const toggled = await session.send("\r", toggle.flipped);
      observations.push({kind: "ru-boolean-toggled", output: line(toggled, /Скорость генерации/) });
      const restored = await session.send("\r", toggle.restored);
      observations.push({kind: "ru-boolean-restored", output: line(restored, /Скорость генерации/) });
      return [line(panel, /Тёмная тема/), ...observations.slice(-3).map(entry => entry.output)].join("\n");
    });
    await step("ru-enum", async session => {
      await session.send("/settings\r", /Тёмная тема/);
      const searched = await session.send(RU_ENUM_QUERY, RU_ENUM_SETTLED);
      const before = glyphPreset(searched);
      if (!before) throw new Error("native-glyph-preset-unobserved:" + line(searched, /Набор символов/));
      const opened = await session.send("\r", /Unicode|Юникод|ASCII/);
      observations.push({kind: "ru-enum-options", output: opened.split("\n").filter(candidate => /Unicode|Юникод|ASCII|Максимальная/.test(candidate)).join("\n")});
      const away = glyphKeyAway(before);
      const target = glyphTarget(before, away);
      const changed = await session.send(`${away}\r`, new RegExp(`Набор символов\\s+${target}\\b`));
      observations.push({kind: "ru-enum-changed", output: line(changed, /Набор символов/) });
      await session.send("\r", /Unicode|Юникод|ASCII/);
      const restored = await session.send(`${away === "\x1b[B" ? "\x1b[A" : "\x1b[B"}\r`, new RegExp(`Набор символов\\s+${before}\\b`));
      observations.push({kind: "ru-enum-restored", output: line(restored, /Набор символов/) });
      return observations.slice(-3).map(entry => entry.output).join("\n");
    });
    await step("ru-en-language-cycle", async session => {
      await session.send("/settings\r", /Тёмная тема/);
      await session.escape();
      const toEnglish = await session.send("/settings-language en\r", /Язык настроек: English/);
      const english = await session.send("/settings\r", /Dark Theme/);
      await session.escape();
      const toRussian = await session.send("/settings-language ru\r", /Язык настроек: русский/);
      const russian = await session.send("/settings\r", /Тёмная тема/);
      observations.push({kind: "language-cycle", output: [toEnglish, line(english, /Dark Theme/), toRussian, line(russian, /Тёмная тема/)].join("\n")});
      return observations.at(-1)!.output;
    });
    console.log(JSON.stringify({mode, steps, observations, ok: steps.every(entry => entry.status === "ok")}));
  } catch (error) {
    console.log(JSON.stringify({mode, steps, observations, ok: false, error: String(error)}));
    process.exitCode = 1;
  }
}

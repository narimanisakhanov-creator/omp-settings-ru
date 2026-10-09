import { PtySession } from "@oh-my-pi/pi-natives";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [executable, profile, pluginPath, home] = process.argv.slice(2) as [string, string, string, string];
const observations: {kind: string; output: string}[] = [];
const agentDir = join(home, ".omp", "profiles", profile, "agent");
await mkdir(agentDir, {recursive: true});
await writeFile(join(agentDir, "config.yml"), "startup:\n  setupWizard: false\n");
const clean = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>]/g, "");
function native(args: string[]) {
  const result = Bun.spawnSync([executable, "--profile", profile, ...args], {env: process.env, stdout:"pipe",stderr:"pipe",timeout:30000});
  if (result.exitCode !== 0) throw new Error("native-profile-operation-failed");
  return result.stdout.toString();
}
native(["plugin","link",pluginPath]);
const listed = JSON.parse(native(["plugin","list","--json"]));
if (!listed.npm?.some((plugin: {name: string;enabled: boolean}) => plugin.name === "omp-settings-ru" && plugin.enabled)) throw new Error("owned-native-install-unverified");

class Session {
  readonly pty = new PtySession();
  text = "";
  offset = 0;
  run: Promise<unknown>;
  constructor(noExtensions = false) {
    this.run = this.pty.startArgv({application:executable,args:["--profile",profile,...(noExtensions?["--no-extensions"]:["--plugin-dir",pluginPath]),"--no-session","--no-skills","--no-rules","--no-tools","--no-lsp","--no-title"],cwd:home,cols:150,rows:44,timeoutMs:120000},(error,chunk)=>{if(error)throw error;this.text+=chunk;});
  }
  async wait(pattern: RegExp, timeout = 15000): Promise<string> {
    const deadline = Date.now()+timeout;
    while (Date.now()<deadline) {
      const text = clean(this.text.slice(this.offset));
      if (pattern.test(text)) {await Bun.sleep(150);return clean(this.text.slice(this.offset));}
      if (/Setup step/.test(text)) {this.offset=this.text.length;this.pty.write("\x1b");await Bun.sleep(400);continue;}
      await Bun.sleep(50);
    }
    throw new Error("native-panel-observation-timeout:"+pattern.source+":"+clean(this.text.slice(this.offset)).slice(-1800));
  }
  async send(text: string, pattern: RegExp): Promise<string> {this.offset=this.text.length;this.pty.write(text);return this.wait(pattern);}
  async escape() {this.pty.write("\x1b");await Bun.sleep(300);}
  async close() {this.pty.kill();await this.run;}
}
const session = new Session();
try {
  const startup=await session.wait(/change thinking effort/);
  if (/omp-settings-ru:/.test(startup)) throw new Error("compatibility-refusal-observed");
  if (!/no-model/.test(startup)) throw new Error("neutral-offline-header-unobserved");
  observations.push({kind:"startup",output:startup.split("\n").filter(line=>/no-model|No default model/.test(line)).join("\n")});
  if (process.argv.includes("--startup-only")) {
    const panel=await session.send("/settings\r",/Dark Theme|Тёмная тема/);
    observations.push({kind:"settings-panel",output:panel.split("\n").filter(line=>/Dark Theme|Тёмная тема|Light Theme|Светлая тема/.test(line)).join("\n")});
    await session.close();
    console.log(JSON.stringify({installedPanel:false,startupPassed:true,observations,isolation:{ambientCredentialInherited:process.env.OMP_SMOKE_PRIVATE_SENTINEL!==undefined,homeIsolated:true,providerRoundTrip:false}}));
    process.exit(0);
  }
  const russian=await session.send("/settings\r",/Тёмная тема/);
  observations.push({kind:"ru-panel",output:russian.split("\n").filter(line=>/Тёмная тема|Светлая тема|Набор символов/.test(line)).join("\n")});
  const search=await session.send("скорость",/Скорость генерации.*false/);
  observations.push({kind:"ru-search",output:search.split("\n").filter(line=>/скорость|Скорость генерации/.test(line)).join("\n")});
  const on=await session.send("\r",/Скорость генерации.*true/);
  observations.push({kind:"bool-change",output:on.split("\n").find(line=>/Скорость генерации/.test(line))!});
  const off=await session.send("\r",/Скорость генерации.*false/);
  observations.push({kind:"bool-restored",output:off.split("\n").find(line=>/Скорость генерации/.test(line))!});
  await session.escape();
  await session.send("набор символов",/Набор символов/);
  await session.send("\r",/Unicode|Юникод|ASCII/);
  const enumChanged=await session.send("\x1b[B\r",/Набор символов\s+nerd/);
  observations.push({kind:"enum-change",output:enumChanged.split("\n").find(line=>/Набор символов\s+nerd/.test(line))!});
  await session.send("\r",/Unicode|Юникод|ASCII/);
  const enumRestored=await session.send("\x1b[A\r",/Набор символов\s+unicode/);
  observations.push({kind:"enum-restored",output:enumRestored.split("\n").find(line=>/Набор символов\s+unicode/.test(line))!});
  await session.escape();await session.escape();
  await session.send("/settings-language en\r",/Язык настроек: English/);
  const english=await session.send("/settings\r",/Dark Theme/);
  observations.push({kind:"en-panel",output:english.split("\n").filter(line=>/Dark Theme|Generation Rate|Light Theme/.test(line)).join("\n")});
  await session.escape();
  await session.send("/settings-language ru\r",/Язык настроек: русский/);
  const reapplied=await session.send("/settings\r",/Тёмная тема/);
  observations.push({kind:"ru-reapplied",output:reapplied.split("\n").filter(line=>/Тёмная тема/.test(line)).join("\n")});
  await session.escape();
  const reset=await session.send("/settings-language en\r",/Язык настроек: English/);
  observations.push({kind:"explicit-en-reset",output:reset.split("\n").filter(line=>/Язык настроек: English/.test(line)).join("\n")});
} finally {await session.close();}
const fresh = new Session(true);
try {
  await fresh.wait(/change thinking effort/);
  const output=await fresh.send("/settings\r",/Dark Theme/);
  observations.push({kind:"fresh-english-no-extensions",output:output.split("\n").filter(line=>/Dark Theme|Light Theme/.test(line)).join("\n")});
} finally {await fresh.close();}
console.log(JSON.stringify({installedPanel:true,observations,isolation:{ambientCredentialInherited:process.env.OMP_SMOKE_PRIVATE_SENTINEL!==undefined,homeIsolated:true,providerRoundTrip:false}}));

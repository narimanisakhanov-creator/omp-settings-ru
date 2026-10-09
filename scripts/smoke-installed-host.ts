import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalContentHash, executableIdentity, runInstalledSmoke } from "./installed-smoke";

const args = process.argv.slice(2);
function option(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
if (args.includes("--help")) {
  console.log("bun scripts/smoke-installed-host.ts --executable <installed binary> [--preflight|--exercise|--startup-only|--launch] [--plugin <verified path>] [--profile <owned name>] [--cwd <isolated home>] [--output <receipt>]\n--exercise drives the real native panel; --startup-only observes startup and panel without a translation coverage claim; --launch hands visible pixels to capture.");
  process.exit(0);
}
const executable = option("--executable") ?? (process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? "", "omp", "omp.exe") : join(homedir(), ".local", "bin", "omp"));
const pluginPath = resolve(option("--plugin") ?? ".");
const profile = option("--profile") ?? `omp-settings-ru-proof-${randomUUID().slice(0, 8)}`;
if (!/^omp-settings-ru-proof-[a-zA-Z0-9-]+$/.test(profile)) throw new Error("refusing-unowned-profile");
const environment: Record<string, string> = {};
for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME"]) if (process.env[key]) environment[key] = process.env[key]!;
function native(argv: string[]): string {
  const result = Bun.spawnSync([executable, "--profile", profile, ...argv], {env: environment, stdout: "pipe", stderr: "pipe", timeout: 30000});
  if (result.exitCode !== 0) throw new Error("native-command-failed");
  return result.stdout.toString();
}
const version = native(["--version"]).trim();
const hostVersion = /^omp\/(\d+\.\d+\.\d+)$/.exec(version)?.[1];
if (!hostVersion) throw new Error("unrecognized-installed-host");
const help = native(["--help"]);
if (!help.includes("--profile") || !help.includes("isolated profile")) throw new Error("profile-isolation-unverified");
const manager = native(["plugin", "install", "--help"]);
if (!manager.includes("link") || !manager.includes("list")) throw new Error("native-manager-unavailable");
native(["plugin", "link", pluginPath]);
const listing = JSON.parse(native(["plugin", "list", "--json"]));
const plugin = listing.npm?.find((entry: {name: string}) => entry.name === "omp-settings-ru");
if (!plugin?.enabled || !plugin.manifest?.extensions?.includes("./src/index.ts")) throw new Error("isolated-plugin-install-failed");
native(["plugin", "doctor"]);
const executableSha256 = await executableIdentity(executable);
const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], {stdout: "pipe", stderr: "pipe"});
const sourceSha = source.exitCode === 0 ? source.stdout.toString().trim() : undefined;
const {path: _privatePath, ...redactedPlugin} = plugin;
// contentHash is the canonical identity of the loaded package directory; it is not the release archive SHA.
const contentHash = await canonicalContentHash(pluginPath);
const receipt: Record<string, unknown> = {hostVersion, platform: process.platform, arch: process.arch, executableSha256, contentHash, sourceSha, sourceIdentity: "uncommitted working tree; source SHA is base provenance, not modified tree identity", profile, plugin: redactedPlugin, installedPanel: false, versionOutput: version};
if (args.includes("--exercise") || args.includes("--startup-only")) Object.assign(receipt, await runInstalledSmoke({executable,pluginPath,ownedProfile:profile,isolatedCwd:option("--cwd"),mode:"pre-activation",startupOnly:args.includes("--startup-only")}));
if (args.includes("--launch")) {
  // CLI requires a shell command, values quoted literally; no PR text participates.
  const quote = (value: string) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${process.platform === "win32" ? "& " : ""}${quote(executable)} --profile ${quote(profile)} --no-session --no-skills --no-rules --no-tools --no-lsp --no-title`;
  const launched = Bun.spawnSync(["orca", "terminal", "create", "--worktree", "current", "--title", "owned installed OMP maintenance smoke", "--command", command, "--json"], {stdout: "pipe", stderr: "pipe", timeout: 30000});
  if (launched.exitCode !== 0) throw new Error("owned-pty-launch-failed");
  const terminal = JSON.parse(launched.stdout.toString()).result?.terminal;
  if (!terminal?.handle) throw new Error("owned-pty-unverifiable");
  receipt.terminal = {handle: terminal.handle, incarnationId: terminal.incarnationId};
  receipt.observationsRequired = ["startup-no-refusal", "settings-language-registration", "ru-settings", "ru-search", "bool-enum-roundtrip", "en-restoration", "fresh-session", "actual-pixels"];
}
if (option("--output")) await Bun.write(option("--output")!,JSON.stringify(receipt,null,2)+"\n");
console.log(JSON.stringify(receipt, null, 2));

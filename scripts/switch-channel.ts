import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * State-preserving channel switch for `omp-settings-ru`.
 *
 * Native uninstall drops this package's own runtime state, so the switch backs the
 * own entry up first and merges it back after the alternative channel installs.
 * Only this package's own key is ever touched: the rest of the lock is carried
 * through byte-for-byte, so foreign plugins/settings and unknown fields survive.
 * If the alternative install fails, any partial alternative is removed first and
 * the original channel plus its own state are restored; if that is impossible the
 * exact retained backup path is reported instead of claiming success.
 */

export const PACKAGE_NAME = "omp-settings-ru";
export const NPM_REPOSITORY = "narimanisakhanov-creator/omp-settings-ru";

export type Channel = "npm" | "marketplace";

export interface PluginState {
  readonly version: string;
  readonly enabled: boolean;
  readonly enabledFeatures: readonly string[] | null;
}

export interface ChannelBackup {
  readonly source: Channel;
  readonly profile: string;
  readonly state: PluginState;
  readonly settings?: unknown;
}

/** The raw lock document plus the two named maps the runtime config owns. */
export interface RuntimeLock {
  readonly document: { [key: string]: unknown };
  readonly plugins: { [name: string]: unknown };
  readonly settings: { [name: string]: unknown };
}

export function parsePluginState(value: unknown, name: string): PluginState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`channel-config-invalid:plugins.${name}`);
  const { version, enabled, enabledFeatures } = value as { version?: unknown; enabled?: unknown; enabledFeatures?: unknown };
  if (typeof version !== "string" || version.length === 0) throw new Error(`channel-config-invalid:plugins.${name}.version`);
  if (typeof enabled !== "boolean") throw new Error(`channel-config-invalid:plugins.${name}.enabled`);
  if (enabledFeatures !== null && (!Array.isArray(enabledFeatures) || enabledFeatures.some(feature => typeof feature !== "string"))) throw new Error(`channel-config-invalid:plugins.${name}.enabledFeatures`);
  return { version, enabled, enabledFeatures: enabledFeatures === null ? null : [...(enabledFeatures as string[])] };
}

/**
 * Validate the lock boundary before any destructive step. Only the two named maps are
 * required to be objects; every entry is left as its raw value so unknown foreign
 * fields survive a rewrite and malformed own state is refused instead of cast.
 */
export function parseRuntimeLock(value: unknown): RuntimeLock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("channel-config-invalid:root");
  const document = value as { [key: string]: unknown };
  const plugins = document["plugins"] as { [name: string]: unknown };
  const settings = document["settings"] as { [name: string]: unknown };
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) throw new Error("channel-config-invalid:plugins");
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error("channel-config-invalid:settings");
  return { document, plugins, settings };
}

export function parseChannelBackup(value: unknown): ChannelBackup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("channel-backup-invalid:root");
  const { source, profile, state, settings } = value as { source?: unknown; profile?: unknown; state?: unknown; settings?: unknown };
  if (source !== "npm" && source !== "marketplace") throw new Error("channel-backup-invalid:source");
  if (typeof profile !== "string" || profile.length === 0) throw new Error("channel-backup-invalid:profile");
  const backup: ChannelBackup = { source, profile, state: parsePluginState(state, PACKAGE_NAME) };
  return Object.hasOwn(value, "settings") ? { ...backup, settings } : backup;
}

/**
 * Rewrite the lock with only this package's own state merged back.
 * The fresh entry keeps every field the install wrote; foreign entries, foreign
 * settings and any other root field are copied through untouched.
 */
export function mergeOwnState(lock: RuntimeLock, backup: ChannelBackup): { [key: string]: unknown } {
  const installed = lock.plugins[PACKAGE_NAME];
  if (typeof installed !== "object" || installed === null || Array.isArray(installed)) throw new Error("channel-new-runtime-state-missing");
  const plugins = { ...lock.plugins, [PACKAGE_NAME]: { ...installed, enabled: backup.state.enabled, enabledFeatures: backup.state.enabledFeatures } };
  const settings = Object.hasOwn(backup, "settings") ? { ...lock.settings, [PACKAGE_NAME]: backup.settings } : lock.settings;
  return { ...lock.document, plugins, settings };
}

export function npmSpecFor(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("channel-version-invalid");
  return `github:${NPM_REPOSITORY}#v${version}`;
}

function option(args: string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (!args.includes(name) || !value || value.startsWith("--")) throw new Error(`required:${name}`);
  return value;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const home = resolve(option(args, "--home"));
  const profile = option(args, "--profile");
  const destination = option(args, "--to");
  const spec = option(args, "--spec");
  const backupPath = resolve(option(args, "--backup"));
  const executable = option(args, "--executable");
  if (!args.includes("--apply") || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile === "default") throw new Error("explicit-named-profile-and-apply-required");
  if (destination !== "npm" && destination !== "marketplace") throw new Error("channel-invalid");
  if (destination === "npm" && !new RegExp(`^github:${NPM_REPOSITORY.replace("/", "\\/")}#v\\d+\\.\\d+\\.\\d+$`).test(spec)) throw new Error("fixed-github-release-required");
  if (destination === "marketplace" && spec !== `${PACKAGE_NAME}@${PACKAGE_NAME}`) throw new Error("marketplace-id-required");
  const env: { [name: string]: string } = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata") });
  const runtimePath = join(home, ".omp", "profiles", profile, "plugins", "omp-plugins.lock.json");
  async function native(command: string[]): Promise<void> {
    const child = Bun.spawn([executable, "--profile", profile, ...command], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
    const [, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`channel-command-failed:${command.join(" ")}:${error}`);
  }
  const readLock = async (): Promise<RuntimeLock> => parseRuntimeLock(JSON.parse(await readFile(runtimePath, "utf8")) as unknown);
  const restoreOwnState = async (backup: ChannelBackup): Promise<void> => {
    await writeFile(runtimePath, JSON.stringify(mergeOwnState(await readLock(), backup), null, 2) + "\n");
  };
  const raw = await Bun.spawn([executable, "--profile", profile, "plugin", "list", "--json"], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  const [rawOut, rawErr, rawCode] = await Promise.all([new Response(raw.stdout).text(), new Response(raw.stderr).text(), raw.exited]);
  if (rawCode !== 0) throw new Error(`channel-command-failed:plugin list --json:${rawErr}`);
  const list = JSON.parse(rawOut) as { npm: { name: string }[]; marketplace: { id: string; scope: string }[] };
  const npm = list.npm.some(plugin => plugin.name === PACKAGE_NAME);
  const marketplace = list.marketplace.filter(plugin => plugin.id === `${PACKAGE_NAME}@${PACKAGE_NAME}`);
  if (marketplace.some(plugin => plugin.scope !== "user") || Number(npm) + marketplace.length !== 1) throw new Error("one-user-channel-required-remove-project-or-explicit-roots-first");
  const source: Channel = npm ? "npm" : "marketplace";
  if (source === destination) throw new Error("channel-already-selected");
  // Validate the lock before any destructive command, so malformed own state never reaches uninstall.
  const lock = await readLock();
  const state = parsePluginState(lock.plugins[PACKAGE_NAME], PACKAGE_NAME);
  const backup: ChannelBackup = { source, profile, state, ...(Object.hasOwn(lock.settings, PACKAGE_NAME) ? { settings: lock.settings[PACKAGE_NAME] } : {}) };
  await writeFile(backupPath, JSON.stringify(backup, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const originalSpec = source === "npm" ? npmSpecFor(state.version) : `${PACKAGE_NAME}@${PACKAGE_NAME}`;
  const originalArg = source === "npm" ? PACKAGE_NAME : `${PACKAGE_NAME}@${PACKAGE_NAME}`;
  await native(["plugin", "uninstall", originalArg]);
  let targetInstalled = false;
  try {
    await native(["plugin", "install", spec]);
    targetInstalled = true;
    await restoreOwnState(backup);
    if (destination === "marketplace") await native(["plugin", backup.state.enabled ? "enable" : "disable", spec]);
    console.log(JSON.stringify({ source, destination, backupPath, preserved: true }));
  } catch (error) {
    // Remove the partial alternative before reinstalling the original, otherwise the two channels collide.
    if (targetInstalled) {
      try {
        await native(["plugin", "uninstall", destination === "npm" ? PACKAGE_NAME : `${PACKAGE_NAME}@${PACKAGE_NAME}`]);
      } catch (cleanupError) {
        throw new Error(`channel-switch-restore-failed; partial ${destination} install remains, recover ${source} install and own state from ${backupPath} after removing it: ${String(cleanupError)}`);
      }
    }
    try {
      await native(["plugin", "install", originalSpec]);
      await restoreOwnState(backup);
      if (source === "marketplace") await native(["plugin", backup.state.enabled ? "enable" : "disable", originalArg]);
    } catch (restoreError) {
      throw new Error(`channel-switch-restore-failed; recover ${source} install and own state from ${backupPath} before merging: ${String(restoreError)}`);
    }
    throw new Error(`channel-switch-rolled-back; original ${source} channel and own state restored; backup retained at ${backupPath}: ${String(error)}`);
  }
}

if (import.meta.main) await run();

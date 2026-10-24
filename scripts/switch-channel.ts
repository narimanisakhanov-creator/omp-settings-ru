import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * One-way state-preserving migration from a legacy npm user-install to the single
 * supported marketplace install of `omp-settings-ru`.
 *
 * Native uninstall drops this package's own runtime state, so the migration backs
 * the own entry up first and merges it back after the marketplace channel installs.
 * Only this package's own key is ever touched: the rest of the lock is carried
 * through byte-for-byte, so foreign plugins/settings and unknown fields survive.
 * If the marketplace install fails, any partial marketplace copy is removed first
 * and the exact legacy npm release plus its own state are restored; if that is
 * impossible the exact retained backup path is reported instead of claiming success.
 *
 * `--to npm` is not a supported install path and is refused before any option,
 * file or process is touched. The npm spec is rebuilt from the installed version
 * only to roll a failed migration back.
 *
 * `plugin list --json` is checked against its real contract: a project-scoped
 * marketplace copy is refused, and the single npm entry must resolve to this
 * profile's own plugins directory. Explicit roots are not inspectable through
 * this CLI without running the caller's original extension context; migration
 * therefore refuses whenever such roots are configured instead of proceeding.
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
  readonly rootFields?: { [key: string]: unknown };
  readonly pluginFields?: { [key: string]: unknown };
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
  const { source, profile, state, settings, rootFields, pluginFields } = value as ChannelBackup;
  if (source !== "npm" && source !== "marketplace") throw new Error("channel-backup-invalid:source");
  if (typeof profile !== "string" || profile.length === 0) throw new Error("channel-backup-invalid:profile");
  for (const fields of [rootFields, pluginFields]) if (fields !== undefined && (typeof fields !== "object" || fields === null || Array.isArray(fields))) throw new Error("channel-backup-invalid:fields");
  return { source, profile, state: parsePluginState(state, PACKAGE_NAME), ...(Object.hasOwn(value, "settings") ? { settings } : {}), ...(rootFields ? { rootFields } : {}), ...(pluginFields ? { pluginFields } : {}) };
}

/**
 * Rewrite the lock with only this package's own state merged back.
 * The fresh entry keeps every field the install wrote; foreign entries, foreign
 * settings and any other root field are copied through untouched.
 */
export function mergeOwnState(lock: RuntimeLock, backup: ChannelBackup): { [key: string]: unknown } {
  const installed = lock.plugins[PACKAGE_NAME];
  if (typeof installed !== "object" || installed === null || Array.isArray(installed)) throw new Error("channel-new-runtime-state-missing");
  const plugins = { ...lock.plugins, [PACKAGE_NAME]: { ...installed, ...backup.pluginFields, version: (installed as PluginState).version, enabled: backup.state.enabled, enabledFeatures: backup.state.enabledFeatures } };
  const settings = { ...lock.settings };
  if (Object.hasOwn(backup, "settings")) settings[PACKAGE_NAME] = backup.settings;
  else delete settings[PACKAGE_NAME];
  return { ...backup.rootFields, ...lock.document, plugins, settings };
}

export interface MigrationPort {
  native(command: string[]): Promise<void>;
  readLock(): Promise<RuntimeLock>;
  writeLock(document: { [key: string]: unknown }): Promise<void>;
  observe(): Promise<{ npm: readonly string[]; marketplace: boolean }>;
}

export async function migrateLegacyInstall(port: MigrationPort, backup: ChannelBackup, backupPath: string): Promise<void> {
  const target = `${PACKAGE_NAME}@${PACKAGE_NAME}`;
  const restore = async (): Promise<void> => {
    await port.writeLock(mergeOwnState(await port.readLock(), backup));
    const lock = await port.readLock();
    const state = parsePluginState(lock.plugins[PACKAGE_NAME], PACKAGE_NAME);
    if (state.enabled !== backup.state.enabled || JSON.stringify(state.enabledFeatures) !== JSON.stringify(backup.state.enabledFeatures) || JSON.stringify(lock.settings[PACKAGE_NAME]) !== JSON.stringify(backup.settings)) throw new Error("channel-state-restore-unverified");
  };
  try {
    await port.native(["plugin", "uninstall", PACKAGE_NAME]);
    await port.native(["plugin", "install", target]);
    await port.native(["plugin", backup.state.enabled ? "enable" : "disable", target]);
    await restore();
    const observed = await port.observe();
    if (!observed.marketplace || observed.npm.length !== 0) throw new Error("channel-marketplace-identity-unverified");
  } catch (error) {
    try {
      let observed = await port.observe();
      if (observed.marketplace) await port.native(["plugin", "uninstall", target]);
      observed = await port.observe();
      if (observed.marketplace) throw new Error("channel-partial-target-remains");
      if (observed.npm.length !== 1 || observed.npm[0] !== backup.state.version) await port.native(["plugin", "install", npmSpecFor(backup.state.version)]);
      await restore();
      observed = await port.observe();
      if (observed.marketplace || observed.npm.length !== 1 || observed.npm[0] !== backup.state.version) throw new Error("channel-rollback-identity-unverified");
    } catch (restoreError) {
      throw new Error(`channel-switch-restore-failed; recover the legacy install and state from ${backupPath}: ${String(restoreError)}`);
    }
    throw new Error(`channel-switch-rolled-back; original npm identity and state restored; backup retained at ${backupPath}: ${String(error)}`);
  }
}

/** Rollback-only: reconstruct the exact legacy npm release so a failed migration can restore it. */
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
  const destination = option(args, "--to");
  // The one supported install path is marketplace. Refuse the reverse target before any
  // home, backup or native process exists, so `--to npm` can never be mistaken for support.
  if (destination === "npm") throw new Error("channel-target-unsupported: --to npm is not a supported install path; only --to marketplace is supported");
  if (destination !== "marketplace") throw new Error("channel-invalid");
  const home = resolve(option(args, "--home"));
  const profile = option(args, "--profile");
  const spec = option(args, "--spec");
  const backupPath = resolve(option(args, "--backup"));
  const executable = option(args, "--executable");
  if (!args.includes("--apply") || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile === "default") throw new Error("explicit-named-profile-and-apply-required");
  if (spec !== `${PACKAGE_NAME}@${PACKAGE_NAME}`) throw new Error("marketplace-id-required");
  const env: { [name: string]: string } = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata") });
  const configuredExtensions = async (cwd: string): Promise<readonly unknown[]> => {
    const child = Bun.spawn([executable, "--profile", profile, "config", "get", "extensions", "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`extension-roots-unverifiable:config:${err}`);
    // Host versions answer with either the bare array or a `{key,value,type}` envelope. Both are
    // the same setting; an unknown shape stays unverifiable rather than "no roots configured".
    const parsed = JSON.parse(out) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "value" in parsed && Array.isArray(parsed.value)
        ? parsed.value
        : undefined;
    if (list === undefined) throw new Error("extension-roots-unverifiable:config-shape");
    return list;
  };
  const configured = await configuredExtensions(process.cwd());
  if (configured.length > 0) throw new Error("extension-roots-present-remove-configured-roots-first");
  const userPluginsPath = join(home, ".omp", "profiles", profile, "plugins");
  const runtimePath = join(userPluginsPath, "omp-plugins.lock.json");
  async function native(command: string[]): Promise<void> {
    const child = Bun.spawn([executable, "--profile", profile, ...command], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
    const [, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`channel-command-failed:${command.join(" ")}:${error}`);
  }
  const readLock = async (): Promise<RuntimeLock> => parseRuntimeLock(JSON.parse(await readFile(runtimePath, "utf8")) as unknown);
  const listing = async (cwd: string) => {
    const raw = Bun.spawn([executable, "--profile", profile, "plugin", "list", "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(raw.stdout).text(), new Response(raw.stderr).text(), raw.exited]);
    if (code !== 0) throw new Error(`channel-command-failed:plugin list --json:${err}`);
    return JSON.parse(out) as { npm: { name: string; version: string; path?: string }[]; marketplace: { id: string; scope: string }[] };
  };
  const list = await listing(process.cwd());
  const npm = list.npm.filter(plugin => plugin.name === PACKAGE_NAME);
  const marketplace = list.marketplace.filter(plugin => plugin.id === `${PACKAGE_NAME}@${PACKAGE_NAME}`);
  // Already on the supported channel: refuse without touching the install. A project-scoped
  // marketplace copy or any second copy is a collision the caller must resolve first.
  if (marketplace.length > 0) {
    if (marketplace.some(plugin => plugin.scope !== "user")) throw new Error("one-user-channel-required-remove-project-or-explicit-roots-first");
    throw new Error("channel-already-selected");
  }
  // `plugin list --json` npm entries come from the profile's own plugins package.json and
  // carry no scope field; marketplace entries do. Exactly one npm entry is therefore the
  // legacy user install. Its reported path must still resolve to that directory: this
  // rejects a project copy or an explicit root masquerading as one.
  // Explicit `-e`/`--plugin-dir`/configured roots are not installs and never appear in this
  // list, so removing them remains the caller's documented precondition.
  if (npm.length !== 1) throw new Error("one-legacy-npm-user-install-required-remove-project-or-explicit-roots-first");
  const expectedNpmPath = resolve(join(userPluginsPath, "node_modules", PACKAGE_NAME));
  const actualNpmPath = typeof npm[0]!.path === "string" ? resolve(npm[0]!.path) : undefined;
  const samePath = actualNpmPath !== undefined && (process.platform === "win32" ? actualNpmPath.toLowerCase() === expectedNpmPath.toLowerCase() : actualNpmPath === expectedNpmPath);
  if (!samePath) throw new Error("legacy-npm-install-outside-user-plugins-remove-project-or-explicit-roots-first");
  const source: Channel = "npm";
  // Validate the lock before any destructive command, so malformed own state never reaches uninstall.
  const lock = await readLock();
  const state = parsePluginState(lock.plugins[PACKAGE_NAME], PACKAGE_NAME);
  const rootFields = Object.fromEntries(Object.entries(lock.document).filter(([key]) => key !== "plugins" && key !== "settings"));
  const backup: ChannelBackup = { source, profile, state, rootFields, pluginFields: lock.plugins[PACKAGE_NAME] as { [key: string]: unknown }, ...(Object.hasOwn(lock.settings, PACKAGE_NAME) ? { settings: lock.settings[PACKAGE_NAME] } : {}) };
  await writeFile(backupPath, JSON.stringify(backup, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await migrateLegacyInstall({
    native,
    readLock,
    writeLock: document => writeFile(runtimePath, JSON.stringify(document, null, 2) + "\n"),
    observe: async () => {
      const observed = await listing(home);
      return { npm: observed.npm.filter(plugin => plugin.name === PACKAGE_NAME).map(plugin => plugin.version), marketplace: observed.marketplace.some(plugin => plugin.id === spec) };
    },
  }, backup, backupPath);
  console.log(JSON.stringify({ source, destination, backupPath, preserved: true }));
}

if (import.meta.main) await run();

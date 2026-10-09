import { isDeepStrictEqual } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { buildMarketplaceCatalog, type MarketplaceCatalog, type MarketplaceCatalogEntry } from "./marketplace-catalog";
import { canonicalContentHash } from "./installed-smoke";

/**
 * Prove both distribution channels of this package against a real installed OMP.
 *
 * Runs entirely inside one disposable home/profile: npm-managed GitHub install and
 * marketplace install of the same package, real `/settings` panel observations, a
 * state-preserving channel switch in both directions, and a real startup
 * auto-update over an owned stale catalog holding two releases plus a second
 * plugin that proves the setting's global scope.
 *
 * Network is used by both git-backed channels (npm-managed GitHub and the
 * marketplace GitHub source); the owned catalog itself is served over loopback.
 * A transport failure is reported as such, with the home and any backup retained,
 * instead of being confused with a channel or state defect.
 */

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const executable = option("--executable") ?? Bun.which("omp");
if (!executable) throw new Error("native-executable-required");
const home = resolve(option("--home") ?? await mkdtemp(join(tmpdir(), "omp-distribution-")));
const profile = "omp-settings-ru-proof-" + randomUUID().slice(0, 8);
const environment: Record<string, string> = {};
for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]) if (process.env[key]) environment[key] = process.env[key]!;
Object.assign(environment, {HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata")});
const root = join(home, ".omp", "profiles", profile);
await mkdir(join(root, "agent"), {recursive: true});
await writeFile(join(root, "agent", "config.yml"), "startup:\n  setupWizard: false\nmarketplace:\n  autoUpdate: off\n");
const lockPath = join(root, "plugins", "omp-plugins.lock.json");
const registryPath = join(root, "marketplaces.json");

interface NativeResult {code: number; stdout: string; stderr: string}
/** A git/HTTP transport failure is a network condition, not a channel or state defect. */
function failureKind(stderr: string): "network-transport-failed" | "native-command-failed" {
  return /early EOF|RPC failed|Could not resolve host|curl \d+|unexpected disconnect|Connection (refused|reset)|invalid index-pack|schannel|unable to access/i.test(stderr) ? "network-transport-failed" : "native-command-failed";
}
async function native(command: string[]): Promise<NativeResult> {
  const child = Bun.spawn([executable!, "--profile", profile, ...command], {cwd: home, env: environment, stdout: "pipe", stderr: "pipe"});
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return {code, stdout, stderr};
}
async function must(command: string[]): Promise<string> {
  const result = await native(command);
  if (result.code !== 0) throw new Error(`${failureKind(result.stderr)}:${command.join(" ")}:${result.stderr.trim().slice(-1200)}`);
  return result.stdout;
}
/** Run a command that must fail; returns the reported reason so a refusal is never mistaken for success. */
async function refuses(command: string[]): Promise<string> {
  const result = await native(command);
  if (result.code === 0) throw new Error(`expected-refusal:${command.join(" ")}`);
  return (result.stderr + result.stdout).trim().slice(-400);
}

interface PluginState {version: string; enabled: boolean; enabledFeatures: string[] | null}
interface RuntimeConfig {plugins: {[name: string]: PluginState}; settings: {[name: string]: unknown}}
interface PluginList {npm: {name: string; version: string; path: string}[]; marketplace: {id: string; scope: string; version?: string; entries: {version: string; installPath: string; gitCommitSha?: string}[]}[]}
async function readConfig(): Promise<RuntimeConfig> {return JSON.parse(await readFile(lockPath, "utf8")) as RuntimeConfig;}
async function listing(): Promise<PluginList> {return JSON.parse(await must(["plugin", "list", "--json"])) as PluginList;}

const observations: {step: string; status: "ok" | "failed"; detail: string}[] = [];
async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  try {
    const value = await action();
    observations.push({step: name, status: "ok", detail: (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, 3000)});
    return value;
  } catch (error) {
    observations.push({step: name, status: "failed", detail: error instanceof Error ? error.message : String(error)});
    throw error;
  }
}

function sessionChild(mode: "ru" | "en" | "boot") {
  return Bun.spawn([process.execPath, resolve(import.meta.dir, "distribution-session.ts"), executable!, profile, mode], {cwd: home, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
}
async function panel(mode: "ru" | "en"): Promise<string> {
  const child = sessionChild(mode);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    // The session reports the failed step in the head of its JSON report and the failure reason in the tail.
    const report = stdout.trim();
    const excerpt = report.length > 2400 ? `${report.slice(0, 1200)}…${report.slice(-1200)}` : report;
    throw new Error(`${failureKind(stderr)}:distribution-session-failed:exit=${code}:${stderr.trim().slice(-600)}:${excerpt}`);
  }
  const result = JSON.parse(stdout) as {ok: boolean; steps: {step: string; status: string}[]; observations?: {kind: string; output: string}[]};
  if (!result.ok) throw new Error(`distribution-panel-incomplete:${stdout.slice(-1200)}`);
  const failed = result.steps.filter(entry => entry.status !== "ok");
  if (failed.length > 0) throw new Error(`distribution-panel-steps-failed:${JSON.stringify(failed)}`);
  return stdout;
}

interface MarketplaceRegistry {marketplaces: {name: string; catalogPath: string; updatedAt: string}[]}
interface BootObservation {config: RuntimeConfig; registry: MarketplaceRegistry; catalogVersions: {[name: string]: string | undefined}}
/**
 * Start a real OMP, wait for its prompt to appear, then watch the installed registry and
 * cached catalog while it runs. The launched OMP performs its own startup auto-update;
 * nothing here calls the upgrade API directly. The session stays alive until we close its
 * stdin, so a slow clone is never aborted mid-flight, and a mode is only reported as
 * observed when the parent actually saw the expected state. If the session ends on its own
 * we report the real exit instead of pretending the mode was observed.
 */
async function bootUntil(settled: (observation: BootObservation) => boolean, timeoutMs: number, holdMs = 0): Promise<BootObservation> {
  const child = sessionChild("boot");
  const stderr = new Response(child.stderr).text();
  let out = "";
  const drain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) out += decoder.decode(chunk as Uint8Array, {stream: true});
  })();
  const observe = async (): Promise<BootObservation> => {
    const config = await readConfig();
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as MarketplaceRegistry;
    const catalogVersions: {[name: string]: string | undefined} = {};
    for (const marketplace of registry.marketplaces) {
      try {
        const cached = JSON.parse(await readFile(marketplace.catalogPath, "utf8")) as {plugins: {name: string; version?: string}[]};
        for (const plugin of cached.plugins) catalogVersions[plugin.name] = plugin.version;
      } catch {
        catalogVersions[marketplace.name] = undefined;
      }
    }
    return {config, registry, catalogVersions};
  };
  // A boot counts as started only once the launched host reached its prompt.
  const readyDeadline = Date.now() + 60000;
  while (Date.now() < readyDeadline && !out.includes('"ready":true')) {
    if (child.exitCode !== null) break;
    await Bun.sleep(200);
  }
  const started = out.includes('"ready":true');
  const deadline = Date.now() + timeoutMs;
  let observation: BootObservation | undefined;
  let exitedEarly: number | null = null;
  let settledAt: number | null = null;
  while (started && Date.now() < deadline) {
    await Bun.sleep(500);
    if (child.exitCode !== null) {exitedEarly = child.exitCode; break;}
    try {
      observation = await observe();
      if (settled(observation)) settledAt ??= Date.now();
      // For modes that must NOT install, keep the session alive through a bounded window
      // after the state first looked right, then re-read: a late background upgrade would
      // show up here instead of being missed by an immediate exit.
      if (settledAt !== null && Date.now() - settledAt >= holdMs) break;
    } catch {
      // Lock or registry may be rewritten mid-session; keep polling.
    }
  }
  child.stdin?.end();
  const code = await child.exited;
  const [, err] = await Promise.all([drain, stderr]);
  if (exitedEarly !== null) throw new Error(`distribution-boot-session-exited-early:${exitedEarly}:${err.trim().slice(-1200)}`);
  if (code !== 0) throw new Error(`distribution-boot-session-failed:${code}:${err.trim().slice(-1200)}`);
  if (!started) throw new Error(`distribution-boot-never-ready:${out.slice(-600)}`);
  if (!observation || settledAt === null || !settled(observation)) throw new Error(`distribution-boot-timeout:${JSON.stringify({plugins: observation?.config.plugins, catalog: observation?.catalogVersions})}`);
  return observation;
}

/** Prove the installed package: exact manifest, and for the marketplace channel the exact cloned commit. */
async function identity(expected: {version: string; sha?: string}): Promise<{source: "npm" | "marketplace"; installPath: string; contentHash: string}> {
  const list = await listing();
  const npm = list.npm.filter(plugin => plugin.name === "omp-settings-ru");
  const marketplace = list.marketplace.filter(plugin => plugin.id === "omp-settings-ru@omp-settings-ru");
  if (npm.length + marketplace.length !== 1) throw new Error(`channel-count-invalid:npm=${npm.length},marketplace=${marketplace.length}`);
  const source = npm.length === 1 ? "npm" : "marketplace";
  const installPath = npm.length === 1 ? npm[0]!.path : marketplace[0]!.entries[0]!.installPath;
  const manifest = JSON.parse(await readFile(join(installPath, "package.json"), "utf8")) as {name: string; version: string; private?: boolean; omp?: {extensions?: string[]}};
  if (manifest.name !== "omp-settings-ru") throw new Error(`installed-name-mismatch:${manifest.name}`);
  if (manifest.version !== expected.version) throw new Error(`installed-version-mismatch:${manifest.version}!=${expected.version}`);
  if (manifest.omp?.extensions?.[0] !== "./src/index.ts") throw new Error(`installed-extensions-mismatch:${JSON.stringify(manifest.omp?.extensions)}`);
  if (expected.sha !== undefined) {
    if (source !== "marketplace") throw new Error("marketplace-channel-expected");
    const head = Bun.spawnSync(["git", "-C", installPath, "rev-parse", "HEAD"], {stdout: "pipe", stderr: "pipe"});
    if (head.exitCode !== 0) throw new Error(`marketplace-checkout-unverifiable:${head.stderr.toString().trim()}`);
    if (head.stdout.toString().trim() !== expected.sha) throw new Error(`installed-commit-mismatch:${head.stdout.toString().trim()}!=${expected.sha}`);
  }
  return {source, installPath, contentHash: await canonicalContentHash(installPath)};
}

async function switchChannel(to: "npm" | "marketplace", suffix: string, spec: string): Promise<string> {
  const backupPath = join(home, `backup-${suffix}.json`);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "switch-channel.ts"), "--home", home, "--profile", profile, "--executable", executable!, "--to", to, "--spec", spec, "--backup", backupPath, "--apply"], {cwd: home, env: environment, stdout: "pipe", stderr: "pipe"});
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${failureKind(stderr)}:migration-${to}-failed;backup=${backupPath}:${stderr.trim().slice(-1200)}`);
  return stdout.trim();
}
async function assertState(expected: RuntimeConfig): Promise<void> {
  const actual = await readConfig();
  const own = actual.plugins["omp-settings-ru"]!;
  const before = expected.plugins["omp-settings-ru"]!;
  if (own.enabled !== before.enabled || !isDeepStrictEqual(own.enabledFeatures, before.enabledFeatures) || !isDeepStrictEqual(actual.settings, expected.settings) || !isDeepStrictEqual(actual.plugins["foreign"], expected.plugins["foreign"])) throw new Error("migration-state-not-preserved:" + JSON.stringify({actual, expected}));
}
async function seedState(patch: {enabled: boolean; enabledFeatures: string[] | null}): Promise<RuntimeConfig> {
  const state = await readConfig();
  state.plugins["omp-settings-ru"] = {...state.plugins["omp-settings-ru"]!, ...patch};
  state.plugins["foreign"] = {version: "1.0.0", enabled: false, enabledFeatures: null};
  state.settings["omp-settings-ru"] = {opaque: {flag: true, count: 7, values: ["x", null]}};
  state.settings["foreign"] = {retain: true};
  await writeFile(lockPath, JSON.stringify(state));
  return state;
}
async function stale(): Promise<void> {
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {marketplaces: {updatedAt: string}[]};
  if (registry.marketplaces.length === 0) throw new Error("marketplace-registry-empty");
  for (const entry of registry.marketplaces) entry.updatedAt = "2000-01-01T00:00:00.000Z";
  await writeFile(registryPath, JSON.stringify(registry));
}

/** Owned second marketplace plugin: two tagged releases in a real Git repository. */
async function fixturePlugin(): Promise<{directory: string; versions: {version: string; sha: string}[]}> {
  const directory = await mkdtemp(join(tmpdir(), "omp-fixture-plugin-"));
  const git = (command: string[]): string => {
    const result = Bun.spawnSync(["git", ...command], {cwd: directory, stdout: "pipe", stderr: "pipe"});
    if (result.exitCode !== 0) throw new Error(`fixture-git-failed:${command.join(" ")}:${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  git(["init", "-q"]);
  const versions: {version: string; sha: string}[] = [];
  for (const version of ["0.0.1", "0.0.2"]) {
    await writeFile(join(directory, "package.json"), JSON.stringify({name: "omp-fixture-plugin", version, description: "distribution smoke fixture"}) + "\n");
    git(["add", "."]);
    git(["-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", `fixture ${version}`]);
    git(["tag", `v${version}`]);
    versions.push({version, sha: git(["rev-parse", "HEAD"])});
  }
  return {directory, versions};
}

const catalogPath = option("--catalog");
const target: MarketplaceCatalog = catalogPath ? await Bun.file(catalogPath).json() as MarketplaceCatalog : buildMarketplaceCatalog({version: "0.3.1", commitSha: "4665e6d72635751d03b784d1b02dc107f38071a4", repository: "narimanisakhanov-creator/omp-settings-ru", description: "Русский перевод /settings"});
const own = target.plugins[0]!;
if (own.name !== "omp-settings-ru" || own.source.source !== "github" || own.source.repo !== "narimanisakhanov-creator/omp-settings-ru" || !/^[a-f0-9]{40}$/.test(own.source.sha) || own.source.ref !== `v${own.version}`) throw new Error("smoke-target-invalid");
const npmSpec = `github:${own.source.repo}#${own.source.ref}`;

/**
 * Commit the current working tree (the exact package allowlist) into a real local Git
 * repository so the marketplace channel can clone and load THESE bytes natively, without
 * `-e`, `--plugin-dir` or `plugin link`. Used to prove the checked-out source, not only
 * an already published release.
 */
async function sourceRepo(): Promise<{directory: string; sha: string; version: string; contentHash: string}> {
  const project = resolve(import.meta.dir, "..");
  const metadata = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as {version: string; files: string[]};
  const directory = await mkdtemp(join(tmpdir(), "omp-source-repo-"));
  for (const path of ["package.json", ...metadata.files]) await cp(join(project, path), join(directory, path), {recursive: true});
  // Keep checkout bytes identical to the committed bytes so the clone can be compared
  // to the working tree; the fixture repo must not rewrite line endings.
  await writeFile(join(directory, ".gitattributes"), "* -text\n");
  const git = (command: string[]): string => {
    const result = Bun.spawnSync(["git", ...command], {cwd: directory, stdout: "pipe", stderr: "pipe"});
    if (result.exitCode !== 0) throw new Error(`source-repo-git-failed:${command.join(" ")}:${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", `source v${metadata.version}`]);
  git(["tag", `v${metadata.version}`]);
  return {directory, sha: git(["rev-parse", "HEAD"]), version: metadata.version, contentHash: await canonicalContentHash(directory)};
}

const fixture = await fixturePlugin();
const fixtureEntry = (index: number): MarketplaceCatalogEntry => ({name: "omp-fixture-plugin", description: "distribution smoke fixture", version: fixture.versions[index]!.version, source: {source: "url", url: pathToFileURL(fixture.directory).href, ref: `v${fixture.versions[index]!.version}`, sha: fixture.versions[index]!.sha}});
let catalog: MarketplaceCatalog = {...target, plugins: [...target.plugins, fixtureEntry(0)]};
const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch() {return Response.json(catalog);}});
const catalogUrl = `http://127.0.0.1:${server.port}/marketplace.json`;

try {
  await step("host-version", async () => (await must(["--version"])).trim());
  if (args.includes("--source")) {
    // Prove the checked-out source itself: native marketplace clone of a real local Git
    // repository built from the working tree, byte-identical to the package allowlist.
    const source = await sourceRepo();
    catalog = {name: "omp-settings-ru", owner: {name: "narimanisakhanov-creator"}, plugins: [{name: "omp-settings-ru", description: "Русский перевод /settings", version: source.version, source: {source: "url", url: pathToFileURL(source.directory).href, ref: `v${source.version}`, sha: source.sha}}]};
    await step("source-marketplace-add", () => must(["plugin", "marketplace", "add", catalogUrl]));
    await step("source-marketplace-install", async () => {
      await must(["plugin", "install", "omp-settings-ru@omp-settings-ru"]);
      const installed = await identity({version: source.version, sha: source.sha});
      if (installed.source !== "marketplace") throw new Error("marketplace-channel-expected");
      if (installed.contentHash !== source.contentHash) throw new Error(`source-content-mismatch:${installed.contentHash}!=${source.contentHash}`);
      return {...installed, sourceSha: source.sha};
    });
    await step("source-panel-ru", () => panel("ru"));
    await step("source-uninstall-english", async () => {
      await must(["plugin", "uninstall", "omp-settings-ru@omp-settings-ru"]);
      return panel("en");
    });
    console.log(JSON.stringify({home, profile, catalogUrl, fixture: fixture.directory, sourceDirectory: source.directory, observations, personalProfileChanged: false}, null, 2));
    server.stop(true);
    process.exit(0);
  }
  const npmInstall = await step("npm-install", async () => {
    await must(["plugin", "install", npmSpec]);
    const installed = await identity({version: own.version});
    if (installed.source !== "npm") throw new Error("npm-channel-expected");
    return installed;
  });
  await step("npm-panel-ru", () => panel("ru"));
  await step("marketplace-add", () => must(["plugin", "marketplace", "add", catalogUrl]));
  await step("collision-refused", async () => {
    // Installing the marketplace copy while the npm-managed copy owns the runtime name must be
    // refused, and the existing install must survive byte-for-byte.
    const reason = await refuses(["plugin", "install", "omp-settings-ru@omp-settings-ru", "--force"]);
    const installed = await identity({version: own.version});
    if (installed.source !== "npm") throw new Error(`collision-destroyed-install:${installed.source}`);
    if (installed.contentHash !== npmInstall.contentHash) throw new Error(`collision-changed-install:${installed.contentHash}`);
    return reason;
  });
  await step("invalid-sha-refused", async () => {
    // A source whose pinned commit does not exist must fail loudly, not install or overwrite state.
    const broken = {...target, plugins: [{...own, source: {...own.source, sha: "0".repeat(40)}}]};
    catalog = broken;
    await must(["plugin", "marketplace", "update", "omp-settings-ru"]);
    const reason = await refuses(["plugin", "install", "omp-settings-ru@omp-settings-ru", "--force"]);
    catalog = {...target, plugins: [...target.plugins, fixtureEntry(0)]};
    await must(["plugin", "marketplace", "update", "omp-settings-ru"]);
    const installed = await identity({version: own.version});
    if (installed.source !== "npm" || installed.contentHash !== npmInstall.contentHash) throw new Error(`invalid-sha-destroyed-install:${JSON.stringify(installed)}`);
    return reason;
  });
  const disabledEmptyFeatures = await seedState({enabled: false, enabledFeatures: []});
  const marketplaceInstall = await step("migration-npm-to-marketplace", async () => {
    await switchChannel("marketplace", "npm", "omp-settings-ru@omp-settings-ru");
    await assertState(disabledEmptyFeatures);
    const installed = await identity({version: own.version, sha: own.source.sha});
    if (installed.source !== "marketplace") throw new Error("marketplace-channel-expected");
    if (installed.contentHash !== npmInstall.contentHash) throw new Error(`channel-content-mismatch:${installed.contentHash}!=${npmInstall.contentHash}`);
    return installed;
  });
  await step("marketplace-panel-ru", async () => {
    await must(["plugin", "enable", "omp-settings-ru@omp-settings-ru"]);
    return panel("ru");
  });
  const disabledNullFeatures = await seedState({enabled: false, enabledFeatures: null});
  await step("migration-marketplace-to-npm", async () => {
    await switchChannel("npm", "marketplace", npmSpec);
    await assertState(disabledNullFeatures);
    const installed = await identity({version: own.version});
    if (installed.source !== "npm") throw new Error("npm-channel-expected");
    if (installed.contentHash !== marketplaceInstall.contentHash) throw new Error(`channel-content-mismatch:${installed.contentHash}!=${marketplaceInstall.contentHash}`);
    return installed;
  });
  await step("npm-panel-ru-after-migration", async () => {
    await must(["plugin", "enable", "omp-settings-ru"]);
    return panel("ru");
  });
  await step("uninstall-english", async () => {
    await must(["plugin", "uninstall", "omp-settings-ru"]);
    return panel("en");
  });

  // Auto-update proof: install the previous immutable release of both plugins, serve two newer releases, let real startup auto-update run.
  catalog = {...target, plugins: [{...own, version: "0.3.0", source: {...own.source, ref: "v0.3.0", sha: "2b2bcd1e25b59128b4f5198c4dab46eadd1b3a4f"}}, fixtureEntry(0)]};
  await step("marketplace-install-older", async () => {
    await must(["plugin", "marketplace", "update", "omp-settings-ru"]);
    await must(["plugin", "install", "omp-settings-ru@omp-settings-ru"]);
    await must(["plugin", "install", "omp-fixture-plugin@omp-settings-ru"]);
    return identity({version: "0.3.0"});
  });
  catalog = {...target, plugins: [...target.plugins, fixtureEntry(1)]};
  const beforeAuto = await readConfig();
  beforeAuto.plugins["omp-settings-ru"]!.enabled = false;
  beforeAuto.plugins["omp-settings-ru"]!.enabledFeatures = null;
  beforeAuto.settings["omp-settings-ru"] = disabledNullFeatures.settings["omp-settings-ru"];
  beforeAuto.plugins["omp-fixture-plugin"] = {version: "0.0.1", enabled: false, enabledFeatures: null};
  beforeAuto.plugins["foreign"] = {version: "1.0.0", enabled: false, enabledFeatures: null};
  beforeAuto.settings["foreign"] = {retain: true};
  await writeFile(lockPath, JSON.stringify(beforeAuto));
  for (const mode of ["off", "notify", "auto"] as const) {
    await step(`auto-${mode}`, async () => {
      await must(["config", "set", "marketplace.autoUpdate", mode]);
      await stale();
      const beforeCatalog = JSON.parse(await readFile(registryPath, "utf8")) as {marketplaces: {updatedAt: string}[]};
      const staleStamp = beforeCatalog.marketplaces[0]!.updatedAt;
      // off: no refresh and no installs. notify: catalog refreshed A→B, installed stays old.
      // auto: both plugins upgraded. Each mode waits for its own observable condition.
      const settled = mode === "off"
        ? (observation: BootObservation) => observation.config.plugins["omp-settings-ru"]?.version === "0.3.0"
        : mode === "notify"
          ? (observation: BootObservation) => observation.catalogVersions["omp-settings-ru"] === own.version && observation.config.plugins["omp-settings-ru"]?.version === "0.3.0"
          : (observation: BootObservation) => observation.config.plugins["omp-settings-ru"]?.version === own.version && observation.config.plugins["omp-fixture-plugin"]?.version === "0.0.2";
      const {config: after, registry} = await bootUntil(settled, mode === "auto" ? 180000 : 90000, mode === "auto" ? 0 : 15000);
      const refreshed = registry.marketplaces[0]!.updatedAt !== staleStamp;
      if (mode === "off" && refreshed) throw new Error(`auto-off-refreshed-catalog:${registry.marketplaces[0]!.updatedAt}`);
      if (mode === "notify" && !refreshed) throw new Error(`auto-notify-did-not-refresh:${registry.marketplaces[0]!.updatedAt}`);
      const expectedFixture = mode === "auto" ? "0.0.2" : "0.0.1";
      if (after.plugins["omp-fixture-plugin"]!.version !== expectedFixture) throw new Error(`auto-mode-fixture-failed:${mode}:${after.plugins["omp-fixture-plugin"]!.version}`);
      if (after.plugins["omp-settings-ru"]!.enabled !== false || after.plugins["omp-settings-ru"]!.enabledFeatures !== null) throw new Error(`auto-mode-state-lost:${mode}:${JSON.stringify(after.plugins["omp-settings-ru"])}`);
      if (after.plugins["omp-fixture-plugin"]!.enabled !== false) throw new Error(`auto-mode-fixture-state-lost:${mode}`);
      if (!isDeepStrictEqual(after.plugins["foreign"], beforeAuto.plugins["foreign"]) || !isDeepStrictEqual(after.settings["foreign"], beforeAuto.settings["foreign"])) throw new Error(`auto-mode-foreign-state-lost:${mode}:${JSON.stringify({plugins: after.plugins["foreign"], settings: after.settings["foreign"]})}`);
      if (!isDeepStrictEqual(after.settings["omp-settings-ru"], beforeAuto.settings["omp-settings-ru"])) throw new Error(`auto-mode-settings-lost:${mode}`);
      return `${mode}:omp-settings-ru=${after.plugins["omp-settings-ru"]!.version},omp-fixture-plugin=${expectedFixture},catalogRefreshed=${refreshed}`;
    });
  }
  await step("marketplace-panel-ru-after-auto", async () => {
    await must(["plugin", "enable", "omp-settings-ru@omp-settings-ru"]);
    return panel("ru");
  });
  await step("uninstall-english-final", async () => {
    await must(["plugin", "uninstall", "omp-settings-ru@omp-settings-ru"]);
    return panel("en");
  });
  console.log(JSON.stringify({home, profile, catalogUrl, fixture: fixture.directory, observations, personalProfileChanged: false}, null, 2));
} catch (error) {
  console.log(JSON.stringify({home, profile, catalogUrl, fixture: fixture.directory, failed: error instanceof Error ? error.message : String(error), observations, personalProfileChanged: false}, null, 2));
  process.exitCode = 1;
} finally {
  server.stop(true);
}

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseLivenessSample, runUpdate, selectLiveOmpRows } from "../scripts/maintenance/updater.ts";
import type { ReleasePin } from "../scripts/maintenance/contracts.ts";
import { runControllerUpdate } from "../scripts/maintenance.ts";
import { updaterTestExecutable } from "../scripts/ci/prepare-host.ts";

const executable = updaterTestExecutable(process.env, () => Bun.which("omp"));
const versionProbe = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
const hostVersion = /^(?:omp(?: v|\/))?(\d+\.\d+\.\d+)\s*$/.exec(versionProbe.stdout.toString().trim())?.[1];
if (versionProbe.exitCode !== 0 || !hostVersion) throw new Error("updater-native-host-unverifiable");
if (process.env.OMP_UPDATER_HOST_VERSION && process.env.OMP_UPDATER_HOST_VERSION !== hostVersion) throw new Error("updater-native-host-version-mismatch");
const pin: ReleasePin = {
  tag: "v0.2.1", commitSha: "a".repeat(40), assetId: 42, sha256: "b".repeat(64), packageVersion: "0.2.1",
  supportedPairs: [{ hostVersion, platform: process.platform as "win32" | "linux" | "darwin" }],
};
async function removeOwnedFixture(root: string): Promise<void> {
  if (resolve(root, "..") !== resolve(tmpdir()) || !basename(root).startsWith("omp-updater-test-")) throw new Error("refusing-unowned-fixture");
  const files: { path: string; mode: number }[] = [];
  const directories: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    let link = stat.isSymbolicLink();
    // Some Windows directory junctions expose directory type; readlink detects
    // the reparse target without opening or traversing the destination.
    if (!link && process.platform === "win32" && stat.isDirectory()) {
      try { await readlink(path); link = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error; }
    }
    if (link) {
      await unlink(path);
    } else if (stat.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
      directories.push(path);
    } else if (stat.isFile()) {
      files.push({ path, mode: stat.mode });
    } else {
      throw new Error("refusing-unknown-fixture-entry");
    }
  };
  await visit(root);
  // Every owned link is gone before changing any owned regular file's mode.
  for (const file of files) {
    if (process.platform === "win32" && !(file.mode & 0o200)) await chmod(file.path, file.mode | 0o200);
    await unlink(file.path);
  }
  for (const directory of directories) await rmdir(directory);
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omp-updater-test-"));
  try {
    await writeFile(join(root, "candidate.tgz"), "candidate bytes");
    await run(root);
  } finally { await removeOwnedFixture(root); }
}
const options = (root: string) => ({ pin, executable, stateDirectory: root, packagePath: join(root, "candidate.tgz"), activate: false, accepted: false });
// No inherited credentials, overlays, provider configuration or profile selectors.
const ownedEnvironment = () => {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
};

// The activation liveness gate: only live pids are sessions, and any unverifiable sample is fail-closed.
const livenessSample = (stdout: string, exit = 0) => ({ exit, stdout, stderr: "" });
test("activation liveness ignores an exited CIM row for a just-finished native helper", () => {
  const profile = "omp-updater-target-abc";
  // The helper is gone: no live pid, yet CIM still lists its row.
  expect(selectLiveOmpRows([], [{ pid: 4242, line: `omp.exe --profile ${profile} plugin list --json` }])).toEqual([]);
  expect(parseLivenessSample(profile, livenessSample(`{"live":[],"cim":[{"pid":4242,"line":"omp.exe --profile ${profile} plugin list --json"}]}`))).toEqual({ status: "idle" });
});
test("activation liveness defers for a live process on the target profile", () => {
  const profile = "omp-updater-target-abc";
  const live = `{"live":[7],"cim":[{"pid":7,"line":"omp.exe --profile ${profile} --mode rpc"}]}`;
  expect(parseLivenessSample(profile, livenessSample(live))).toEqual({ status: "busy", refusal: "active-session-or-liveness-unverifiable" });
  expect(parseLivenessSample("other-profile", livenessSample(live))).toEqual({ status: "idle" });
});
test("activation liveness keeps a live process with unknown argv busy", () => {
  const profile = "omp-updater-target-abc";
  // Unreadable argv on a live process is unknown, not absence.
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":[{"pid":7,"line":""}]}'))).toEqual({ status: "busy", refusal: "active-session-or-liveness-unverifiable" });
  // A live pid absent from the CIM snapshot may have started during sampling.
  expect(parseLivenessSample(profile, livenessSample('{"live":[9],"cim":[]}'))).toEqual({ status: "busy", refusal: "active-session-or-liveness-unverifiable" });
});
test("activation liveness treats a successful no-process sample as idle", () => {
  expect(parseLivenessSample("omp-updater-target-abc", livenessSample('{"live":[],"cim":[]}'))).toEqual({ status: "idle" });
});
test("activation liveness is fail-closed for every unverifiable sample", () => {
  const profile = "omp-updater-target-abc";
  const failed = { status: "failed", refusal: "liveness-query-unverifiable" } as const;
  expect(parseLivenessSample(profile, livenessSample("", 1))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample("", 0))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample("   "))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample("{ malformed"))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('["live","cim"]'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":"7","cim":[]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":"none"}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":["7"],"cim":[]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":[{"pid":"7","line":""}]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":[{"pid":7}]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":[null]}'))).toEqual(failed);
  // A pid must be a positive safe integer: 0, negatives and unsafe magnitudes are malformed.
  expect(parseLivenessSample(profile, livenessSample('{"live":[0],"cim":[]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[-7],"cim":[]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[9007199254740993],"cim":[]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":[{"pid":0,"line":""}]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":[{"pid":-7,"line":""}]}'))).toEqual(failed);
  expect(parseLivenessSample(profile, livenessSample('{"live":[7],"cim":[{"pid":9007199254740993,"line":""}]}'))).toEqual(failed);
});

test("owned readonly fixture teardown unlinks both junctions without touching external target", async () => {
  const external = await mkdtemp(join(tmpdir(), "omp-updater-external-test-"));
  let root = "";
  try {
    await writeFile(join(external, "sentinel"), "external bytes");
    await chmod(join(external, "sentinel"), 0o444);
    await fixture(async owned => {
      root = owned;
      await mkdir(join(root, "stage", "package", "src"), { recursive: true });
      for (const path of [join(root, "stage", "package", "package.json"), join(root, "stage", "package", "src", "index.ts"), join(root, "readonly-root")]) {
        await writeFile(path, "owned immutable bytes");
        await chmod(path, 0o444);
      }
      await symlink(root, join(root, "staged-link"), "junction");
      await symlink(external, join(root, "external-link"), "junction");
    });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "staged-link"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "external-link"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("external bytes");
    expect((await lstat(join(external, "sentinel"))).mode & 0o222).toBe(0);
  } finally {
    await chmod(join(external, "sentinel"), 0o644);
    await rm(external, { recursive: true, force: true });
  }
});


test("unavailable host returns safe-pending without changing previous install", () => fixture(async root => {
  const receipt = await runUpdate({ ...options(root), executable: join(root, "missing.exe") });
  expect(receipt.phase).toBe("safe-pending");
  expect(receipt.smokePassed).toBe(false);
  expect(receipt.refusal).toBe("host-unavailable-or-unverifiable");
}));
test("mismatched actual host returns safe-pending without changing previous install", () => fixture(async root => {
  const receipt = await runUpdate({ ...options(root), pin: { ...pin, supportedPairs: [{ hostVersion: "0.0.1", platform: process.platform as "win32" }] } });
  expect(receipt.phase).toBe("safe-pending");
  expect(receipt.refusal).toBe("host-pair-unsupported");
}));

test("wrong fixed package hash blocks verification and preserves previous install", () => fixture(async root => {
  await writeFile(join(root, "release-pin.json"), JSON.stringify(pin));
  const receipt = await runUpdate(options(root));
  expect(receipt.phase).toBe("blocked");
  expect(receipt.refusal).toBe("package-hash-mismatch");
}));

for (const field of ["tag", "commitSha", "assetId", "sha256"] as const) {
  test(`fixed ${field} discrepancy blocks staging`, () => fixture(async root => {
    await writeFile(join(root, "release-pin.json"), JSON.stringify({ ...pin, [field]: field === "assetId" ? 99 : "different" }));
    const receipt = await runUpdate(options(root));
    expect(receipt.phase).toBe("blocked");
    expect(receipt.refusal).toBe("release-pin-mismatch");
  }));
}
test("malformed fixed release identifiers block staging", () => fixture(async root => {
  const invalid = { ...pin, tag: "latest", commitSha: "main", assetId: -1 };
  await writeFile(join(root, "release-pin.json"), JSON.stringify(invalid));
  const receipt = await runUpdate({ ...options(root), pin: invalid });
  expect(receipt.refusal).toBe("release-pin-invalid");
}));

async function packageFixture(root: string, entries?: Record<string, string>) {
  const bytes = await new Bun.Archive(entries ?? {
    "package/package.json": JSON.stringify({ name: "omp-settings-ru", version: "0.2.1", files: ["src"], omp: { extensions: ["./src/index.ts"] } }),
    "package/src/index.ts": 'export default function(pi) { pi.registerCommand("updater-proof", {description:"owned test",handler:async()=>{}}); }',
  }).bytes();
  const fixed = { ...pin, sha256: createHash("sha256").update(bytes).digest("hex") };
  await writeFile(join(root, "candidate.tgz"), bytes);
  await writeFile(join(root, "release-pin.json"), JSON.stringify(fixed));
  return fixed;
}

test("stage verifies native manager in disposable profile without activation", () => fixture(async root => {
  const fixed = await packageFixture(root);
  const receipt = await runUpdate({ ...options(root), pin: fixed });
  expect(receipt.phase).toBe("staged");
  expect(receipt.smokePassed).toBe(true);
  expect(JSON.parse(await readFile(join(root, "stage", "package", "package.json"), "utf8")).version).toBe("0.2.1");
}), 60_000);

test("identical owned stage resumes and refuses changed staged bytes", () => fixture(async root => {
  const fixed = await packageFixture(root);
  const first = await runUpdate({ ...options(root), pin: fixed });
  expect(first.phase).toBe("staged");
  const repeated = await runUpdate({ ...options(root), pin: fixed });
  expect(repeated).toEqual(first);
  await chmod(join(root, "stage", "package", "src", "index.ts"), 0o644);
  await writeFile(join(root, "stage", "package", "src", "index.ts"), "foreign bytes");
  const conflict = await runUpdate({ ...options(root), pin: fixed });
  expect(conflict.phase).toBe("blocked");
  expect(conflict.refusal).toBe("immutable-package-conflict");
}), 120_000);

for (const flags of [{ activate: true, accepted: false }, { activate: false, accepted: true }]) {
  test(`activation requires both flags ${JSON.stringify(flags)}`, () => fixture(async root => {
    const fixed = await packageFixture(root);
    const receipt = await runUpdate({ ...options(root), pin: fixed, ...flags });
    expect(receipt.phase).not.toBe("activated");
    expect(receipt.refusal).toBe("activation-not-accepted");
  }), 60_000);
}

test("accepted activation installs durable version in disposable profile", () => fixture(async root => {
  const fixed = await packageFixture(root);
  const targetProfile = `omp-updater-target-${crypto.randomUUID()}`;
  await writeFile(join(root, "activation-target.json"), JSON.stringify({ profile: targetProfile }));
  const receipt = await runUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile });
  if (process.platform !== "win32") {
    expect(receipt.phase).toBe("safe-pending");
    expect(receipt.refusal).toBe("active-session-or-liveness-unverifiable");
    expect(await Bun.file(join(root, "activation.json")).exists()).toBe(false);
    const listed = Bun.spawnSync([executable, "--profile", targetProfile, "plugin", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout.toString()).npm).toEqual([]);
    console.log("activation boundary: safe-pending; non-Windows liveness unsupported; native target unchanged");
    return;
  }
  expect(receipt.phase).toBe("activated");
  const activated = JSON.parse(await readFile(join(root, "activation.json"), "utf8"));
  expect(activated.profile).toBe(targetProfile);
  const child = Bun.spawn([executable, "--profile", activated.profile, "plugin", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const listing = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  const plugin = listing.npm.find((entry: { name: string }) => entry.name === "omp-settings-ru");
  expect(plugin.version).toBe("0.2.1");
  expect(activated.target.startsWith(tmpdir())).toBe(false);
  expect(JSON.parse(await readFile(join(activated.target, "package.json"), "utf8")).version).toBe("0.2.1");
  console.log("activation verdict: activated; native list version: " + plugin.version + "; durable target: outside temp");
}), 120_000);

test("archive traversal refuses before extraction", () => fixture(async root => {
  const fixed = await packageFixture(root, { "package/../../escape.txt": "unsafe" });
  const receipt = await runUpdate({ ...options(root), pin: fixed });
  expect(receipt.refusal).toBe("package-unsafe-path");
}));

test("lifecycle scripts refuse before native manager execution", () => fixture(async root => {
  const fixed = await packageFixture(root, { "package/package.json": JSON.stringify({ name: "omp-settings-ru", version: "0.2.1", scripts: { postinstall: "arbitrary" } }) });
  const receipt = await runUpdate({ ...options(root), pin: fixed });
  expect(receipt.refusal).toBe("package-unsafe-manifest");
}));

test("backup and native disposable rollback restore previous bytes and metadata", () => fixture(async root => {
  const fixed = await packageFixture(root);
  const oldBytes = await new Bun.Archive({
    "package/package.json": JSON.stringify({ name: "omp-settings-ru", version: "0.2.0", files: ["src"], omp: { extensions: ["./src/index.ts"] } }),
    "package/src/index.ts": 'export default function(pi) {pi.registerCommand("old-updater-proof",{description:"previous",handler:async()=>{}});}',
  }).bytes();
  const oldHash = createHash("sha256").update(oldBytes).digest("hex");
  await writeFile(join(root, "previous.tgz"), oldBytes);
  const previous = { pluginPath: "previous/package", previousPackageHash: oldHash, hostVersion, platform: process.platform, timestamp: "2026-10-08T00:00:00.000Z", enabled: true };
  await writeFile(join(root, "installed.json"), JSON.stringify(previous));
  const receipt = await runUpdate({ ...options(root), pin: fixed });
  expect(receipt.previousPackageHash).toBe(oldHash);
  expect(await readFile(join(root, "backup", "previous.tgz"))).toEqual(Buffer.from(oldBytes));
  expect(JSON.parse(await readFile(join(root, "backup", "installed.json"), "utf8"))).toEqual(previous);
  const restored = JSON.parse(await readFile(join(root, "rollback-proof.json"), "utf8"));
  expect(restored.previousPackageHash).toBe(oldHash);
  expect(restored.restoredVersion).toBe("0.2.0");
  expect(restored.bytesRestored).toBe(true);
  expect(restored.metadataRestored).toBe(true);
  expect(await readFile(join(root, "previous.tgz"))).toEqual(Buffer.from(oldBytes));
  expect(JSON.parse(await readFile(join(root, "installed.json"), "utf8"))).toEqual(previous);
}), 60_000);

test("ordinary packaged scripts do not prevent safe staging", () => fixture(async root => {
  const fixed = await packageFixture(root, {
    "package/package.json": JSON.stringify({ name: "omp-settings-ru", version: "0.2.1", files: ["src"], scripts: { test: "bun test", typecheck: "tsc --noEmit" }, omp: { extensions: ["./src/index.ts"] } }),
    "package/src/index.ts": 'export default function() {}',
  });
  const receipt = await runUpdate({ ...options(root), pin: fixed });
  expect(receipt.phase).toBe("staged");
}), 60_000);


async function installedFixture(root: string) {
  const profile = `omp-updater-test-${crypto.randomUUID()}`;
  const oldEntries = {
    "package/package.json": JSON.stringify({ name: "omp-settings-ru", version: "0.2.0", files: ["src"], omp: { extensions: ["./src/index.ts"], features: { optional: { description: "optional", default: false } } } }),
    "package/src/index.ts": 'export default function() {}',
  };
  const oldBytes = await new Bun.Archive(oldEntries).bytes();
  const target = join(root, "old-package");
  await mkdir(join(target, "src"), { recursive: true });
  for (const [file, text] of Object.entries(oldEntries)) await writeFile(join(target, file.slice(8)), text);
  const child = Bun.spawn([executable, "--profile", profile, "plugin", "link", target, "--json"], { stdout: "pipe", stderr: "pipe" });
  await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const sibling = join(root, "sibling");
  await mkdir(sibling);
  await writeFile(join(sibling, "package.json"), JSON.stringify({ name: "sibling-proof", version: "1.0.0", omp: {} }));
  const siblingInstall = Bun.spawn([executable, "--profile", profile, "plugin", "link", sibling, "--json"], { stdout: "pipe", stderr: "pipe" });
  await new Response(siblingInstall.stdout).text();
  expect(await siblingInstall.exited).toBe(0);
  const helper = Bun.spawn([process.execPath, "-e", 'import {getPluginsLockfile} from "@oh-my-pi/pi-utils/dirs"; console.log(getPluginsLockfile());'], { env: { ...process.env, OMP_PROFILE: profile, PI_CODING_AGENT_DIR: "" }, stdout: "pipe", stderr: "pipe" });
  const registry = (await new Response(helper.stdout).text()).trim();
  expect(await helper.exited).toBe(0);
  const config = JSON.parse(await readFile(registry, "utf8"));
  config.plugins["omp-settings-ru"].enabled = false;
  config.plugins["omp-settings-ru"].enabledFeatures = ["optional"];
  config.settings["omp-settings-ru"] = { language: "ru", retained: 37 };
  // Real unrelated sibling installed by the same native manager.
  config.plugins["sibling-proof"] = { version: "1.0.0", enabled: false, enabledFeatures: [] };
  await writeFile(registry, JSON.stringify(config, null, 2));
  const snapshot = await readFile(registry);
  const previous = { profile, pluginPath: target, previousPackageHash: createHash("sha256").update(oldBytes).digest("hex"), hostVersion, platform: process.platform, timestamp: new Date().toISOString(), enabled: false };
  await writeFile(join(root, "previous.tgz"), oldBytes);
  await writeFile(join(root, "installed.json"), JSON.stringify(previous));
  await writeFile(join(root, "activation-target.json"), JSON.stringify({ profile }));
  return { profile, registry, snapshot, config, target, oldBytes };
}

test("controller trusted target captures actual previous install and activates", () => fixture(async root => {
  const old = await installedFixture(root);
  const fixed = await packageFixture(root);
  await rm(join(root, "installed.json"));
  await rm(join(root, "previous.tgz"));
  await rm(join(root, "activation-target.json"));
  const receipt = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("controller activation receipt: " + JSON.stringify(receipt) + " root=" + root + " profile=" + old.profile);
  if (process.platform !== "win32") {
    expect(receipt.phase).toBe("safe-pending");
    expect(receipt.refusal).toBe("active-session-or-liveness-unverifiable");
    expect(await readFile(old.registry)).toEqual(old.snapshot);
    expect(JSON.parse(await readFile(join(root, "installed.json"), "utf8")).profile).toBe(old.profile);
    expect(await Bun.file(join(root, "activation.json")).exists()).toBe(false);
    return;
  }
  expect(receipt.phase).toBe("activated");
  const captured = JSON.parse(await readFile(join(root, "installed.json"), "utf8"));
  expect(captured.profile).toBe(old.profile);
  expect(captured.enabled).toBe(false);
  expect(await readFile(join(root, "backup", "registry.json"))).toEqual(old.snapshot);
  expect(JSON.parse(await readFile(old.registry, "utf8"))).toEqual({ ...old.config, plugins: { ...old.config.plugins, "omp-settings-ru": { ...old.config.plugins["omp-settings-ru"], version: "0.2.1" } } });
  await writeFile(join(root, "before-session.lease"), JSON.stringify({pid:process.pid,profile:old.profile}));
  const repeated = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  expect(repeated.phase).toBe("activated");
  expect(repeated.refusal).toBeUndefined();
  expect(await readFile(join(root, "backup", "registry.json"))).toEqual(old.snapshot);
}), 180_000);

test("completed activation replay ignores a held lock and lease and refuses drift", () => fixture(async root => {
  const old = await installedFixture(root);
  const fixed = await packageFixture(root);
  await rm(join(root, "installed.json"));
  await rm(join(root, "previous.tgz"));
  await rm(join(root, "activation-target.json"));
  const first = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("replay activation first receipt: " + JSON.stringify(first) + " root=" + root + " profile=" + old.profile);
  if (process.platform !== "win32") {
    expect(first.phase).toBe("safe-pending");
    return;
  }
  expect(first.phase).toBe("activated");
  const receiptPath = join(root, "activation.json");
  const activatedBytes = await readFile(receiptPath);
  const activated = JSON.parse(activatedBytes.toString());
  const registryBytes = await readFile(old.registry);
  // A foreign activation lock and a held before-session lease must not be re-entered: the receipt is the proof.
  const lock = join(dirname(old.registry), "updater-activation.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  await writeFile(join(root, "before-session.lease"), JSON.stringify({ pid: process.pid, profile: old.profile }));
  const repeated = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("replay activation repeat receipt: " + JSON.stringify(repeated));
  expect(repeated.phase).toBe("activated");
  expect(repeated.refusal).toBeUndefined();
  expect(await readFile(old.registry)).toEqual(registryBytes);
  expect(await readFile(receiptPath)).toEqual(activatedBytes);
  expect(await readFile(lock, "utf8")).toBe(JSON.stringify({ pid: process.pid }));
  // A genuinely active session on the target profile must not re-open the activation path either.
  const child = Bun.spawn([executable, "--profile", old.profile, "--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-title", "--model", "openai/gpt-4o", "--cwd", root], { env: ownedEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    child.stdin.write('{"id":"ready","type":"get_state"}\n');
    const reader = child.stdout.getReader();
    let response = "";
    while (!response.includes('"id":"ready"')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("owned RPC target exited before readiness");
      response += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const activeRegistry = await readFile(old.registry);
    const activeSession = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
    console.log("replay activation active-session receipt: " + JSON.stringify(activeSession));
    expect(activeSession.phase).toBe("activated");
    expect(activeSession.refusal).toBeUndefined();
    expect(await readFile(old.registry)).toEqual(activeRegistry);
  } finally { child.kill(); await child.exited; }
  // Drift in the activated profile registry is a package conflict, never a fresh activation.
  await writeFile(old.registry, registryBytes.toString().replace('"omp-settings-ru"', '"omp-settings-ru-drifted"'));
  const drifted = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("replay activation drifted-registry receipt: " + JSON.stringify(drifted));
  expect(drifted.phase).toBe("blocked");
  expect(drifted.refusal).toBe("activated-package-conflict");
  await writeFile(old.registry, registryBytes);
  // Changed bytes at the receipt target are the same conflict class.
  const installedPath = join(activated.target, "src", "index.ts");
  const installedBytes = await readFile(installedPath);
  const installedMode = (await lstat(installedPath)).mode;
  try {
    await chmod(installedPath, 0o644);
    await writeFile(installedPath, "foreign bytes");
    const tampered = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
    console.log("replay activation tampered-bytes receipt: " + JSON.stringify(tampered));
    expect(tampered.phase).toBe("blocked");
    expect(tampered.refusal).toBe("activated-package-conflict");
  } finally {
    await writeFile(installedPath, installedBytes);
    await chmod(installedPath, installedMode);
  }
  expect(await readFile(installedPath)).toEqual(installedBytes);
  // A receipt bound to another pin, and a malformed receipt, are refused without re-activating.
  await writeFile(receiptPath, JSON.stringify({ ...activated, pin: { ...fixed, sha256: "c".repeat(64) } }));
  const wrongPin = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("replay activation wrong-pin receipt: " + JSON.stringify(wrongPin));
  expect(wrongPin.phase).toBe("blocked");
  expect(wrongPin.refusal).toBe("activation-receipt-conflict");
  await writeFile(receiptPath, "{ malformed");
  const malformed = await runControllerUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("replay activation malformed-receipt receipt: " + JSON.stringify(malformed));
  expect(malformed.phase).toBe("blocked");
  expect(malformed.refusal).toBe("activation-receipt-conflict");
  expect(await readFile(old.registry)).toEqual(registryBytes);
}), 180_000);

test("activation preserves disabled feature metadata and sibling registry", () => fixture(async root => {
  const old = await installedFixture(root);
  const fixed = await packageFixture(root);
  const receipt = await runUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("registry activation receipt: " + JSON.stringify(receipt));
  if (process.platform !== "win32") {
    expect(receipt.phase).toBe("safe-pending");
    expect(receipt.refusal).toBe("active-session-or-liveness-unverifiable");
    expect(await readFile(old.registry)).toEqual(old.snapshot);
    expect(await readFile(join(old.target, "src", "index.ts"), "utf8")).toBe('export default function() {}');
    return;
  }
  expect(receipt.phase).toBe("activated");
  const config = JSON.parse(await readFile(old.registry, "utf8"));
  expect(config).toEqual({ ...old.config, plugins: { ...old.config.plugins, "omp-settings-ru": { ...old.config.plugins["omp-settings-ru"], version: "0.2.1" } } });
  expect(await readFile(join(old.target, "src", "index.ts"), "utf8")).toBe('export default function() {}');
  console.log("registry preservation: enabled=false, features=[optional], settings retained, sibling retained");
}), 180_000);

test("failed real activation rolls back exact registry and previous package", () => fixture(async root => {
  const old = await installedFixture(root);
  const fixed = await packageFixture(root);
  // Exclusive registry replacement fails after the real native link switch.
  await writeFile(`${old.registry}.new`, "existing replacement must not be overwritten");
  const receipt = await runUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  console.log("rollback activation receipt: " + JSON.stringify(receipt) + " root=" + root + " profile=" + old.profile);
  if (process.platform !== "win32") {
    expect(receipt.phase).toBe("safe-pending");
    expect(receipt.refusal).toBe("active-session-or-liveness-unverifiable");
    expect(await readFile(old.registry)).toEqual(old.snapshot);
    expect(await readFile(`${old.registry}.new`, "utf8")).toBe("existing replacement must not be overwritten");
    expect(await Bun.file(join(root, "activation-rollback.json")).exists()).toBe(false);
    await rm(`${old.registry}.new`);
    return;
  }
  expect(receipt.phase).toBe("rolled-back");
  await rm(`${old.registry}.new`);
  expect(await readFile(old.registry)).toEqual(old.snapshot);
  expect(await readFile(join(root, "previous.tgz"))).toEqual(Buffer.from(old.oldBytes));
  const proof = JSON.parse(await readFile(join(root, "activation-rollback.json"), "utf8"));
  expect(proof.packageRestored).toBe(true);
  expect(proof.rollbackSmoke).toBe(true);
  expect(proof.restoredVersion).toBe("0.2.0");
  expect(proof.registryRestored).toBe(true);
  console.log("real activation rollback: 0.2.0 -> 0.2.1 -> 0.2.0; exact registry bytes restored");
}), 180_000);

test("accepted activation refuses missing trusted target instead of inventing profile", () => fixture(async root => {
  const fixed = await packageFixture(root);
  const receipt = await runUpdate({ ...options(root), pin: fixed, activate: true, accepted: true });
  expect(receipt.phase).toBe("blocked");
  expect(receipt.refusal).toBe("activation-target-unavailable");
}), 120_000);

test("held before-session lease defers activation without touching registry", () => fixture(async root => {
  const old = await installedFixture(root);
  const fixed = await packageFixture(root);
  await writeFile(join(root, "before-session.lease"), JSON.stringify({ pid: process.pid, profile: old.profile }), { flag: "wx" });
  const receipt = await runUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
  expect(receipt.phase).toBe("safe-pending");
  expect(receipt.refusal).toBe("before-session-lease-held");
  expect(await readFile(old.registry)).toEqual(old.snapshot);
}), 180_000);

test("matching active target process defers with unchanged previous registry", () => fixture(async root => {
  const old = await installedFixture(root);
  const fixed = await packageFixture(root);
  const env = ownedEnvironment();
  const child = Bun.spawn([executable, "--profile", old.profile, "--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-title", "--model", "openai/gpt-4o", "--cwd", root], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    child.stdin.write('{"id":"ready","type":"get_state"}\n');
    const reader = child.stdout.getReader();
    let response = "";
    while (!response.includes('"id":"ready"')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("owned RPC target exited before readiness");
      response += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const receipt = await runUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
    expect(receipt.phase).toBe("safe-pending");
    expect(receipt.refusal).toBe("active-session-or-liveness-unverifiable");
    expect(await readFile(old.registry)).toEqual(old.snapshot);
    child.kill();
    await child.exited;
    const resumed = await runUpdate({ ...options(root), pin: fixed, activate: true, accepted: true, targetProfile: old.profile });
    if (process.platform !== "win32") {
      expect(resumed.phase).toBe("safe-pending");
      expect(resumed.refusal).toBe("active-session-or-liveness-unverifiable");
      expect(await readFile(old.registry)).toEqual(old.snapshot);
      expect(await Bun.file(join(root, "activation.json")).exists()).toBe(false);
      return;
    }
    expect(resumed.phase).toBe("activated");
    const installed = Bun.spawn([executable, "--profile", old.profile, "plugin", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    const listing = JSON.parse(await new Response(installed.stdout).text());
    expect(await installed.exited).toBe(0);
    expect(listing.npm.find((p: { name: string }) => p.name === "omp-settings-ru").version).toBe("0.2.1");
  } finally { child.kill(); await child.exited; }
}), 180_000);

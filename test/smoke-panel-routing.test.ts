import { expect, mock, test } from "bun:test";
import { copyFile, cp, mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  // A real child process cannot be stopped by fake timers.
  const timer = setTimeout(() => reject(new Error(message)), ms);
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface ManagedOutput {
  text: Promise<string>;
  readonly closed: boolean;
  cancel(): Promise<void>;
}

// A rejected read or a pending cancellation is not proof that a pipe is closed.
function managedOutput(stream: ReadableStream<Uint8Array>): ManagedOutput {
  const reader = stream.getReader();
  let closed = false;
  let cancelling = false;
  const text = (async () => {
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const result = await reader.read();
      if (result.done) {
        if (!cancelling) closed = true;
        return output + decoder.decode();
      }
      output += decoder.decode(result.value, { stream: true });
    }
  })();
  // The other reader or process setup may fail before the caller awaits this one.
  void text.catch(() => {});
  return {
    text,
    get closed() { return closed; },
    async cancel() {
      cancelling = true;
      await reader.cancel();
      closed = true;
    },
  };
}

// Only the test's worker owns this directory. A rejected exit promise is not proof of exit.
async function cleanupWorker(
  child: { kill(signal?: number | NodeJS.Signals): unknown; unref(): void },
  root: string,
  exit: Promise<number>,
  streams: ManagedOutput[],
  failures: unknown[],
  graceMs = 1_000,
  deadlineMs = 3_000,
) {
  let exited = false;
  const confirmedExit = exit.then(() => { exited = true; });
  const drained = Promise.allSettled(streams.map(stream => stream.text.catch(error => {
    if (!failures.includes(error)) failures.push(error);
    throw error;
  })));
  if (failures.length > 0) {
    try { child.kill(); } catch (error) { failures.push(error); }
  }
  try {
    await within(confirmedExit, graceMs, "panel smoke worker did not exit before cleanup");
  } catch {
    if (!exited) {
      try { child.kill("SIGKILL"); } catch (error) { failures.push(error); }
    }
  }
  try {
    await within(confirmedExit, deadlineMs, "panel smoke worker did not exit after forced termination");
  } catch (error) {
    failures.push(error);
  }
  if (!exited) child.unref();
  try {
    await within(drained, deadlineMs, "panel smoke worker output did not drain");
  } catch (error) {
    failures.push(error);
  }
  const cancellations = await Promise.allSettled(streams.filter(stream => !stream.closed).map(stream =>
    within(stream.cancel(), deadlineMs, "panel smoke worker output cancellation timed out")));
  for (const result of cancellations) {
    if (result.status === "rejected" && !failures.includes(result.reason)) failures.push(result.reason);
  }
  if (exited && streams.length === 2 && streams.every(stream => stream.closed)) {
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  } else {
    failures.push(new Error(`panel smoke temporary directory retained: ${root}`));
  }
}

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

async function installedPackage(specifier: string, from: string, expectedName = specifier) {
  const entry = await realpath(Bun.resolveSync(specifier, from));
  // The package need not export package.json. Walk up from its resolved entry point.
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const file = Bun.file(join(dir, "package.json"));
    if (await file.exists()) {
      const manifest: PackageManifest = await file.json();
      if (manifest.name === expectedName) return { dir, manifest };
    }
    if (dir === dirname(dir)) throw new Error(`Could not find ${expectedName} manifest for ${entry}`);
  }
}

async function linkPackage(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, "junction");
}

async function isolatedWorker(root: string, fixture: { alias: string; version: string }) {
  const scratch = join(root, "fixture");
  const scratchModules = join(scratch, "node_modules");
  const hostName = "@oh-my-pi/pi-coding-agent";
  const tuiName = "@oh-my-pi/pi-tui";
  const sourceHost = await installedPackage(fixture.alias, projectRoot, hostName);
  const sourceTui = await installedPackage(tuiName, sourceHost.dir);
  expect(sourceHost.manifest.version).toBe(fixture.version);
  expect(sourceTui.manifest.version).toBe(fixture.version);

  // Copy the host and the TUI it resolves so the worker and the host share one TUI instance.
  const host = join(scratchModules, hostName);
  const tui = join(scratchModules, tuiName);
  for (const [source, target] of [[sourceHost.dir, host], [sourceTui.dir, tui]] as const) {
    await mkdir(target, { recursive: true });
    await cp(join(source, "src"), join(target, "src"), { recursive: true });
    await copyFile(join(source, "package.json"), join(target, "package.json"));
  }
  await symlink(join(sourceHost.dir, "dist"), join(host, "dist"), "junction");

  // Leave other packages at their installed realpaths so their own transitive imports
  // still use Bun's dependency graph. The worker's host adapter shares the host's pi-utils.
  const hostDependencies = new Map<string, string>();
  for (const name of Object.keys(sourceHost.manifest.dependencies ?? {})) {
    if (name === tuiName) continue;
    const { dir } = await installedPackage(name, sourceHost.dir);
    hostDependencies.set(name, dir);
    await linkPackage(dir, join(scratchModules, name));
  }
  for (const name of Object.keys(sourceTui.manifest.dependencies ?? {})) {
    const { dir } = await installedPackage(name, sourceTui.dir);
    if (hostDependencies.get(name) !== dir) {
      await linkPackage(dir, join(tui, "node_modules", name));
    }
  }
  await cp(join(projectRoot, "src"), join(scratch, "src"), { recursive: true });
  await mkdir(join(scratch, "scripts"));
  for (const name of ["smoke-panel-worker.ts", "panel-search.ts", "panel-host-routing.ts"]) {
    await copyFile(join(projectRoot, "scripts", name), join(scratch, "scripts", name));
  }
  return join(scratch, "scripts", "smoke-panel-worker.ts");
}

async function runPanelSmoke(fixture?: { alias: string; version: string }) {
  const root = await mkdtemp(join(tmpdir(), "omp-settings-ru-"));
  const failures: unknown[] = [];
  let started = false;
  try {
    const worker = fixture ? await isolatedWorker(root, fixture) : join(projectRoot, "scripts", "smoke-panel-worker.ts");
    const hostPath = join(dirname(worker), "..", "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json");
    const host = await Bun.file(hostPath).json();
    const expectedHostVersion = fixture?.version ??
      (await Bun.file(join(projectRoot, "package.json")).json()).devDependencies["@oh-my-pi/pi-coding-agent"];
    expect(host.version).toBe(expectedHostVersion);
    const home = join(root, "home");
    const cwd = join(root, "project");
    await mkdir(home);
    await mkdir(cwd);
    const env: Record<string, string> = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PI_CODING_AGENT_DIR: join(home, ".omp", "agent"), TERM: "xterm-256color" });
    const child = Bun.spawn([process.execPath, worker], { cwd, env, stdout: "pipe", stderr: "pipe" });
    started = true;
    const streams: ManagedOutput[] = [];
    try {
      const stdout = managedOutput(child.stdout);
      streams.push(stdout);
      const stderr = managedOutput(child.stderr);
      streams.push(stderr);
      const [result, output, errors] = await within(Promise.all([child.exited, stdout.text, stderr.text]), 60_000, "panel smoke worker timed out after 60 seconds");
      expect(result, errors).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ hostVersion: expectedHostVersion, russianSearch: true, nativeBooleanEdit: true, staticOptions: true, originalEnumValue: true, englishRestore: true, childOwnership: true, shutdownRestore: true, ok: true });
    } catch (error) {
      failures.push(error);
    } finally {
      await cleanupWorker(child, root, child.exited, streams, failures);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (!started) {
      try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "panel smoke failed and cleanup also failed");
}

test("panel smoke completes for the installed root host", () => runPanelSmoke(), 120_000);
test("panel smoke completes for the isolated legacy host", () => runPanelSmoke({ alias: "omp-api-1911", version: "19.1.1" }), 120_000);
test("panel smoke completes for the isolated modern host", () => runPanelSmoke({ alias: "omp-api-1920", version: "19.2.0" }), 120_000);

test("cleanup detaches the worker but retains the temporary directory when exit is unconfirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-settings-ru-cleanup-"));
  const { promise: exit, resolve: finish } = Promise.withResolvers<number>();
  const failures: unknown[] = [];
  const killError = new Error("termination failed");
  const child = { kill() { throw killError; }, unref: mock(() => {}) };
  try {
    const closedStream = () => managedOutput(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
    await cleanupWorker(child, root, exit, [closedStream(), closedStream()], failures, 10, 10);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(failures).toContain(killError);
    expect(failures.some(error => error instanceof Error && error.message.includes("retained"))).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
  } finally {
    finish(0);
    await exit;
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup retains the directory when output cancellation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-settings-ru-cleanup-"));
  const cancelError = new Error("output cancellation failed");
  const failures: unknown[] = [];
  const pending = managedOutput(new ReadableStream<Uint8Array>({ cancel() { throw cancelError; } }));
  const closed = managedOutput(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
  const child = { kill() {}, unref: mock(() => {}) };
  try {
    await cleanupWorker(child, root, Promise.resolve(0), [pending, closed], failures, 10, 10);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(failures).toContain(cancelError);
    expect(failures.some(error => error instanceof Error && error.message.includes("retained"))).toBe(true);
    expect(child.unref).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup removes the directory after output cancellation is confirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-settings-ru-cleanup-"));
  const failures: unknown[] = [];
  const pending = managedOutput(new ReadableStream<Uint8Array>());
  const closed = managedOutput(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
  const child = { kill() {}, unref: mock(() => {}) };
  try {
    await cleanupWorker(child, root, Promise.resolve(0), [pending, closed], failures, 10, 10);
    expect(pending.closed).toBe(true);
    expect(await stat(root).then(() => true, () => false)).toBe(false);
    expect(failures.some(error => error instanceof Error && error.message.includes("retained"))).toBe(false);
    expect(child.unref).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup retains the directory when a read fails without confirmed cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-settings-ru-cleanup-"));
  const readError = new Error("output read failed");
  const failures: unknown[] = [];
  const failed = managedOutput(new ReadableStream<Uint8Array>({ start(controller) { controller.error(readError); } }));
  const closed = managedOutput(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
  const child = { kill() {}, unref: mock(() => {}) };
  try {
    await cleanupWorker(child, root, Promise.resolve(0), [failed, closed], failures, 10, 10);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(failures).toContain(readError);
    expect(failures.some(error => error instanceof Error && error.message.includes("retained"))).toBe(true);
    expect(child.unref).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup retains the directory while output cancellation is unconfirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-settings-ru-cleanup-"));
  const { promise: cancellation, resolve: finish } = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  const pending = managedOutput(new ReadableStream<Uint8Array>({ cancel() { return cancellation; } }));
  const closed = managedOutput(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
  const child = { kill() {}, unref: mock(() => {}) };
  try {
    await cleanupWorker(child, root, Promise.resolve(0), [pending, closed], failures, 10, 10);
    expect(pending.closed).toBe(false);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(failures.some(error => error instanceof Error && error.message.includes("retained"))).toBe(true);
    expect(child.unref).not.toHaveBeenCalled();
  } finally {
    finish();
    await cancellation;
    await rm(root, { recursive: true, force: true });
  }
});

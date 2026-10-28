import { afterEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedGitHub } from "../scripts/maintenance/actions-github";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";
import { discover } from "../scripts/maintenance-actions";
import { canStartPreparation } from "../scripts/maintenance/outcome";

// Real gh bridge and unzip subprocesses are deliberately exercised on Windows too.
setDefaultTimeout(30_000);

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { mock.restore(); for (const action of cleanup.splice(0).reverse()) await action(); });
const baseSha = "a".repeat(40);
const candidateVersion = "18.13.4";
const repository = rawPolicy.repository;

/** A real stored ZIP entry; the production unzip process reads these exact bytes. */
function outcomeZip(value: unknown): Uint8Array {
  const name = Buffer.from("maintenance-outcome.json"); const bytes = Buffer.from(JSON.stringify(value));
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}
interface Cycle { readonly id: number; readonly attempt?: number; readonly activeAttempt?: number; readonly expired?: boolean; readonly missing?: boolean; readonly selected?: boolean; readonly reason?: string; readonly retryable?: boolean; readonly foreign?: boolean; readonly extraArtifacts?: number; readonly value?: unknown; readonly path?: string; readonly artifactRunId?: number; readonly artifactAttempt?: number; readonly retryBlocked?: true; readonly httpStatus?: number; readonly selectionUploadFailed?: boolean }
async function transport(cycles: readonly Cycle[], base = baseSha) {
  const root = await mkdtemp(join(tmpdir(), "outcome-http-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const run = (cycle: Cycle, attempt = cycle.attempt ?? 1) => ({ id: cycle.id, run_attempt: attempt, status: attempt === cycle.activeAttempt ? "in_progress" : "completed", conclusion: attempt === cycle.activeAttempt ? null : "failure", path: cycle.path ?? ".github/workflows/upstream-watch.yml", event: "workflow_dispatch", head_branch: "main", head_sha: base, repository: { id: 7, full_name: cycle.foreign ? "foreign/repository" : repository } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url); const path = url.pathname; requests.push(path + url.search);
    if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
    if (path.endsWith("/pulls")) return Response.json([]);
    if (path.endsWith("/actions/workflows/upstream-watch.yml/runs")) return Response.json({ workflow_runs: cycles.map(cycle => run(cycle)) });
    const attempt = path.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)$/);
    if (attempt) { const cycle = cycles.find(item => item.id === Number(attempt[1])); return cycle ? Response.json(run(cycle, Number(attempt[2]))) : new Response(null, { status: 404 }); }
    if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(path)) {
      const cycle = cycles.find(item => path.includes(`/runs/${item.id}/`));
      return Response.json({ jobs: [{ name: "prepare", conclusion: "skipped" }, { name: "discover", steps: cycle?.selectionUploadFailed ? [{ name: `Record selected candidate ${candidateVersion}`, conclusion: "failure" }] : [] }] });
    }
    const artifacts = path.match(/\/actions\/runs\/(\d+)\/artifacts$/);
    if (artifacts) {
      const cycle = cycles.find(item => item.id === Number(artifacts[1]))!;
      const values: unknown[] = Array.from({ length: cycle.extraArtifacts ?? 0 }, (_, index) => ({ id: 1000 + index, name: `prepared-unrelated-${index}`, expired: false }));
      for (let attempt = 1; attempt <= (cycle.attempt ?? 1); attempt++) {
        if (cycle.selected !== false) values.push({ id: cycle.id * 100 + attempt, name: `maintenance-selection-${candidateVersion}-${cycle.id}-${attempt}` });
        if (!cycle.missing) values.push({ id: cycle.id * 10 + attempt, name: `maintenance-outcome-${cycle.id}-${cycle.artifactAttempt ?? attempt}`, expired: cycle.expired ?? false, expires_at: "2099-01-01T00:00:00Z", size_in_bytes: 1000, workflow_run: { id: cycle.artifactRunId ?? cycle.id, head_sha: base, head_branch: "main", repository_id: 7, head_repository_id: 7 } });
      }
      const page = Number(url.searchParams.get("page")); return Response.json({ artifacts: values.slice((page - 1) * 100, page * 100) });
    }
    const zip = path.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (zip) {
      const cycle = cycles.find(item => Math.floor(Number(zip[1]) / 10) === item.id);
      if (!cycle) return new Response(null, { status: 404 });
      if (cycle.httpStatus) return new Response(null, { status: cycle.httpStatus });
      return new Response(Buffer.from(outcomeZip(cycle.value ?? { schemaVersion: 1, baseSha: base, candidateVersion, stage: "discover", outcome: "blocked", reason: cycle.reason ?? "companion-package-unavailable", retryable: cycle.retryable ?? true, ...(cycle.retryBlocked ? { retryBlocked: true } : {}) })));
    }
    return new Response(null, { status: 404 });
  } }); cleanup.push(() => server.stop(true));
  const bridge = join(root, "gh.ts");
  await writeFile(bridge, `const args=process.argv.slice(2);if(args[0]!=="api")process.exit(2);const response=await fetch(${JSON.stringify(server.url.href)}+args[1],{headers:{authorization:"Bearer "+process.env.GH_TOKEN}});if(!response.ok)process.exit(1);process.stdout.write(new Uint8Array(await response.arrayBuffer()));`);
  const spawn = Bun.spawn;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: Bun.SpawnOptions.OptionsObject<"pipe", "pipe", "pipe">) => command[0] === "gh" ? spawn([process.execPath, bridge, ...command.slice(1)], options) : spawn(command, options)) as typeof Bun.spawn);
  return { github: new HostedGitHub(validatePolicy(rawPolicy), "fixture-token"), requests };
}

test("real HTTP artifact transport enforces persisted preparation budget and skips prepared bundles", async () => {
  const fixture = await transport([{ id: 101, extraArtifacts: 105 }, { id: 102 }]);
  const history = await fixture.github.readOutcomes(baseSha, candidateVersion);
  expect(history).toHaveLength(2);
  expect(canStartPreparation(history, baseSha, candidateVersion, false)).toBe(false);
  expect(fixture.requests.filter(path => path.endsWith("/zip"))).toEqual([`/repos/${repository}/actions/artifacts/1021/zip`, `/repos/${repository}/actions/artifacts/1011/zip`]);
  expect(fixture.requests.some(path => path.includes("page=2"))).toBe(true);
});
for (const kind of ["missing", "expired", "foreign", "wrong-content"] as const) test(`real transport fails closed for ${kind} outcome`, async () => {
  const fixture = await transport([{ id: 103, ...(kind === "missing" ? { missing: true } : kind === "expired" ? { expired: true } : kind === "foreign" ? { foreign: true } : { value: { schemaVersion: 1, baseSha, candidateVersion: "18.13.5", stage: "discover", outcome: "blocked", reason: "registry-timeout", retryable: true } }) }]);
  await expect(fixture.github.readOutcomes(baseSha, candidateVersion)).rejects.toThrow(kind === "missing" || kind === "expired" ? "maintenance-outcome-unavailable" : "maintenance-outcome-origin-invalid");
});

test("same-run repeated attempts remain distinct durable failed cycles", async () => {
  const fixture = await transport([{ id: 104, attempt: 2, retryable: false, reason: "candidate-content-invalid" }]);
  const history = await fixture.github.readOutcomes(baseSha, candidateVersion);
  expect(history).toHaveLength(2);
  expect(canStartPreparation(history, baseSha, candidateVersion, false)).toBe(false);
  expect(canStartPreparation(history, baseSha, candidateVersion, true)).toBe(true);
});

for (const retryable of [false, true]) test(`current run retains ${retryable ? "two retryable" : "nonretryable"} completed failures before its active attempt`, async () => {
  const attempt = retryable ? 3 : 2;
  const fixture = await transport([{ id: 111, attempt, activeAttempt: attempt, retryable, reason: retryable ? "companion-package-unavailable" : "candidate-content-invalid" }]);
  const previous = { GITHUB_RUN_ID: process.env.GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT };
  process.env.GITHUB_RUN_ID = "111"; process.env.GITHUB_RUN_ATTEMPT = String(attempt);
  try {
    const history = await fixture.github.readOutcomes(baseSha, candidateVersion);
    expect(history).toHaveLength(attempt - 1);
    expect(canStartPreparation(history, baseSha, candidateVersion, false)).toBe(false);
    expect(canStartPreparation(history, baseSha, candidateVersion, true)).toBe(true);
    expect(fixture.requests.filter(path => path.endsWith("/zip"))).toHaveLength(attempt - 1);
    expect(fixture.requests.some(path => path.endsWith(`/artifacts/111${attempt}/zip`))).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("failure before selection does not invent a candidate or poison a later cycle", async () => {
  const fixture = await transport([{ id: 105, missing: true, selected: false }]);
  expect(await fixture.github.readOutcomes(baseSha, candidateVersion)).toEqual([]);
  expect(fixture.requests.some(path => path.endsWith("/zip"))).toBe(false);
});

test("discovery consumes real durable outcomes before companion requests or preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-discover-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { "@oh-my-pi/pi-coding-agent": "18.13.3" } }));
  // The real accepted manifest path is retained inside this isolated Git repository.
  await mkdir(join(root, "test/fixtures/host-snapshots"), { recursive: true });
  await writeFile(join(root, "test/fixtures/host-snapshots/supported-hosts.json"), JSON.stringify({ schemaVersion: 1, historical: [], versions: ["18.13.1", "18.13.2", "18.13.3"].map(version => ({ version, package: `omp-host-${version.replaceAll(".", "")}`, platforms: ["win32", "darwin", "linux"], baselines: { win32: "a".repeat(64), darwin: "b".repeat(64), linux: "c".repeat(64) } })) }));
  git("init", "-b", "main"); git("add", "."); git("commit", "-m", "accepted"); const base = git("rev-parse", "HEAD");
  const fixture = await transport([{ id: 106, retryable: false, reason: "candidate-content-invalid" }], base);
  const actualFetch = globalThis.fetch;
  let companionRequests = 0;
  spyOn(globalThis, "fetch").mockImplementation(((url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent") return Promise.resolve(Response.json({ "dist-tags": { latest: candidateVersion }, versions: Object.fromEntries(["18.13.2", "18.13.3", candidateVersion].map(version => [version, { version }])) }));
    if (String(url).startsWith("https://registry.npmjs.org/")) { companionRequests++; return Promise.resolve(new Response(null, { status: 404 })); }
    return actualFetch(url, init);
  }) as typeof fetch);
  const paused = process.env.MAINTENANCE_PAUSED; const retry = process.env.RETRY_BLOCKED;
  delete process.env.MAINTENANCE_PAUSED; delete process.env.RETRY_BLOCKED;
  const event = process.env.GITHUB_EVENT_NAME; const output = process.env.GITHUB_OUTPUT; const summary = process.env.GITHUB_STEP_SUMMARY;
  const outputPath = join(root, "outputs.txt");
  process.env.GITHUB_OUTPUT = outputPath; delete process.env.GITHUB_STEP_SUMMARY;
  try {
    await expect(discover(root, base, validatePolicy(rawPolicy), fixture.github)).rejects.toThrow("maintenance-outcome-blocked");
    expect(companionRequests).toBe(0);
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"; process.env.RETRY_BLOCKED = "true";
    await expect(discover(root, base, validatePolicy(rawPolicy), fixture.github)).rejects.toThrow("companion-package-unavailable");
    expect(await Bun.file(outputPath).text()).toContain(`version=${candidateVersion}\n`);
  } finally {
    for (const [key, value] of Object.entries({ MAINTENANCE_PAUSED: paused, RETRY_BLOCKED: retry, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  expect(companionRequests).toBe(1);
  expect(fixture.requests.some(path => path.endsWith("/1061/zip"))).toBe(true);
});

test("actual secret-free writer consumes CLI outputs and preserves cancellation and retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-writer-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const writer = join(import.meta.dir, "../scripts/maintenance/outcome.ts");
  for (const [result, outputs, expected] of [
    ["failure", { reason: "registry-http-503", retryable: "true" }, { outcome: "blocked", retryable: true, reason: "registry-http-503" }],
    ["cancelled", {}, { outcome: "blocked", retryable: false, reason: "publish-cancelled" }],
    ["success", { outcome: "retired" }, { outcome: "retired", retryable: false, reason: "retired" }],
  ] as const) {
    const child = Bun.spawn([process.execPath, writer], { cwd: root, env: { PATH: process.env.PATH, GITHUB_SHA: baseSha, GITHUB_EVENT_NAME: "workflow_dispatch", RETRY_BLOCKED: "false", OUTCOME_NEEDS: JSON.stringify({ discover: { result: "success", outputs: { base: baseSha, version: candidateVersion, mode: "resume" } }, publish: { result, outputs } }) }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(await Bun.file(join(root, "maintenance-outcome.json")).json()).toMatchObject(expected);
  }
});

test("actual outcome writer keeps discovery prerequisites retryable but rejects verification denials", async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-stage-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const writer = join(import.meta.dir, "../scripts/maintenance/outcome.ts");
  for (const [stage, reason, retryable] of [
    ["discover", "native-asset-unavailable", true],
    ["discover", "companion-package-unavailable", true],
    ["verify", "native-asset-unavailable", false],
    ["verify", "companion-package-unavailable", false],
    ["verify", "github-http-401", false],
    ["verify", "github-http-403", false],
    ["verify", "github-http-404", false],
    ["verify", "github-http-429", true],
    ["verify", "github-http-503", true],
  ] as const) {
    const needs = { discover: { result: "success", outputs: { base: baseSha, version: candidateVersion, mode: "prepare" } }, [stage]: { result: "failure", outputs: { base: baseSha, version: candidateVersion, mode: "prepare", reason, retryable: "true" } } };
    const child = Bun.spawn([process.execPath, writer], { cwd: root, env: { PATH: process.env.PATH, GITHUB_SHA: baseSha, OUTCOME_NEEDS: JSON.stringify(needs) }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(await Bun.file(join(root, "maintenance-outcome.json")).json()).toMatchObject({ baseSha, candidateVersion, stage, reason, retryable });
  }
});

for (const checkoutBase of ["queued", "advanced"] as const) test(`queued producer A rejects advanced accepted main B before selection (${checkoutBase} checkout)`, async () => {
  const root = await mkdtemp(join(tmpdir(), "outcome-queued-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  await writeFile(join(root, "maintenance.config.json"), JSON.stringify(rawPolicy));
  git("init", "-b", "main"); git("add", "."); git("commit", "-m", "queued main A"); const queuedSha = git("rev-parse", "HEAD");
  await writeFile(join(root, "accepted.txt"), "accepted main B"); git("add", "."); git("commit", "-m", "advanced main B"); const acceptedSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", acceptedSha);
  if (checkoutBase === "queued") git("checkout", "--detach", queuedSha);
  const outputs = join(root, "outputs.txt"); const requests = join(root, "requests.txt");
  const preload = join(root, "reject-network.ts");
  await writeFile(preload, `import {appendFileSync} from "node:fs";globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(requests)},"fetch\\n");throw new Error("unexpected-network");};`);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../scripts/maintenance-actions.ts"), "discover"], { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: queuedSha, GITHUB_RUN_ID: "112", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: outputs }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(stderr).toContain(checkoutBase === "queued" ? "trusted-code-not-accepted-main" : "trusted-discovery-run-base-mismatch");
  expect(stdout).not.toContain('"mode":"prepare"');
  const output = await Bun.file(outputs).text();
  expect(output).not.toContain("version=");
  expect(output).not.toContain("mode=prepare");
  expect(await Bun.file(requests).exists()).toBe(false);
});

for (const patch of [{ path: ".github/workflows/check.yml" }, { artifactRunId: 999 }, { artifactAttempt: 2 }, { httpStatus: 403 }, { httpStatus: 404 }]) test(`rejects foreign or unreadable exact outcome ${JSON.stringify(patch)}`, async () => {
  const fixture = await transport([{ id: 107, ...patch }]);
  await expect(fixture.github.readOutcomes(baseSha, candidateVersion)).rejects.toThrow();
});

test("persisted manual reset permits a new budget without reopening older missing cycles", async () => {
  const fixture = await transport([{ id: 108, missing: true }, { id: 109, retryBlocked: true }]);
  const history = await fixture.github.readOutcomes(baseSha, candidateVersion);
  expect(history).toHaveLength(1);
  expect(canStartPreparation(history, baseSha, candidateVersion, false)).toBe(true);
  expect(fixture.requests.some(path => path.includes("/runs/108/"))).toBe(false);
});

test("failed selection and outcome uploads cannot erase an already selected discovery cycle", async () => {
  const fixture = await transport([{ id: 110, missing: true, selected: false, selectionUploadFailed: true }]);
  await expect(fixture.github.readOutcomes(baseSha, candidateVersion)).rejects.toThrow("maintenance-outcome-unavailable");
});

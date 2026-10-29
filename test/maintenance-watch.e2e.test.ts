import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

/**
 * Domain and end-to-end proof for the local maintenance watcher.
 *
 * The watcher and its installer are Windows PowerShell 5.1 scripts, so these cases run only on
 * Windows. Every case drives the real script through `powershell.exe` with an isolated
 * `LOCALAPPDATA` root, a fixture `gh` process and a loopback registry. Nothing here touches the
 * real scheduled task, the real checkout or the real GitHub account, and no case installs a task.
 */

const windows = process.platform === "win32";
const it = windows ? test : test.skip;

// Every case starts a real Windows PowerShell 5.1 process (and some start two), which is far
// slower than in-process work; the default five-second budget would time out healthy cases.
setDefaultTimeout(120_000);

const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";
const POWERSHELL = join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const REPOSITORY = "narimanisakhanov-creator/omp-settings-ru";
const WATCHER = join(import.meta.dir, "..", "scripts", "maintenance-watch.ps1");
const INSTALLER = join(import.meta.dir, "..", "scripts", "install-maintenance-watch.ps1");
const WINDOW_FIXTURE = join(import.meta.dir, "fixtures", "upstream-window.json");
const BASE = "a".repeat(40);
const TASK_NAME = "omp-settings-ru-upstream-watch";
const WORKFLOW = "upstream-watch.yml";
const WATCHER_REMOTE_PATH = `repos/${REPOSITORY}/contents/scripts/maintenance-watch.ps1?ref=main`;

const WORKFLOW_PATH = `repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`;
const VARIABLES_PATH = `repos/${REPOSITORY}/actions/variables?per_page=100&page=1`;
const VARIABLES_PAGE2_PATH = `repos/${REPOSITORY}/actions/variables?per_page=100&page=2`;
const RUNS_PATH = `repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=1`;
const COMMIT_PATH = `repos/${REPOSITORY}/commits/main`;
const PULLS_PATH = `repos/${REPOSITORY}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`;
const PACKAGE_PATH = `repos/${REPOSITORY}/contents/package.json?ref=main`;
const POLICY_PATH = `repos/${REPOSITORY}/contents/maintenance.config.json?ref=main`;
const SUPPORT_PATH = `repos/${REPOSITORY}/contents/test/fixtures/host-snapshots/supported-hosts.json?ref=main`;
const releasePath = (version: string) => `repos/${REPOSITORY}/releases/tags/v${version}`;

/** Fixture `gh`: replays one scenario file, records every invocation, never opens a socket. */
const FAKE_GH = String.raw`param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-Prop {
    param($Value, [string]$Name)
    if ($null -eq $Value) { return }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) { return }
    Write-Output -NoEnumerate $property.Value
}
$dir = $env:OMP_WATCH_FIXTURE
if ([string]::IsNullOrEmpty($dir)) { Write-Output 'fixture-missing'; exit 90 }
$scenario = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText((Join-Path $dir 'scenario.json')))
$entry = [ordered]@{ args = @($Arguments) }
[IO.File]::AppendAllText((Join-Path $dir 'calls.jsonl'), ((ConvertTo-Json -InputObject $entry -Compress) + [Environment]::NewLine))
if ($Arguments.Count -eq 0) { Write-Output 'no-arguments'; exit 91 }
if ($Arguments[0] -eq 'auth') { exit [int](Get-Prop $scenario 'auth') }
if ($Arguments[0] -eq 'workflow') {
    $dispatch = Get-Prop $scenario 'dispatch'
    $message = Get-Prop $dispatch 'stdout'
    if (-not [string]::IsNullOrEmpty([string]$message)) { Write-Output ([string]$message) }
    exit [int](Get-Prop $dispatch 'exit')
}
if ($Arguments[0] -eq 'run') {
    $outcome = Get-Prop $scenario 'outcome'
    if ((Get-Prop $outcome 'artifact') -ne $true) { Write-Output 'artifact not found'; exit 1 }
    $target = $null
    for ($index = 1; $index -lt $Arguments.Count; $index++) {
        if ($Arguments[$index] -eq '--dir' -and ($index + 1) -lt $Arguments.Count) { $target = $Arguments[$index + 1]; break }
    }
    if ([string]::IsNullOrEmpty($target)) { Write-Output 'dir-missing'; exit 95 }
    if (-not (Test-Path -LiteralPath $target -PathType Container)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
    [IO.File]::WriteAllText((Join-Path $target 'maintenance-outcome.json'), [string](Get-Prop $outcome 'content'))
    exit 0
}
if ($Arguments[0] -ne 'api') { Write-Output 'unsupported-command'; exit 92 }
$path = $null
for ($index = 1; $index -lt $Arguments.Count; $index++) {
    $current = $Arguments[$index]
    if ($current -eq '-H') { $index++; continue }
    if ($current.StartsWith('-')) { continue }
    $path = $current
}
if ([string]::IsNullOrEmpty($path)) { Write-Output 'path-missing'; exit 93 }
$table = Get-Prop $scenario 'api'
$match = $null
if ($null -ne $table) { $match = $table.PSObject.Properties[$path] }
if ($null -eq $match) {
    Write-Output 'HTTP 404'
    exit 1
}
$status = 200
$declared = Get-Prop $match.Value 'status'
if ($null -ne $declared) { $status = [int]$declared }
if ($status -ne 200) {
    Write-Output ('HTTP ' + $status)
    exit 1
}
$body = Get-Prop $match.Value 'body'
if (-not ($body -is [string])) { Write-Output 'fixture-body-invalid'; exit 94 }
Write-Output $body
exit 0
`;

interface ScenarioResponse { status?: number; body?: unknown }
interface Scenario {
  auth?: number;
  api?: Record<string, ScenarioResponse>;
  dispatch?: { exit?: number; stdout?: string };
  outcome?: { artifact?: boolean; content?: string };
}

interface WatcherWorkspace {
  root: string;
  localAppData: string;
  watchRoot: string;
  fixture: string;
  gh: string;
}

interface InstallerWorkspace extends WatcherWorkspace {
  installer: string;
}

interface Tick {
  code: number;
  decision: string;
  payload: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

const temporary: string[] = [];
let server: Server<unknown> | null = null;
let registryMode: { status: number; packument: unknown } = { status: 200, packument: {} };

beforeAll(() => {
  if (!windows) return;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.includes("pi-coding-agent")) return new Response("not found", { status: 404 });
      if (registryMode.status !== 200) return new Response("registry failure", { status: registryMode.status });
      return Response.json(registryMode.packument);
    },
  });
});

afterAll(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
  server?.stop(true);
  server = null;
});

function stablePackument(versions: readonly string[], latest: string) {
  return {
    "dist-tags": { latest },
    versions: Object.fromEntries(versions.map(version => [version, { version }])),
  };
}

/**
 * Isolated watch root: a directory whose name carries both spaces and Cyrillic, so every path the
 * scripts build is exercised against the characters that break naive quoting.
 */
async function workspace(name: string, withInstaller: boolean): Promise<InstallerWorkspace> {
  const root = await mkdtemp(join(tmpdir(), `omp watch Тест ${name} `));
  temporary.push(root);
  const localAppData = join(root, "local app data");
  const watchRoot = join(localAppData, "omp-settings-ru", "maintenance");
  const fixture = join(root, "fixture");
  const scripts = join(root, "scripts");
  await mkdir(watchRoot, { recursive: true });
  await mkdir(fixture, { recursive: true });
  await mkdir(scripts, { recursive: true });
  const gh = join(fixture, "gh.ps1");
  await writeFile(gh, FAKE_GH);
  const config = {
    schemaVersion: 1,
    repository: REPOSITORY,
    branch: "main",
    workflow: WORKFLOW,
    registry: `http://127.0.0.1:${server?.port ?? 1}`,
    gh,
  };
  await writeFile(join(watchRoot, "config.json"), JSON.stringify(config, null, 2));
  let installer = "";
  if (withInstaller) {
    await writeFile(join(scripts, "maintenance-watch.ps1"), await readFile(WATCHER, "utf8"));
    installer = join(scripts, "install-maintenance-watch.ps1");
    await writeFile(installer, await readFile(INSTALLER, "utf8"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "omp-settings-ru", repository: { type: "git", url: `git+https://github.com/${REPOSITORY}.git` } }),
    );
  }
  return { root, localAppData, watchRoot, fixture, gh, installer };
}

/**
 * Scenario bodies are written as raw JSON text, exactly like `gh api` output: PowerShell would
 * otherwise re-wrap arrays through `ConvertTo-Json -InputObject`, so the fixture never serializes.
 */
async function writeScenario(space: WatcherWorkspace, scenario: Scenario) {
  const api = Object.fromEntries(
    Object.entries(scenario.api ?? {}).map(([path, response]) => [
      path,
      typeof response.body === "string" || response.body === undefined ? response : { ...response, body: JSON.stringify(response.body) },
    ]),
  );
  await writeFile(join(space.fixture, "scenario.json"), JSON.stringify({ ...scenario, api }, null, 2));
}

/** One recorded fixture call; the shape is validated before it is trusted. */
function parseCall(line: string): readonly string[] {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || !("args" in value)) throw new Error("fixture-call-invalid");
  const args: unknown = value.args;
  if (!Array.isArray(args) || args.some(entry => typeof entry !== "string")) throw new Error("fixture-call-invalid");
  return args as readonly string[];
}

async function calls(space: WatcherWorkspace): Promise<readonly (readonly string[])[]> {
  const path = join(space.fixture, "calls.jsonl");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(parseCall);
}

async function dispatches(space: WatcherWorkspace) {
  return (await calls(space)).filter(args => args[0] === "workflow" && args[1] === "run");
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"));
  return lines.length === 0 ? {} : (JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>);
}

async function tick(space: WatcherWorkspace, args: readonly string[] = [], env: Record<string, string> = {}): Promise<Tick> {
  // The fixture registry runs in this process, so the tick must not block the event loop.
  const child = Bun.spawn([POWERSHELL, "-NoProfile", "-NonInteractive", "-File", WATCHER, ...args], {
    env: { ...process.env, LOCALAPPDATA: space.localAppData, OMP_WATCH_FIXTURE: space.fixture, MAINTENANCE_GH_TOKEN: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const payload = lastJsonLine(stdout);
  return { code, decision: String(payload.decision ?? ""), payload, stdout, stderr };
}

/** Healthy accepted state: three supported versions, matching registry window, nothing pending. */
function healthyApi(overrides: Record<string, ScenarioResponse> = {}): Record<string, ScenarioResponse> {
  return {
    [WORKFLOW_PATH]: { body: { state: "active" } },
    [VARIABLES_PATH]: { body: { total_count: 0, variables: [] } },
    [RUNS_PATH]: { body: { total_count: 0, workflow_runs: [] } },
    [COMMIT_PATH]: { body: { sha: BASE } },
    [PACKAGE_PATH]: { body: JSON.stringify({ devDependencies: { "@oh-my-pi/pi-coding-agent": "18.13.3" } }) },
    [POLICY_PATH]: { body: JSON.stringify({ controller: { controllerLogin: REPOSITORY.split("/")[0] } }) },
    [SUPPORT_PATH]: { body: JSON.stringify({ versions: [{ version: "18.13.1" }, { version: "18.13.2" }, { version: "18.13.3" }] }) },
    [PULLS_PATH]: { body: [] },
    ...overrides,
  };
}

const maintenanceBody = (releaseVersion: string) =>
  `Автоматически проверенная поддержка.\n\n<!-- omp-maintenance:v1 -->\n${JSON.stringify({
    schemaVersion: 1,
    repository: REPOSITORY,
    upstreamVersion: "18.13.3",
    releaseVersion,
    baseSha: BASE,
    headSha: "b".repeat(40),
    runId: "123",
    runAttempt: "2",
    artifactId: "42",
    manifestSha256: "c".repeat(64),
  })}\n<!-- /omp-maintenance -->`;

const mergedPull = (releaseVersion: string) => ({
  number: 7,
  state: "closed",
  merged_at: "2026-10-20T00:00:00Z",
  body: maintenanceBody(releaseVersion),
  user: { login: REPOSITORY.split("/")[0], type: "User" },
  base: { ref: "main", repo: { full_name: REPOSITORY } },
  head: { ref: "upgrade/omp-18.13.3", sha: "b".repeat(40), repo: { full_name: REPOSITORY } },
});

const publishedRelease = (releaseVersion: string) => ({ tag_name: `v${releaseVersion}`, draft: false, published_at: "2026-10-21T00:00:00Z" });

/** A finished run that already recorded an outcome artifact for the current base. */
const completedRunOnBase = (id: number, created: string) => ({
  id,
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
  head_sha: BASE,
  created_at: created,
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const blockedOutcome = (reason: string, retryable: boolean) =>
  JSON.stringify({ schemaVersion: 1, baseSha: BASE, candidateVersion: "18.13.4", stage: "verify", outcome: "blocked", reason, retryable });

describe("watcher domain decisions", () => {
  it("reports no-work when the published window already equals the registry window", async () => {
    const space = await workspace("no-work", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.1", "18.13.2", "18.13.3"], "18.13.3") };
    await writeScenario(space, { api: healthyApi() });
    const result = await tick(space);
    expect(result.decision).toBe("no-work");
    expect(result.code).toBe(0);
    expect(result.payload.window).toEqual(["18.13.1", "18.13.2", "18.13.3"]);
    expect(result.payload.active).toEqual(["18.13.1", "18.13.2", "18.13.3"]);
    expect(await dispatches(space)).toEqual([]);
  });

  it("dispatches once, without a version input, when the registry window moved", async () => {
    const space = await workspace("window-moved", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, { api: healthyApi() });
    const result = await tick(space);
    expect(result.decision).toBe("dispatched");
    expect(result.payload.reason).toBe("support-window-mismatch");
    const sent = await dispatches(space);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(["workflow", "run", WORKFLOW, "--repo", REPOSITORY, "--ref", "main"]);
    const state = JSON.parse(await readFile(join(space.watchRoot, "state.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["baseSha", "decision", "lastDispatchAt", "lastError", "lastIntentAt", "latest", "schemaVersion"]);
    expect(state.latest).toBe("18.13.4");
    expect(state.baseSha).toBe(BASE);
    expect(typeof state.lastDispatchAt).toBe("string");
  });

  it("stops on a queued or running run without dispatching a second one", async () => {
    const space = await workspace("active-run", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, {
      api: healthyApi({ [RUNS_PATH]: { body: { total_count: 1, workflow_runs: [{ id: 5, status: "queued", created_at: "2026-10-28T00:00:00Z" }] } } }),
    });
    const queued = await tick(space);
    expect(queued.decision).toBe("active-run");
    expect(queued.code).toBe(0);
    expect(await dispatches(space)).toEqual([]);

    const running = await workspace("running-run", false);
    await writeScenario(running, {
      api: healthyApi({ [RUNS_PATH]: { body: { total_count: 1, workflow_runs: [{ id: 6, status: "in_progress", created_at: "2026-10-28T00:00:00Z" }] } } }),
    });
    const inProgress = await tick(running);
    expect(inProgress.decision).toBe("active-run");
    expect(await dispatches(running)).toEqual([]);
  });

  it("honours a pause variable on a later page and fails closed when variables are unreadable", async () => {
    const paused = await workspace("paused", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    const filler = Array.from({ length: 100 }, (_, index) => ({ name: `OTHER_${index}`, value: "false" }));
    await writeScenario(paused, {
      api: healthyApi({
        [VARIABLES_PATH]: { body: { total_count: 101, variables: filler } },
        [VARIABLES_PAGE2_PATH]: { body: { total_count: 101, variables: [{ name: "MAINTENANCE_PAUSED", value: "true" }] } },
      }),
    });
    const pausedResult = await tick(paused);
    expect(pausedResult.decision).toBe("paused");
    expect(pausedResult.code).toBe(0);
    expect(await dispatches(paused)).toEqual([]);

    const unreadable = await workspace("paused-unreadable", false);
    await writeScenario(unreadable, { api: healthyApi({ [VARIABLES_PATH]: { status: 403 } }) });
    const unreadableResult = await tick(unreadable);
    expect(unreadableResult.decision).toBe("maintenance-pause-unreadable");
    expect(unreadableResult.code).toBe(1);
    expect(await dispatches(unreadable)).toEqual([]);
  });

  it("refuses an invalid pause value and skips a disabled workflow", async () => {
    const invalid = await workspace("paused-invalid", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(invalid, {
      api: healthyApi({ [VARIABLES_PATH]: { body: { total_count: 1, variables: [{ name: "MAINTENANCE_PAUSED", value: "yes" }] } } }),
    });
    const invalidResult = await tick(invalid);
    expect(invalidResult.decision).toBe("maintenance-pause-invalid");
    expect(invalidResult.code).toBe(1);

    const disabled = await workspace("workflow-disabled", false);
    await writeScenario(disabled, { api: healthyApi({ [WORKFLOW_PATH]: { body: { state: "disabled_manually" } } }) });
    const disabledResult = await tick(disabled);
    expect(disabledResult.decision).toBe("workflow-disabled");
    expect(disabledResult.code).toBe(0);
    expect(await dispatches(disabled)).toEqual([]);
  });

  it("resumes a merged but unpublished candidate even when the pin already equals latest", async () => {
    const space = await workspace("merged-unreleased", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.1", "18.13.2", "18.13.3"], "18.13.3") };
    await writeScenario(space, {
      api: healthyApi({ [PULLS_PATH]: { body: [mergedPull("0.6.0")] }, [releasePath("0.6.0")]: { status: 404 } }),
    });
    const result = await tick(space);
    expect(result.decision).toBe("dispatched");
    expect(result.payload.reason).toBe("owned-candidate-pending");
    expect(await dispatches(space)).toHaveLength(1);

    const released = await workspace("merged-released", false);
    await writeScenario(released, {
      api: healthyApi({ [PULLS_PATH]: { body: [mergedPull("0.6.0")] }, [releasePath("0.6.0")]: { body: publishedRelease("0.6.0") } }),
    });
    const releasedResult = await tick(released);
    expect(releasedResult.decision).toBe("no-work");
    expect(await dispatches(released)).toEqual([]);
  });

  it("treats a draft release as unfinished and a foreign upgrade branch as a conflict", async () => {
    const space = await workspace("draft-release", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.1", "18.13.2", "18.13.3"], "18.13.3") };
    await writeScenario(space, {
      api: healthyApi({
        [PULLS_PATH]: { body: [mergedPull("0.6.0")] },
        [releasePath("0.6.0")]: { body: { tag_name: "v0.6.0", draft: true, published_at: null } },
      }),
    });
    expect((await tick(space)).decision).toBe("dispatched");

    const foreign = await workspace("foreign-pr", false);
    const pull = mergedPull("0.6.0");
    await writeScenario(foreign, {
      api: healthyApi({ [PULLS_PATH]: { body: [{ ...pull, user: { login: "someone-else", type: "User" } }] }, [releasePath("0.6.0")]: { status: 404 } }),
    });
    const foreignResult = await tick(foreign);
    expect(foreignResult.decision).toBe("maintenance-pr-ownership-conflict");
    expect(foreignResult.code).toBe(1);
    expect(await dispatches(foreign)).toEqual([]);
  });

  it("fails closed on registry and GitHub read errors instead of reporting no-work", async () => {
    const registry = await workspace("registry-error", false);
    registryMode = { status: 500, packument: {} };
    await writeScenario(registry, { api: healthyApi() });
    const registryResult = await tick(registry);
    expect(registryResult.decision).toBe("registry-unavailable:500");
    expect(registryResult.code).toBe(1);
    expect(await dispatches(registry)).toEqual([]);

    const pulls = await workspace("pulls-error", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.1", "18.13.2", "18.13.3"], "18.13.3") };
    await writeScenario(pulls, { api: healthyApi({ [PULLS_PATH]: { status: 403 } }) });
    const pullsResult = await tick(pulls);
    expect(pullsResult.decision).toBe("read-failed:403");
    expect(pullsResult.code).toBe(1);
    expect(await dispatches(pulls)).toEqual([]);
  });

  it("never sends a second dispatch after an uncertain first attempt", async () => {
    const space = await workspace("uncertain", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, { api: healthyApi(), dispatch: { exit: 1, stdout: "connection reset by peer" } });
    const first = await tick(space);
    expect(first.decision).toBe("dispatch-uncertain");
    expect(first.code).toBe(1);
    expect(await dispatches(space)).toHaveLength(1);
    const state = JSON.parse(await readFile(join(space.watchRoot, "state.json"), "utf8")) as Record<string, unknown>;
    expect(typeof state.lastIntentAt).toBe("string");
    expect(state.lastDispatchAt).toBeNull();

    const second = await tick(space);
    expect(second.decision).toBe("cooldown");
    expect(second.payload.reason).toBe("recent-intent");
    expect(await dispatches(space)).toHaveLength(1);
  });

  it("honours the cooldown for a run started within the last hour", async () => {
    const space = await workspace("cooldown", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    const created = new Date(Date.now() - 5 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await writeScenario(space, {
      api: healthyApi({ [RUNS_PATH]: { body: { total_count: 1, workflow_runs: [{ id: 9, status: "completed", created_at: created }] } } }),
    });
    const result = await tick(space);
    expect(result.decision).toBe("cooldown");
    expect(result.payload.reason).toBe("recent-run");
    expect(await dispatches(space)).toEqual([]);
  });

  it("stops dispatching while the last run on this base reports a nonretryable block", async () => {
    const space = await workspace("durable-block", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, {
      api: healthyApi({
        [RUNS_PATH]: { body: { total_count: 1, workflow_runs: [completedRunOnBase(40935638542, hoursAgo(3))] } },
      }),
      outcome: { artifact: true, content: blockedOutcome("catalog-description-source-mismatch:tui.mouse", false) },
    });
    const result = await tick(space);
    expect(result.decision).toBe("blocked");
    expect(result.code).toBe(0);
    expect(result.payload.reason).toBe("outcome-blocked:catalog-description-source-mismatch:tui.mouse");
    expect(await dispatches(space)).toEqual([]);
    const downloaded = (await calls(space)).filter(args => args[0] === "run" && args[1] === "download");
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]).toContain("maintenance-outcome-40935638542-1");
    const directory = downloaded[0]![downloaded[0]!.indexOf("--dir") + 1]!;
    expect(existsSync(directory)).toBe(false);
    const log = JSON.parse((await readFile(join(space.watchRoot, "watch.log"), "utf8")).trim()) as Record<string, unknown>;
    expect(log.decision).toBe("blocked");
    expect(log.reason).toBe("outcome-blocked:catalog-description-source-mismatch:tui.mouse");
  });

  it("keeps dispatching when the outcome artifact cannot be read", async () => {
    const space = await workspace("durable-fail-open", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, {
      api: healthyApi({
        [RUNS_PATH]: { body: { total_count: 1, workflow_runs: [completedRunOnBase(40935638543, hoursAgo(3))] } },
      }),
      outcome: { artifact: false },
    });
    const result = await tick(space);
    expect(result.decision).toBe("dispatched");
    expect(result.payload.reason).toBe("support-window-mismatch");
    expect(await dispatches(space)).toHaveLength(1);
  });

  it("dispatches again when the recorded block is retryable", async () => {
    const space = await workspace("durable-retryable", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, {
      api: healthyApi({
        [RUNS_PATH]: { body: { total_count: 1, workflow_runs: [completedRunOnBase(40935638544, hoursAgo(3))] } },
      }),
      outcome: { artifact: true, content: blockedOutcome("github-http-503", true) },
    });
    const result = await tick(space);
    expect(result.decision).toBe("dispatched");
    expect(result.payload.reason).toBe("support-window-mismatch");
    expect(await dispatches(space)).toHaveLength(1);
  });

  it("refuses the hosted maintenance token", async () => {
    const space = await workspace("token", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.1", "18.13.2", "18.13.3"], "18.13.3") };
    await writeScenario(space, { api: healthyApi() });
    const result = await tick(space, [], { MAINTENANCE_GH_TOKEN: "ghp_example" });
    expect(result.decision).toBe("maintenance-token-forbidden");
    expect(result.code).toBe(1);
    expect(await calls(space)).toEqual([]);
  });

  it("performs no write at all in dry-run mode", async () => {
    const space = await workspace("dry-run", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, { api: healthyApi() });
    const before = await readFile(join(space.watchRoot, "config.json"), "utf8");
    const result = await tick(space, ["-DryRun"]);
    expect(result.decision).toBe("dispatch");
    expect(result.code).toBe(0);
    expect(result.payload.dispatched).toBe(false);
    expect(await dispatches(space)).toEqual([]);
    expect(existsSync(join(space.watchRoot, "state.json"))).toBe(false);
    expect(existsSync(join(space.watchRoot, "watch.log"))).toBe(false);
    expect(await readFile(join(space.watchRoot, "config.json"), "utf8")).toBe(before);
  });

  it("reports busy while another tick holds the named mutex", async () => {
    const space = await workspace("busy", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.2", "18.13.3", "18.13.4"], "18.13.4") };
    await writeScenario(space, { api: healthyApi() });
    const holder = join(space.root, "hold.ps1");
    const release = join(space.root, "release.txt");
    await writeFile(
      holder,
      [
        "param([string]$Release)",
        "Set-StrictMode -Version Latest",
        "$mutex = New-Object System.Threading.Mutex -ArgumentList $false, 'Local\\omp-settings-ru-maintenance'",
        "if (-not $mutex.WaitOne(0)) { Write-Output 'blocked'; exit 3 }",
        "Write-Output 'ready'",
        "[Console]::Out.Flush()",
        "while (-not (Test-Path -LiteralPath $Release)) { Start-Sleep -Milliseconds 50 }",
        "[void]$mutex.ReleaseMutex()",
      ].join("\n"),
    );
    const child = Bun.spawn([POWERSHELL, "-NoProfile", "-NonInteractive", "-File", holder, release], { stdout: "pipe", stderr: "ignore" });
    let ready = false;
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      while (!seen.includes("ready") && !seen.includes("blocked")) {
        const next = await reader.read();
        if (next.done) break;
        seen += decoder.decode(next.value);
      }
      reader.releaseLock();
      // A holder that could not take the mutex proves nothing, so say so instead of flaking.
      expect(seen).toContain("ready");
      ready = true;
      const result = await tick(space);
      expect(result.decision).toBe("busy");
      expect(result.code).toBe(0);
      expect(await calls(space)).toEqual([]);
    } finally {
      // The holder must exit while still holding nothing; killing it would leave the named mutex
      // owned by a dying process and leak "busy" into the remaining cases.
      await writeFile(release, "release\n");
      const exited = await Promise.race([child.exited, Bun.sleep(15_000).then(() => null)]);
      if (exited === null) child.kill();
      await child.exited;
      expect(ready || child.exitCode !== null).toBe(true);
    }
  });

  it("rotates the diagnostic log and keeps exactly one backup", async () => {
    const space = await workspace("log-rotation", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.1", "18.13.2", "18.13.3"], "18.13.3") };
    await writeScenario(space, { api: healthyApi() });
    await writeFile(join(space.watchRoot, "watch.log"), "x".repeat(1024 * 1024));
    const result = await tick(space);
    expect(result.decision).toBe("no-work");
    expect((await stat(join(space.watchRoot, "watch.log.1"))).size).toBe(1024 * 1024);
    const current = (await readFile(join(space.watchRoot, "watch.log"), "utf8")).trim().split("\n");
    expect(current).toHaveLength(1);
    expect(JSON.parse(current[0]!)).toMatchObject({ decision: "no-work" });
  });

  it("prints local status without any network call", async () => {
    const space = await workspace("status", false);
    const result = await tick(space, ["-Status"]);
    expect(result.code).toBe(0);
    expect(typeof result.payload.installed).toBe("boolean");
    expect(result.payload.config).toBe(true);
    expect(result.payload.watcher).toBe(false);
    expect(await calls(space)).toEqual([]);
  });

  it("replaces an unreadable state file and records that it was invalid", async () => {
    const space = await workspace("state-corrupt", false);
    registryMode = { status: 200, packument: stablePackument(["18.13.1", "18.13.2", "18.13.3"], "18.13.3") };
    await writeScenario(space, { api: healthyApi() });
    await writeFile(join(space.watchRoot, "state.json"), "{ not json");
    const result = await tick(space);
    expect(result.decision).toBe("no-work");
    const state = JSON.parse(await readFile(join(space.watchRoot, "state.json"), "utf8")) as Record<string, unknown>;
    expect(state.schemaVersion).toBe(1);
    const log = JSON.parse((await readFile(join(space.watchRoot, "watch.log"), "utf8")).trim()) as Record<string, unknown>;
    expect(log.stateInvalid).toBe(true);
  });
});

describe("watcher selector parity with the TypeScript window", () => {
  it("selects the same three stable versions for every shared fixture case", async () => {
    const space = await workspace("selector", false);
    const driver = join(space.root, "driver.ps1");
    await writeFile(
      driver,
      [
        "param([string]$Watcher, [string]$Fixture)",
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }",
        ". $Watcher",
        "$data = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Fixture))",
        "$results = @()",
        "foreach ($case in $data.cases) {",
        "    $window = @()",
        "    $failure = $null",
        "    try { $window = @(Select-StableWindow -Packument $case.packument) }",
        "    catch { $failure = [string]$_.Exception.Message }",
        "    $results += [pscustomobject]@{ name = [string]$case.name; window = @($window); error = $failure }",
        "}",
        "Write-Output (ConvertTo-Json -InputObject @($results) -Depth 6 -Compress)",
      ].join("\n"),
    );
    const child = Bun.spawnSync([POWERSHELL, "-NoProfile", "-NonInteractive", "-File", driver, WATCHER, WINDOW_FIXTURE], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    expect(child.stderr.toString()).toBe("");
    const actual = JSON.parse(child.stdout.toString().trim()) as { name: string; window: string[]; error: string | null }[];
    const fixture = JSON.parse(await readFile(WINDOW_FIXTURE, "utf8")) as { cases: { name: string; window?: string[]; error?: string }[] };
    expect(actual).toHaveLength(fixture.cases.length);
    for (const [index, expected] of fixture.cases.entries()) {
      const observed = actual[index]!;
      expect(observed.name).toBe(expected.name);
      if (expected.error) {
        expect(observed.error ?? "").toStartWith(expected.error);
        expect(observed.window).toEqual([]);
      } else {
        expect(observed.error).toBeNull();
        expect(observed.window).toEqual(expected.window!);
      }
    }
  });
});

describe("installer boundaries", () => {
  async function runInstaller(space: InstallerWorkspace, args: readonly string[], scenario: Scenario) {
    await writeScenario(space, scenario);
    const child = Bun.spawn([POWERSHELL, "-NoProfile", "-NonInteractive", "-File", space.installer, ...args], {
      env: { ...process.env, LOCALAPPDATA: space.localAppData, OMP_WATCH_FIXTURE: space.fixture },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, payload: lastJsonLine(stdout), stderr };
  }

  const acceptedMain = async () => ({ auth: 0, api: { [WATCHER_REMOTE_PATH]: { body: await readFile(WATCHER, "utf8") } } });

  it("refuses to install when accepted main carries different watcher bytes", async () => {
    const space = await workspace("not-accepted", true);
    const result = await runInstaller(space, ["-WhatIf", "-GhPath", space.gh], {
      auth: 0,
      api: { [WATCHER_REMOTE_PATH]: { body: "# different bytes\n" } },
    });
    expect(result.payload.decision).toBe("main-not-accepted");
    expect(result.code).toBe(1);
    expect(existsSync(join(space.watchRoot, "watch.ps1"))).toBe(false);
    expect(existsSync(join(space.watchRoot, "state.json"))).toBe(false);
  });

  it("plans the hourly task from the accepted watcher without changing anything", async () => {
    const space = await workspace("plan", true);
    // A machine that already runs the real watcher owns this task name, and the installer must
    // refuse to plan over it; that refusal is covered by the ownership case, not here.
    const probe = Bun.spawnSync(
      [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", `if (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) { 'present' } else { 'absent' }`],
      { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
    );
    if (probe.stdout.toString().trim() === "present") return;
    const result = await runInstaller(space, ["-WhatIf", "-GhPath", space.gh], await acceptedMain());
    expect(result.payload.decision).toBe("install-plan");
    expect(result.code).toBe(0);
    expect(["absent", "match"]).toContain(String(result.payload.ownership));
    expect(String(result.payload.arguments)).toBe(
      `-NoProfile -NonInteractive -File "${join(space.localAppData, "omp-settings-ru", "maintenance", "watch.ps1")}" -Once`,
    );
    expect(String(result.payload.repository)).toBe(REPOSITORY);
    expect(String(result.payload.user)).not.toBe("");
    expect(existsSync(join(space.watchRoot, "watch.ps1"))).toBe(false);
    expect(existsSync(join(space.watchRoot, "state.json"))).toBe(false);
  });

  it("reports a missing GitHub login before touching the disk", async () => {
    const space = await workspace("auth", true);
    const result = await runInstaller(space, ["-WhatIf", "-GhPath", space.gh], { auth: 1, api: {} });
    expect(result.payload.decision).toBe("gh-auth-failed");
    expect(result.code).toBe(1);
    expect(existsSync(join(space.watchRoot, "watch.ps1"))).toBe(false);
    expect(existsSync(join(space.watchRoot, "state.json"))).toBe(false);
  });

  it("refuses a task of the same name with a different action, account, logon type or run level", async () => {
    const space = await workspace("ownership", true);
    const driver = join(space.root, "ownership.ps1");
    await writeFile(
      driver,
      [
        "param([string]$Installer, [string]$PowerShell)",
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        ". $Installer",
        "$arguments = '-NoProfile -NonInteractive -File \"C:\\runtime\\maintenance-watch.ps1\" -Once'",
        "function New-Task([string]$Execute, [string]$TaskArguments, [string]$User, [string]$Logon, [string]$Level) {",
        "    return [pscustomobject]@{",
        "        Actions = @([pscustomobject]@{ Execute = $Execute; Arguments = $TaskArguments })",
        "        Principal = [pscustomobject]@{ UserId = $User; LogonType = $Logon; RunLevel = $Level }",
        "    }",
        "}",
        "$results = [ordered]@{",
        "    match = Test-TaskOwnership -Task (New-Task $PowerShell $arguments 'EXAMPLE\\owner' 'Interactive' 'Limited') -ExpectedExecute $PowerShell -ExpectedArguments $arguments -ExpectedUserId 'EXAMPLE\\owner'",
        "    otherAccount = Test-TaskOwnership -Task (New-Task $PowerShell $arguments 'EXAMPLE\\stranger' 'Interactive' 'Limited') -ExpectedExecute $PowerShell -ExpectedArguments $arguments -ExpectedUserId 'EXAMPLE\\owner'",
        "    otherAction = Test-TaskOwnership -Task (New-Task 'C:\\Windows\\System32\\cmd.exe' '/c whoami' 'EXAMPLE\\owner' 'Interactive' 'Limited') -ExpectedExecute $PowerShell -ExpectedArguments $arguments -ExpectedUserId 'EXAMPLE\\owner'",
        "    otherLogon = Test-TaskOwnership -Task (New-Task $PowerShell $arguments 'EXAMPLE\\owner' 'ServiceAccount' 'Limited') -ExpectedExecute $PowerShell -ExpectedArguments $arguments -ExpectedUserId 'EXAMPLE\\owner'",
        "    elevated = Test-TaskOwnership -Task (New-Task $PowerShell $arguments 'EXAMPLE\\owner' 'Interactive' 'Highest') -ExpectedExecute $PowerShell -ExpectedArguments $arguments -ExpectedUserId 'EXAMPLE\\owner'",
        "    absent = Test-TaskOwnership -Task $null -ExpectedExecute $PowerShell -ExpectedArguments $arguments -ExpectedUserId 'EXAMPLE\\owner'",
        "}",
        "Write-Output (ConvertTo-Json -InputObject $results -Compress)",
      ].join("\n"),
    );
    const child = Bun.spawnSync([POWERSHELL, "-NoProfile", "-NonInteractive", "-File", driver, space.installer, POWERSHELL], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    expect(child.stderr.toString()).toBe("");
    const results = JSON.parse(child.stdout.toString().trim()) as Record<string, string>;
    expect(results.match).toBe("match");
    expect(results.otherAccount).toBe("conflict");
    expect(results.otherAction).toBe("conflict");
    expect(results.otherLogon).toBe("conflict");
    expect(results.elevated).toBe("conflict");
    expect(results.absent).toBe("absent");
  });

  it("reports an absent task on uninstall and keeps runtime files", async () => {
    const space = await workspace("uninstall", true);
    const watchRoot = join(space.localAppData, "omp-settings-ru", "maintenance");
    await writeFile(join(watchRoot, "state.json"), "{}\n");
    const probe = Bun.spawnSync(
      [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", `if (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) { 'present' } else { 'absent' }`],
      { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
    );
    // A machine that already runs the real watcher is never unregistered by a test.
    if (probe.stdout.toString().trim() === "present") return;
    const result = await runInstaller(space, ["-Uninstall"], { auth: 0, api: {} });
    expect(result.payload.decision).toBe("not-installed");
    expect(result.code).toBe(0);
    expect(existsSync(join(watchRoot, "state.json"))).toBe(true);
  });
});

import { afterEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../scripts/maintenance-actions";
import { HostedGitHub, maintenanceBody, type MaintenanceIdentity } from "../scripts/maintenance/actions-github";
import { validatePolicy } from "../scripts/maintenance/policy";
import { SUPPORTED_HOSTS } from "../scripts/maintenance/paths";
import rawPolicy from "../maintenance.config.json";
import { recoveryFixture } from "./maintenance-actions-fixture";

setDefaultTimeout(30_000);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { mock.restore(); for (const action of cleanup.splice(0).reverse()) await action(); });
const initial = ["18.13.1", "18.13.2", "18.13.3"];
const policy = validatePolicy(rawPolicy);
function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}
const row = (version: string) => ({ version, package: `omp-host-${version.replaceAll(".", "")}`, platforms: ["win32", "darwin", "linux"], baselines: { win32: "a".repeat(64), darwin: "a".repeat(64), linux: "a".repeat(64) } });

/** Actual Git accepted commits and HTTP npm/GitHub boundaries; production selectors/identity gates remain real. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "upstream-discover-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); const bare = join(root, "origin.git");
  await mkdir(repo); git(repo, "init", "-b", "main"); git(root, "init", "--bare", bare); git(repo, "remote", "add", "origin", bare);
  let base = "";
  async function accepted(active = initial, historical: string[] = [], pin = active.at(-1)!, manifest?: unknown) {
    await mkdir(join(repo, "test/fixtures/host-snapshots"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ version: "0.10.0", devDependencies: { "@oh-my-pi/pi-coding-agent": pin } }));
    await writeFile(join(repo, SUPPORTED_HOSTS), JSON.stringify(manifest ?? { schemaVersion: 1, versions: active.map(row), historical: historical.map(row) }));
    git(repo, "add", "."); git(repo, "commit", "--allow-empty", "-m", `accepted ${pin}`); base = git(repo, "rev-parse", "HEAD"); git(repo, "push", "origin", "main");
    return base;
  }
  await accepted();
  let metadata: unknown = { "dist-tags": { latest: "18.13.5" }, versions: Object.fromEntries([...initial, "18.13.4", "18.13.5"].map(version => [version, { version }])) };
  let missing = ""; let oversized = false; let redirected = false; let cancelled = false;
  let nativeMissing = false;
  const { promise: cancellation, resolve: bodyCancelled } = Promise.withResolvers<void>();
  let pulls: unknown[] = []; let runs: Record<string, unknown>[] = []; let originInvalid = false;
  let identity: MaintenanceIdentity | undefined;
  const requests: { method: string; path: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url); const path = decodeURIComponent(url.pathname); requests.push({ method: request.method, path });
    if (path === "/npm/@oh-my-pi/pi-coding-agent") {
      if (redirected) return new Response(null, { status: 302, headers: { location: "/redirect-target" } });
      if (oversized) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33 * 1024 * 1024)); }, cancel() { cancelled = true; bodyCancelled(); } }));
      return Response.json(metadata);
    }
    if (path.startsWith("/npm/")) {
      if (path.includes(missing) && missing) return new Response(null, { status: 404 });
      return Response.json({ version: path.split("/").at(-1), dist: { integrity: "sha512-fixture" } });
    }
    const api = `/repos/${policy.repository}`;
    if (path === api + "/pulls") return Response.json(pulls);
    if (path === api + "/releases") return Response.json(identity ? [{ tag_name: `v${identity.releaseVersion}`, target_commitish: base, draft: true, prerelease: false, assets: [] }] : []);
    if (path === api + "/actions/runs") return Response.json({ workflow_runs: runs });
    if (path.endsWith("/actions/workflows/upstream-watch.yml/runs")) return Response.json({ workflow_runs: [] });
    if (identity && path === api + `/actions/runs/${identity.runId}/attempts/1`) return Response.json({ id: Number(identity.runId), run_attempt: 1, path: originInvalid ? ".github/workflows/other.yml" : ".github/workflows/upstream-watch.yml", event: "schedule", head_branch: "main", head_sha: identity.baseSha, repository: { full_name: policy.repository } });
    if (identity && path === api + `/actions/runs/${identity.runId}/attempts/1/jobs`) return Response.json({ jobs: [{ name: "verify", run_id: Number(identity.runId), head_sha: identity.baseSha, status: "completed", conclusion: "success" }] });
    if (identity && path === api + "/actions/artifacts/42") return Response.json({ id: 42, expired: false, name: `maintenance-${identity.upstreamVersion}-${identity.runId}-1`, workflow_run: { id: Number(identity.runId), head_sha: identity.baseSha } });
    const native = path.match(/^\/repos\/can1357\/oh-my-pi\/releases\/tags\/v(.+)$/);
    if (native) {
      if (nativeMissing) return new Response(null, { status: 404 });
      const version = native[1]!;
      return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false, assets: ["omp-windows-x64.exe", "omp-darwin-x64", "omp-linux-x64"].map((name, index) => ({ id: index + 1, name, size: 1, digest: "sha256:" + "a".repeat(64), browser_download_url: `https://github.com/can1357/oh-my-pi/releases/download/v${version}/${name}` })) });
    }
    return new Response(null, { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  const bridge = join(root, "gh.ts");
  await writeFile(bridge, `const args=process.argv.slice(2);if(args[0]!=="api")process.exit(2);const response=await fetch(${JSON.stringify(server.url.href)}+args[1]);if(!response.ok){console.error("(HTTP "+response.status+")");process.exit(1);}process.stdout.write(await response.text());`);
  const spawn = Bun.spawn;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: Bun.SpawnOptions.OptionsObject<"pipe", "pipe", "pipe">) => command[0] === "gh" ? spawn([process.execPath, bridge, ...command.slice(1)], options) : spawn(command, options)) as typeof Bun.spawn);
  const fetch = globalThis.fetch;
  spyOn(globalThis, "fetch").mockImplementation(((url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    return fetch(value.startsWith("https://registry.npmjs.org/") ? server.url.href + "npm/" + value.slice("https://registry.npmjs.org/".length) : url, init);
  }) as typeof globalThis.fetch);
  const environment = Object.fromEntries(["MAINTENANCE_PAUSED", "RETRY_BLOCKED", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(environment)) delete process.env[key];
  cleanup.push(() => { for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const github = new HostedGitHub(policy, "fixture-token");
  return {
    repo, bare, requests, github, accepted,
    discover: (requested?: string) => discover(repo, base, policy, github, requested),
    registry(versions: string[], latest = versions.at(-1)!) { metadata = { "dist-tags": { latest }, versions: Object.fromEntries(versions.map(version => [version, { version }])) }; },
    missing(value: string) { missing = value; },
    missingNative() { nativeMissing = true; },
    oversize() { oversized = true; }, redirect() { redirected = true; }, cancelled: () => cancelled, cancellation,
    originInvalid() { originInvalid = true; }, clearPulls() { pulls = []; runs = []; },
    pending(options: { merged?: boolean; attempt?: number; conclusion?: string; duplicate?: boolean; foreign?: boolean; active?: boolean } = {}) {
      const head = git(repo, "commit-tree", git(repo, "rev-parse", "HEAD^{tree}"), "-p", base, "-m", "candidate");
      git(repo, "push", "origin", `${head}:refs/heads/upgrade/omp-18.13.4`);
      identity = { schemaVersion: 1, repository: policy.repository, upstreamVersion: "18.13.4", releaseVersion: "0.11.0", baseSha: base, headSha: head, runId: "123", runAttempt: "1", artifactId: "42", manifestSha256: "c".repeat(64) };
      const merge = options.merged ? git(repo, "commit-tree", git(repo, "rev-parse", "HEAD^{tree}"), "-p", base, "-p", head, "-m", "merge") : undefined;
      pulls = [{ number: 1, state: merge ? "closed" : "open", merged_at: merge ? "2026-10-28T00:00:00Z" : null, merge_commit_sha: merge, draft: false, body: maintenanceBody(identity), user: { login: policy.controllerLogin, type: policy.controllerType }, base: { ref: "main", repo: { full_name: policy.repository } }, head: { ref: "upgrade/omp-18.13.4", sha: head, repo: { full_name: policy.repository } } }];
      runs = [{ id: 501, run_attempt: options.attempt ?? 1, path: ".github/workflows/check.yml", event: "push", head_sha: merge ?? head, head_branch: merge ? "main" : "upgrade/omp-18.13.4", status: options.active ? "in_progress" : "completed", conclusion: options.active ? null : options.conclusion ?? "failure", repository: { full_name: options.foreign ? "foreign/repository" : policy.repository }, head_repository: { full_name: policy.repository } }];
      if (options.duplicate) runs.push({ ...runs[0] });
    },
  };
}

test("bare accepted publication commits advance oldest missing .4 then .5 and finish at active .3/.4/.5", async () => {
  const f = await fixture();
  expect(await f.discover()).toMatchObject({ mode: "prepare", candidateVersion: "18.13.4" });
  expect(f.requests.filter(request => request.path.startsWith("/npm/") && request.path.endsWith("/18.13.4")).map(request => request.path)).toEqual([
    "/npm/@oh-my-pi/pi-coding-agent/18.13.4", "/npm/@oh-my-pi/pi-natives/18.13.4", "/npm/@oh-my-pi/pi-tui/18.13.4", "/npm/@oh-my-pi/pi-utils/18.13.4",
  ]);
  f.pending(); f.requests.length = 0;
  expect(await f.discover()).toMatchObject({ mode: "resume", candidateVersion: "18.13.4" });
  expect(f.requests.some(request => request.path.startsWith("/npm/"))).toBe(false);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
  f.clearPulls(); await f.accepted(["18.13.2", "18.13.3", "18.13.4"], ["18.13.1"]);
  expect(await f.discover()).toMatchObject({ mode: "prepare", candidateVersion: "18.13.5" });
  await f.accepted(["18.13.3", "18.13.4", "18.13.5"], ["18.13.1", "18.13.2"]);
  expect(await f.discover()).toMatchObject({ mode: "no-work", candidateVersion: "18.13.5" });
  expect(JSON.parse(git(f.bare, "show", `main:${SUPPORTED_HOSTS}`)).versions.map((value: { version: string }) => value.version)).toEqual(["18.13.3", "18.13.4", "18.13.5"]);
});

test("prereleases do not enter queue and stable versions above a stale nonregressed latest do", async () => {
  const f = await fixture(); f.registry([...initial, "18.13.4", "18.13.5", "18.13.6", "18.13.7-rc.1"], "18.13.3");
  expect(await f.discover()).toMatchObject({ mode: "prepare", candidateVersion: "18.13.4" });
  await f.accepted(["18.13.4", "18.13.5", "18.13.6"], initial);
  f.registry([...initial, "18.13.4", "18.13.5", "18.13.6", "18.13.7-rc.1"], "18.13.6");
  expect(await f.discover()).toMatchObject({ mode: "no-work", candidateVersion: "18.13.6" });
});

test("missing .4 companion stops rather than skipping to .5", async () => {
  const f = await fixture(); f.missing("pi-natives/18.13.4");
  await expect(f.discover()).rejects.toThrow("companion-package-unavailable");
  expect(f.requests.some(request => request.path.endsWith("/18.13.5"))).toBe(false);
});

test("missing next native release blocks before any later version is considered", async () => {
  const f = await fixture(); f.missingNative();
  await expect(f.discover()).rejects.toThrow("native-asset-unavailable");
  expect(f.requests.some(request => request.path.endsWith("/18.13.5"))).toBe(false);
});

for (const requested of ["18.13.5", "18.12.99"]) test(`rejects explicit queue bypass or unknown old version ${requested}`, async () => {
  const f = await fixture(); await expect(f.discover(requested)).rejects.toThrow("requested-version-not-next");
});

test("explicit serviced active/history versions are no-work, but unknown old input stays rejected when caught up", async () => {
  const f = await fixture();
  expect(await f.discover("18.13.4")).toMatchObject({ mode: "prepare", candidateVersion: "18.13.4" });
  expect(await f.discover("18.13.2")).toMatchObject({ mode: "no-work", candidateVersion: "18.13.2" });
  await f.accepted(initial, ["18.12.0"]);
  expect(await f.discover("18.12.0")).toMatchObject({ mode: "no-work", candidateVersion: "18.12.0" });
  f.registry(initial);
  await expect(f.discover("18.12.99")).rejects.toThrow("requested-version-not-next");
});

test("historical evidence cannot hide an inactive target member at or below the pin", async () => {
  const f = await fixture(); await f.accepted(["18.13.1", "18.13.3"], ["18.13.2"]); f.registry(initial);
  await expect(f.discover()).rejects.toThrow("support-window-backfill-required");
});

test("latest rollback blocks even while the packument has higher stable versions", async () => {
  const f = await fixture(); f.registry([...initial, "18.13.4", "18.13.5"], "18.13.2");
  await expect(f.discover()).rejects.toThrow("registry-latest-regressed");
});

for (const invalid of [{ versions: initial.map(row) }, { schemaVersion: 1, versions: initial.map(version => ({ version })) }, { schemaVersion: 1, versions: initial.map(row), historical: [row("18.13.1")] }]) test(`rejects malformed accepted manifest before registry ${JSON.stringify(invalid).slice(0, 80)}`, async () => {
  const f = await fixture(); await f.accepted(initial, [], "18.13.3", invalid); f.requests.length = 0;
  await expect(f.discover()).rejects.toThrow("supported-");
  expect(f.requests.some(request => request.path.startsWith("/npm/"))).toBe(false);
});

for (const merged of [false, true]) test(`owned ${merged ? "merged unpublished" : "open failed CI"} candidate resumes before registry even when requested version bypasses queue`, async () => {
  const f = await fixture(); f.pending({ merged });
  expect(await f.discover("18.13.5")).toMatchObject({ mode: "resume", candidateVersion: "18.13.4" });
  expect(f.requests.some(request => request.path.startsWith("/npm/"))).toBe(false);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
  if (merged) {
    await f.accepted(["18.13.2", "18.13.3", "18.13.4"], ["18.13.1"]);
    f.registry([...initial, "18.13.4"]);
    f.requests.length = 0;
    expect(await f.discover()).toMatchObject({ mode: "resume", candidateVersion: "18.13.4" });
    expect(f.requests.some(request => request.path.startsWith("/npm/"))).toBe(false);
  }
});

for (const merged of [false, true]) test(`rejects invalid ${merged ? "merged" : "open"} candidate provenance without registry or writes`, async () => {
  const f = await fixture(); f.pending({ merged }); f.originInvalid();
  await expect(f.discover()).rejects.toThrow(merged ? "resume-origin-invalid" : "artifact-origin-invalid");
  expect(f.requests.some(request => request.path.startsWith("/npm/"))).toBe(false);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

for (const options of [{ attempt: 3 }, { duplicate: true }, { foreign: true }, { conclusion: "action_required" }]) test(`blocks unsafe read-only candidate checks ${JSON.stringify(options)}`, async () => {
  const f = await fixture(); f.pending(options);
  await expect(f.discover()).rejects.toThrow(options.attempt ? "candidate-checks-retries-exhausted:501" : options.conclusion ? "check-run-blocked" : options.foreign ? "check-run-binding-invalid:501" : "check-run-ambiguous:");
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

test("active last-budget attempt is resumed and never rerun by discovery", async () => {
  const f = await fixture(); f.pending({ attempt: 3, active: true });
  expect(await f.discover()).toMatchObject({ mode: "resume" });
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

test("oversize registry response fails bounded and cancels its HTTP body", async () => {
  const f = await fixture(); f.oversize();
  await expect(f.discover()).rejects.toThrow("registry-response-too-large");
  await f.cancellation;
  expect(f.cancelled()).toBe(true);
});

test("registry redirects are refused without contacting their target", async () => {
  const f = await fixture(); f.redirect();
  await expect(f.discover()).rejects.toThrow("registry-network-unconfirmed");
  expect(f.requests.some(request => request.path === "/redirect-target")).toBe(false);
});

test("a proven published owned PR is serviced before registry no-work without duplicate publication", async () => {
  const f = await recoveryFixture("published"); cleanup.push(() => f.cleanup());
  const spawn = Bun.spawn; const spawnSync = Bun.spawnSync; const actualFetch = globalThis.fetch;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: object) => command[0] === "gh" ? spawn([process.execPath, f.transport, ...command.slice(1)], options) : spawn(command, options)) as typeof Bun.spawn);
  spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options: object) => command[0] === "gh" ? spawnSync([process.execPath, f.transport, ...command.slice(1)], options) : spawnSync(command, options)) as typeof Bun.spawnSync);
  spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "registry.npmjs.org") return Promise.resolve(Response.json({ "dist-tags": { latest: "18.9.0" }, versions: { "18.9.0": { version: "18.9.0" } } }));
    if (url.hostname !== "github.com") throw new Error("fixture-refuses-live-fetch");
    return actualFetch(f.origin + url.pathname + url.search, init);
  }) as typeof fetch);
  const environment = Object.fromEntries(["MAINTENANCE_PAUSED", "RETRY_BLOCKED"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(environment)) delete process.env[key];
  cleanup.push(() => { for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  expect(await discover(f.repo, f.merge, f.policy, new HostedGitHub(f.policy, "fixture-token"))).toMatchObject({ mode: "no-work", candidateVersion: "18.9.0" });
  const requests = (await Bun.file(join(f.root, "requests.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line) as { method: string });
  expect(requests.every(request => request.method === "GET")).toBe(true);
  expect(f.git("rev-parse", "refs/tags/v0.6.0")).toBe(f.merge);
});

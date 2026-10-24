import { afterEach, describe, expect, test, spyOn, mock } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseCandidate, validateBundle, validateCandidateTree, writeBundleManifest } from "../scripts/maintenance/actions-bundle";
import { HostedGitHub, parseMaintenanceBlock, maintenanceBody, validateOrigin } from "../scripts/maintenance/actions-github";
import { compareVersions, validatePolicy } from "../scripts/maintenance/policy";
import { parseStrictJSON } from "../scripts/maintenance/json";
import rawPolicy from "../maintenance.config.json";
import { finalizeCandidate } from "../scripts/maintenance/actions-publish";
import { snapshotValue } from "../scripts/maintenance/actions-candidate";
import { computeSourceHash } from "../src/source";
import { recoveryFixture } from "./maintenance-actions-fixture";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "hosted-actions-")); temporary.push(root); return root; }
function git(cwd: string, ...args: string[]) { const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }); if (p.exitCode) throw new Error(p.stderr.toString()); return p.stdout.toString().trim(); }
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function manifest(baseSha = "a".repeat(40), headSha?: string) { return { schemaVersion: 1 as const, repository: "narimanisakhanov-creator/omp-settings-ru", runId: "123", runAttempt: "2", baseSha, upstreamVersion: "18.9.0", releaseVersion: "0.6.0", ...(headSha ? { headSha } : {}), files: [], reviewResponses: [] }; }

describe("hosted artifact boundary", () => {
  test("rejects duplicate keys, traversal, unexpected fields and prereleases", () => {
    expect(() => parseStrictJSON('{"a":1,"a":2}')).toThrow();
    expect(() => parseCandidate({ ...manifest(), files: [{ path: "../secret", sha256: sha("x") }] })).toThrow();
    expect(() => parseCandidate({ ...manifest(), command: "execute" })).toThrow();
    expect(() => parseCandidate({ ...manifest(), upstreamVersion: "18.9.0-rc.1" })).toThrow();
    expect(compareVersions("18.10.0", "18.9.9")).toBeGreaterThan(0);
    expect(compareVersions("18.9.0", "18.9.0")).toBe(0);
  });
  test("validates actual artifact bytes and refuses unlisted files and symlinks", async () => {
    const root = await directory();
    await writeFile(join(root, "candidate.patch"), "patch");
    await writeBundleManifest(root, manifest());
    expect((await validateBundle(root)).files).toEqual([{ path: "candidate.patch", sha256: sha("patch") }]);
    await writeFile(join(root, "candidate.patch"), "tampered");
    await expect(validateBundle(root)).rejects.toThrow("artifact-hash-mismatch");
    await writeFile(join(root, "candidate.patch"), "patch");
    await writeFile(join(root, "unlisted"), "secret");
    await expect(validateBundle(root)).rejects.toThrow("artifact-unlisted");
  });
  test("accepts only one exact-parent candidate ref and byte-identical patch in a bare-git bundle", async () => {
    const root = await directory(); const repo = join(root, "repo"); const artifact = join(root, "artifact");
    await mkdir(repo); await mkdir(artifact); git(repo, "init", "-b", "main");
    await writeFile(join(repo, "CHANGELOG.md"), "base\n"); git(repo, "add", "CHANGELOG.md"); git(repo, "commit", "-m", "base"); const base = git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "CHANGELOG.md"), "base\ncandidate\n"); git(repo, "add", "CHANGELOG.md"); git(repo, "commit", "-m", "chore: support OMP 18.9.0"); const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/heads/maintenance-candidate", head);
    git(repo, "bundle", "create", join(artifact, "candidate.bundle"), "refs/heads/maintenance-candidate", `^${base}`);
    const patch = Bun.spawnSync(["git", "diff", "--binary", "--full-index", "--no-renames", base, head], { cwd: repo, stdout: "pipe" }).stdout;
    await writeFile(join(artifact, "candidate.patch"), patch);
    const candidate = manifest(base, head);
    expect(validateCandidateTree(repo, artifact, candidate, ["CHANGELOG.md"])).toEqual(["CHANGELOG.md"]);
    await writeFile(join(artifact, "candidate.patch"), "not the candidate patch");
    expect(() => validateCandidateTree(repo, artifact, candidate, ["CHANGELOG.md"])).toThrow("candidate-patch-mismatch");
    await writeFile(join(artifact, "candidate.patch"), patch);
    expect(() => validateCandidateTree(repo, artifact, candidate, ["package.json"])).toThrow("candidate-path-forbidden");
  });
});

describe("origin and durable PR identity", () => {
  test("machine body is data with one unambiguous block", () => {
    const identity = { ...manifest("a".repeat(40), "b".repeat(40)), headSha: "b".repeat(40), artifactId: "42", manifestSha256: "c".repeat(64) };
    const body = maintenanceBody(identity);
    expect(parseMaintenanceBlock(body)).toMatchObject({ runId: "123", artifactId: "42", releaseVersion: "0.6.0" });
    expect(() => parseMaintenanceBlock(body + body)).toThrow();
    expect(() => parseMaintenanceBlock("human text")).toThrow();
  });
  test("hashes alone cannot authorize a foreign workflow, ref, run attempt or expired artifact", () => {
    const candidate = manifest();
    const run = { id: 123, run_attempt: 2, event: "workflow_dispatch", path: ".github/workflows/upstream-watch.yml", head_branch: "main", head_sha: candidate.baseSha, repository: { full_name: candidate.repository } };
    const artifact = { id: 42, name: "maintenance-18.9.0-123-2", expired: false, workflow_run: { id: 123, head_sha: candidate.baseSha } };
    expect(() => validateOrigin(candidate, run, artifact, "42")).not.toThrow();
    for (const changed of [{ ...run, head_branch: "other" }, { ...run, run_attempt: 1 }, { ...run, path: ".github/workflows/check.yml" }, { ...run, repository: { full_name: "foreign/repo" } }]) expect(() => validateOrigin(candidate, changed, artifact, "42")).toThrow();
    expect(() => validateOrigin(candidate, run, { ...artifact, expired: true }, "42")).toThrow();
  });
});

test("snapshot input validates full normalized source and rejects hash tampering", () => {
  const source = { tab: "General", group: null, label: "Label", description: "Description", warning: null, options: null };
  const snapshot = { version: "18.9.0", platform: "linux", settings: { fixture: { sourceHash: computeSourceHash(source), ...source } } };
  expect(snapshotValue(snapshot).settings.fixture?.label).toBe("Label");
  expect(() => snapshotValue({ ...snapshot, settings: { fixture: { ...snapshot.settings.fixture, label: "Changed" } } })).toThrow("snapshot-source-hash-mismatch");
});

test("expired owned candidate is closed and exact bare remote branch retired without mutating main", async () => {
  const root = await directory(); const repo = join(root, "repo"); const bare = join(root, "origin.git"); await mkdir(repo);
  git(repo, "init", "-b", "main"); await writeFile(join(repo, "CHANGELOG.md"), "base\n"); git(repo, "add", "CHANGELOG.md"); git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD"); git(root, "init", "--bare", bare); git(repo, "remote", "add", "origin", bare); git(repo, "push", "origin", "main");
  await writeFile(join(repo, "CHANGELOG.md"), "candidate\n"); git(repo, "commit", "-am", "candidate"); const head = git(repo, "rev-parse", "HEAD"); git(repo, "push", "origin", `${head}:refs/heads/upgrade/omp-18.9.0`);
  const policy = validatePolicy(rawPolicy); const repository = policy.repository;
  const identity = { ...manifest(base, head), headSha: head, artifactId: "42", manifestSha256: "c".repeat(64) };
  let closed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    const main = git(bare, "rev-parse", "refs/heads/main");
    if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response("unauthorized", { status: 401 });
    if (path === `/repos/${repository}/pulls` && request.method === "GET") return Response.json(closed ? [] : [{ number: 1, state: "open", merged_at: null, draft: false, body: maintenanceBody(identity), user: { login: policy.controllerLogin, type: "User" }, base: { ref: "main", sha: base, repo: { full_name: repository } }, head: { ref: "upgrade/omp-18.9.0", sha: head, repo: { full_name: repository } } }]);
    if (path.endsWith("/actions/artifacts/42")) return Response.json({ expired: true });
    if (path.endsWith("/actions/runs/123/attempts/2")) return Response.json({ id: 123, run_attempt: 2, path: ".github/workflows/upstream-watch.yml", event: "schedule", head_branch: "main", head_sha: base, repository: { full_name: repository } });
    if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: main } });
    if (path.endsWith("/git/ref/heads/upgrade/omp-18.9.0")) return Response.json({ object: { sha: git(bare, "rev-parse", "refs/heads/upgrade/omp-18.9.0") } });
    if (path === "/user") return Response.json({ login: policy.controllerLogin, type: "User" });
    if (path.endsWith("/pulls/1") && request.method === "PATCH") { const value = await request.json() as { state: string }; if (value.state !== "closed") return new Response("bad", { status: 400 }); closed = true; return Response.json({ state: "closed" }); }
    if (path.endsWith("/git/refs/heads/upgrade/omp-18.9.0") && request.method === "DELETE" && closed) { git(bare, "update-ref", "-d", "refs/heads/upgrade/omp-18.9.0", head); return new Response(null, { status: 204 }); }
    return new Response("unexpected fixture route", { status: 404 });
  } });
  const transport = join(root, "gh.ts");
  await writeFile(transport, `const args=process.argv.slice(2); if(args[0]!=="api")throw new Error("refused"); let method="GET";let endpoint="";const body={};for(let i=1;i<args.length;i++){if(args[i]==="--method")method=args[++i];else if(args[i]==="-f"||args[i]==="-F"){const value=args[++i];const at=value.indexOf("=");body[value.slice(0,at)]=value.slice(at+1);}else endpoint=args[i];}const response=await fetch(${JSON.stringify(server.url.href)}+endpoint,{method,headers:{authorization:"Bearer "+process.env.GH_TOKEN,"content-type":"application/json"},...(method==="GET"||method==="DELETE"?{}:{body:JSON.stringify(body)})});if(!response.ok){console.error("HTTP "+response.status);process.exit(1)}process.stdout.write(await response.text());`);
  const spawn = Bun.spawn;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: Bun.SpawnOptions.OptionsObject<"pipe", "pipe", "pipe">) => command[0] === "gh" ? spawn([process.execPath, transport, ...command.slice(1)], options) : spawn(command, options)) as typeof Bun.spawn);
  try {
    expect(await finalizeCandidate(repo, "18.9.0", new HostedGitHub(policy, "fixture-token"))).toBe("retired");
    expect(closed).toBe(true);
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(base);
    expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/upgrade/")).toBe("");
    expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/tags/")).toBe("");
  } finally { mock.restore(); server.stop(true); }
}, 30000);

test("fresh translation CLI writes exact review proof from loopback API and rejection leaves catalog unchanged", async () => {
  const root = await directory(); const bundle = join(root, "artifact"); await mkdir(bundle); await mkdir(join(bundle, "data/src/translations"), { recursive: true });
  await writeFile(join(root, "maintenance.config.json"), JSON.stringify(rawPolicy));
  const base = "a".repeat(40); const source = { tab: "General", group: null, label: "Mode", description: "Select mode", warning: null, options: null };
  const hash = computeSourceHash(source);
  const snapshots = ["win32", "darwin", "linux"].map(platform => ({ version: "18.9.0", platform, settings: { fixture: { sourceHash: hash, ...source } } }));
  const original = JSON.stringify({ locale: "ru", settings: {} });
  await writeFile(join(bundle, "data/src/translations/ru-catalog.json"), original);
  await writeFile(join(bundle, "data/src/translations/variant-review.json"), JSON.stringify({ schemaVersion: 1, variants: [] }));
  await writeFile(join(bundle, "input.json"), JSON.stringify({ snapshots }));
  await writeBundleManifest(bundle, manifest(base));
  let rejected = false; let count = 0;
  const reviewer = '{"verdict":"approved","comparison":"Meaning preserved"}';
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions" || request.headers.get("authorization") !== "Bearer model-fixture") return new Response("refused", { status: 403 });
    const body = await request.json() as { messages: { role: string; content: string }[] };
    if (body.messages.length !== 2) return new Response("history", { status: 400 });
    const review = body.messages[0]!.content.toLowerCase().includes("review"); count++;
    return Response.json({ choices: [{ message: { content: review ? (rejected ? '{"verdict":"rejected","comparison":"Meaning changed"}' : reviewer) : '{"label":"Режим","description":"Выберите режим"}' } }] });
  } });
  const cli = join(import.meta.dir, "../scripts/maintenance-actions.ts");
  const environment = { ...process.env, GITHUB_ACTIONS: "false", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", MAINTENANCE_BASE_SHA: base, MAINTENANCE_API_KEY: "model-fixture", MAINTENANCE_BASE_URL: server.url.href + "v1", MAINTENANCE_MODEL: "fixture", GH_TOKEN: undefined, GITHUB_TOKEN: undefined, MAINTENANCE_GH_TOKEN: undefined };
  try {
    const child = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text(); expect(await child.exited, stderr).toBe(0);
    const catalog = await Bun.file(join(bundle, "data/src/translations/ru-catalog.json")).json();
    expect(catalog.settings.fixture.variants[0].label).toBe("Режим");
    expect(catalog.settings.fixture.variants[0].platforms).toEqual(["darwin", "linux", "win32"]);
    const candidate = await validateBundle(bundle); expect(candidate.reviewResponses).toEqual([{ path: "fixture", sourceHash: hash, sha256: sha(reviewer) }]);
    const rows = await Bun.file(join(bundle, "data/src/translations/variant-review.json")).json();
    expect(rows.variants[0]).toMatchObject({ evidence: sha(reviewer), reviewTask: "123:2", reviewedAtVersion: "18.9.0" });
    expect(count).toBe(2);
    await writeFile(join(bundle, "data/src/translations/ru-catalog.json"), original); await writeBundleManifest(bundle, manifest(base)); rejected = true;
    const failed = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(failed.stderr).text()).toBe("translation-review-rejected:fixture\n"); expect(await failed.exited).not.toBe(0);
    expect(await Bun.file(join(bundle, "data/src/translations/ru-catalog.json")).text()).toBe(original);
    expect(await Bun.file(join(root, ".git")).exists()).toBe(false);
    await writeFile(join(bundle, "input.json"), "{model-fixture"); await writeBundleManifest(bundle, manifest(base));
    const broken = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
    const brokenStderr = await new Response(broken.stderr).text(); expect(await broken.exited).not.toBe(0);
    expect(brokenStderr).toBe("translate-failed:SyntaxError\n");
    expect(brokenStderr.length).toBeLessThanOrEqual(120);
    expect(brokenStderr).not.toContain("maintenance-action-blocked"); expect(brokenStderr).not.toContain("model-fixture");
    expect(count).toBe(4);
    rejected = false; let httpFailure = false;
    await writeFile(join(bundle, "input.json"), JSON.stringify({ snapshots })); await writeBundleManifest(bundle, manifest(base));
    server.stop(true);
    const failingServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { httpFailure = true; return new Response("refused", { status: 503 }); } });
    try {
      const failedRequest = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: { ...environment, MAINTENANCE_BASE_URL: failingServer.url.href + "v1" }, stdout: "pipe", stderr: "pipe" });
      expect(await new Response(failedRequest.stderr).text()).toBe("model-http-503\n"); expect(await failedRequest.exited).not.toBe(0);
      expect(httpFailure).toBe(true);
    } finally { failingServer.stop(true); }
  } finally { server.stop(true); }
}, 30000);

for (const mode of ["merge-without-tag", "draft", "manual-draft", "manual-advanced", "published"] as const) test(`recovery ${mode} preserves exact bare refs and confirms catalog without duplicate effects`, async () => {
  const fixture = await recoveryFixture(mode);
  const spawn = Bun.spawn; const spawnSync = Bun.spawnSync; const actualFetch = globalThis.fetch; const sleep = Bun.sleep;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: object) => command[0] === "gh" ? spawn([process.execPath, fixture.transport, ...command.slice(1)], options) : spawn(command, options)) as typeof Bun.spawn);
  spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options: object) => command[0] === "gh" ? spawnSync([process.execPath, fixture.transport, ...command.slice(1)], options) : spawnSync(command, options)) as typeof Bun.spawnSync);
  spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "github.com") throw new Error("fixture-refuses-live-fetch");
    return actualFetch(fixture.origin + url.pathname + url.search, init);
  }) as typeof fetch);
  spyOn(Bun, "sleep").mockImplementation((() => sleep(1)) as typeof Bun.sleep);
  try {
    expect(await finalizeCandidate(fixture.repo, "18.9.0", new HostedGitHub(fixture.policy, "fixture-token"))).toBe("released");
    expect(fixture.git("rev-parse", "refs/heads/main")).toBe(fixture.merge);
    expect(fixture.git("rev-parse", "refs/tags/v0.6.0")).toBe(fixture.merge);
    expect(fixture.git("for-each-ref", "--format=%(refname)", "refs/heads/upgrade/")).toBe("");
    const before = await readFile(join(fixture.root, "requests.jsonl"), "utf8");
    expect(await finalizeCandidate(fixture.repo, "18.9.0", new HostedGitHub(fixture.policy, "fixture-token"))).toBe("released");
    const after = (await readFile(join(fixture.root, "requests.jsonl"), "utf8")).slice(before.length).trim().split("\n").map(line => JSON.parse(line) as { method: string });
    expect(after.every(row => row.method === "GET")).toBe(true);
    const state = await Bun.file(join(fixture.root, "state.json")).json();
    expect(state).toMatchObject({ published: true, draft: false, reruns: mode === "draft" || mode === "manual-draft" || mode === "manual-advanced" ? 1 : 0 });
  } finally { mock.restore(); await fixture.cleanup(); }
}, 30000);

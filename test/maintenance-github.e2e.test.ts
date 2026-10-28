import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../scripts/maintenance/github";
import type { ControllerPolicy } from "../scripts/maintenance/contracts";
import { HostedGitHub } from "../scripts/maintenance/actions-github";
import { ensureCheckRun } from "../scripts/maintenance/check-recovery";
import { workflowRecovery } from "../scripts/maintenance/actions-publish";

const repository = "narimanisakhanov-creator/omp-settings-ru";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const tag = "v0.6.0";
const checkPath = ".github/workflows/check.yml";
const names = ["check (ubuntu-latest, 18.8.7)", "release-check"];
const policy: ControllerPolicy = {
  schemaVersion: 1, repository, baseBranch: "main", controllerLogin: "controller", controllerType: "User",
  branchPattern: "^upgrade/omp-([0-9]+\\.[0-9]+\\.[0-9]+)$", executorPaths: [],
  requiredCheckTemplate: "check ({os}, {version})", requiredCheckPlatforms: [{os: "ubuntu-latest", platform: "linux"}],
  additionalRequiredChecks: ["release-check"],
  deadlinesMs: {precheck: 10000, command: 10000, verification: 10000, release: 10000, checks: 10000},
};
const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function workflow(overrides: Record<string, unknown> = {}) {
  return {id: 501, name: "Check", path: checkPath, event: "push", head_sha: sha, head_branch: "maintenance/18.8.7",
    status: "completed", conclusion: "success", check_suite_id: 601, run_attempt: 1,
    repository: {id: 10, full_name: repository}, head_repository: {id: 10, full_name: repository}, ...overrides};
}
function checkRuns(suite = 601, head = sha) {
  return names.map((name, index) => ({id: 701 + index, name, head_sha: head, status: "completed", conclusion: "success",
    app: {id: 15368, slug: "github-actions"}, check_suite: {id: suite},
    details_url: `https://github.com/${repository}/actions/runs/501/job/${801 + index}`}));
}
function jobs(overrides: Record<string, unknown> = {}) {
  return names.map((name, index) => ({id: 801 + index, run_id: 501, run_attempt: 1, name, head_sha: sha,
    status: "completed", conclusion: "success", check_run_url: `https://api.github.com/repos/${repository}/check-runs/${701 + index}`,
    steps: [{name: "Run tests", number: 1, status: "completed", conclusion: "success"}], ...overrides}));
}
const catalog = (sourceSha = sha) => JSON.stringify({name: "omp-settings-ru", owner: {name: "narimanisakhanov-creator"}, plugins: [{
  name: "omp-settings-ru", description: "Published fixture", version: "0.6.0",
  source: {source: "github", repo: repository, ref: tag, sha: sourceSha},
}]});

// Only the process/URL transport is routed to loopback. Every consumer, parser, provenance
// join, byte download, digest and canonical release validator below is production code.
const serverSource = `
import {appendFileSync, readFileSync} from "node:fs";
import {join} from "node:path";
const [root] = process.argv.slice(2);
const counts = new Map();
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(request) {
 const url = new URL(request.url); const key = url.pathname + url.search;
 appendFileSync(join(root,"requests.log"), JSON.stringify({key,method:request.method,accept:request.headers.get("accept")})+"\\n");
 const routes = JSON.parse(readFileSync(join(root,"routes.json"),"utf8"));
 const entry = routes[key];
 const signature = JSON.stringify(entry); const previous = counts.get(key);
 const count = previous?.signature === signature ? previous.count : 0; counts.set(key, {signature,count:count+1});
 const row = Array.isArray(entry) ? entry[Math.min(count,entry.length-1)] : entry;
 return row ? new Response(Buffer.from(row.body,"base64"),{status:row.status??200,headers:{"content-type":row.type??"application/json"}}) : new Response("unregistered route",{status:404});
}}); console.log(server.port);
`;
const ghSource = `
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const args = process.argv.slice(2);
let path = args[1], method = "GET", directory;
if(args[0]==="run" && args[1]==="rerun" && args.includes("--failed")) {path="fixture/rerun/"+args[2];method="POST";}
else if(args[0]==="run" && args[1]==="download") {path="fixture/receipt/"+args[2];directory=args[args.indexOf("--dir")+1];}
else if(args[0]!=="api") throw new Error("fixture refuses unknown command");
const headers = {};
for(let i=2;i<args.length;i++) if(args[i]==="-H") { const [name,...value]=args[++i].split(":");headers[name]=value.join(":").trim(); }
const response = await fetch(process.env.FIXTURE_GITHUB + "/" + path,{headers,method});
if(!response.ok) { console.error("(HTTP "+response.status+")"); process.exit(1); }
const bytes = Buffer.from(await response.arrayBuffer());
if(directory) {mkdirSync(directory,{recursive:true});writeFileSync(join(directory,"receipt.json"),bytes);} else process.stdout.write(bytes);
`;
let root: string;
let origin: string;
let server: Bun.Subprocess;
type HttpReply = {body: string; status?: number; type?: string};
let routes: Record<string, HttpReply | HttpReply[]>;
const spawn = Bun.spawn;
const spawnSync = Bun.spawnSync;
const actualFetch = globalThis.fetch;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "maintenance-github-http-"));
  await writeFile(join(root, "routes.json"), "{}");
  await writeFile(join(root, "requests.log"), "");
  await writeFile(join(root, "server.ts"), serverSource);
  await writeFile(join(root, "gh.ts"), ghSource);
  server = spawn([process.execPath, join(root, "server.ts"), root], {stdout: "pipe", stderr: "pipe"});
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("fixture-server-start-failed");
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  origin = `http://127.0.0.1:${Number(text.trim())}`;
});
afterEach(() => { mock.restore(); });
afterAll(async () => { server?.kill(); if (server) await server.exited; if (root) await rm(root, {recursive: true, force: true}); });

function route(path: string, body: unknown, raw = false) {
  routes[path] = {body: Buffer.from(raw ? body as string : JSON.stringify(body)).toString("base64")};
}
let sequenceId = 0;
function sequence(path: string, values: readonly unknown[]) {
  const id = ++sequenceId;
  routes[path] = values.map(value => ({body: Buffer.from(JSON.stringify({...value as object, fixtureSequence: id})).toString("base64")}));
}
async function fixture() {
  routes = {};
  route(`/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`, {total_count: 2, check_runs: checkRuns()});
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 1, workflow_runs: [workflow()]});
  route("/user", {login: "controller", type: "User"});
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`, {total_count: 1, workflow_runs: [workflow()]});
  route(`/repos/${repository}/actions/runs/501/jobs?filter=latest&per_page=100&page=1`, {total_count: 2, jobs: jobs()});
  route(`/repos/${repository}/actions/runs/501`, workflow());
  route(`/repos/${repository}/git/ref/tags/${tag}`, {ref: `refs/tags/${tag}`, object: {type: "commit", sha}});
  await publishCatalog(catalog());
  // Preserve actual subprocess execution, including the sync canonical asset downloader.
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: object) => command[0] === "gh"
    ? spawn([process.execPath, join(root, "gh.ts"), ...command.slice(1)], {...options, env: {...process.env, FIXTURE_GITHUB: origin}})
    : spawn(command, options)) as typeof Bun.spawn);
  spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options: object) => command[0] === "gh"
    ? spawnSync([process.execPath, join(root, "gh.ts"), ...command.slice(1)], {...options, env: {...process.env, FIXTURE_GITHUB: origin}})
    : spawnSync(command, options)) as typeof Bun.spawnSync);
  spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${repository}/releases/download/${tag}/`)) throw new Error("fixture-refuses-live-fetch");
    return actualFetch(origin + url.pathname + url.search, init);
  }) as typeof fetch);
  return new GitHub(policy);
}
async function publishCatalog(bytes: string, assetDigest = digest(bytes), include = true) {
  const archive = "actual archive fixture bytes";
  const sums = `${digest(archive).slice(7)}  omp-settings-ru-0.6.0.tgz\n`;
  const assets = [{id: 901, name: "omp-settings-ru-0.6.0.tgz", digest: digest(archive)}, {id: 902, name: "SHA256SUMS", digest: digest(sums)},
    ...(include ? [{id: 903, name: "marketplace.json", digest: assetDigest}] : [])].map(asset => ({...asset,
    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${asset.name}`}));
  const release = {id: 900, tag_name: tag, target_commitish: sha, draft: false, prerelease: false, published_at: "2026-10-11T00:00:00Z", assets};
  route(`/repos/${repository}/releases?per_page=100`, [release]);
  route(`/repos/${repository}/releases/tags/${tag}`, release);
  for (const [name, body] of [["omp-settings-ru-0.6.0.tgz", archive], ["SHA256SUMS", sums], ["marketplace.json", bytes]]) route(`/${repository}/releases/download/${tag}/${name}`, body, true);
  route(`/repos/${repository}/releases/assets/903`, bytes, true);
  await saveRoutes();
}
async function saveRoutes() { await writeFile(join(root, "routes.json"), JSON.stringify(routes)); await writeFile(join(root, "requests.log"), ""); }
async function requests(): Promise<{key: string; accept: string | null}[]> {
  return (await readFile(join(root, "requests.log"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("production adapter approves real-shaped check suites only after joining authoritative Actions jobs", async () => {
  const github = await fixture();
  const checks = await github.checksFor(sha);
  expect(github.requiredChecksPassed(checks, sha, ["18.8.7"])).toEqual({ok: true});
  expect(checks.map(check => [check.id, check.workflowPath, check.event])).toEqual([[701, checkPath, "push"], [702, checkPath, "push"]]);
  expect(await github.checkWorkflowRun(sha)).toEqual({kind: "found", runId: "501"});
}, 30000);

test("production adapter follows check and workflow collection pages", async () => {
  const github = await fixture();
  const unrelatedChecks = Array.from({length: 100}, (_, id) => ({id: 1000 + id, name: "unrelated", head_sha: sha, check_suite: {id: 999}}));
  const unrelatedRuns = Array.from({length: 100}, (_, id) => workflow({id: 1000 + id, path: ".github/workflows/unrelated.yml"}));
  route(`/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`, {total_count: 102, check_runs: unrelatedChecks});
  route(`/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=2`, {total_count: 102, check_runs: checkRuns()});
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 101, workflow_runs: unrelatedRuns});
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=2`, {total_count: 101, workflow_runs: [workflow()]});
  await saveRoutes();
  expect(github.requiredChecksPassed(await github.checksFor(sha), sha, ["18.8.7"])).toEqual({ok: true});
}, 30000);

test("latest jobs preserve reused successes and paginate beyond one hundred jobs", async () => {
  const github = await fixture();
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 1, workflow_runs: [workflow({run_attempt: 2})]});
  const unrelated = Array.from({length: 100}, (_, id) => ({...jobs()[0], id: 2000 + id, name: "unrelated"}));
  route(`/repos/${repository}/actions/runs/501/jobs?filter=latest&per_page=100&page=1`, {total_count: 102, jobs: unrelated});
  route(`/repos/${repository}/actions/runs/501/jobs?filter=latest&per_page=100&page=2`, {total_count: 102, jobs: [jobs()[0], {...jobs()[1], run_attempt: 2}]});
  await saveRoutes();
  const checks = await github.checksFor(sha);
  expect(checks.map(row => [row.jobAttempt, row.workflowAttempt])).toEqual([[1, 2], [2, 2]]);
  expect(github.requiredChecksPassed(checks, sha, ["18.8.7"], {id: 501, attempt: 2, headBranch: "maintenance/18.8.7", status: "completed", conclusion: "success"})).toEqual({ok: true});
}, 30000);

test("selected run cannot borrow missing jobs from another run on the same SHA", async () => {
  const github = await fixture();
  const checks = await github.checksFor(sha);
  expect(github.requiredChecksPassed(checks, sha, ["18.8.7"], {id: 502, attempt: 1, headBranch: "maintenance/18.8.7", status: "completed", conclusion: "success"})).toEqual({ok: false, reason: "check-missing:check (ubuntu-latest, 18.8.7)"});
}, 30000);

test("unreadable workflow collection is unknown rather than an authoritative absence", async () => {
  const github = await fixture();
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {workflow_runs: "not an array"});
  await saveRoutes();
  expect(await github.checkWorkflowRun(sha)).toEqual({kind: "unknown"});
});

test("failed Actions jobs cannot borrow successful embedded check conclusions", async () => {
  const github = await fixture();
  route(`/repos/${repository}/actions/runs/501/jobs?filter=latest&per_page=100&page=1`, {total_count: 2, jobs: jobs({conclusion: "failure"})});
  await saveRoutes();
  expect(github.requiredChecksPassed(await github.checksFor(sha), sha, ["18.8.7"]).ok).toBe(false);
}, 30000);

test("required checks reject an older successful attempt when the latest attempt failed", async () => {
  const github = await fixture();
  const stale = checkRuns().map(row => ({ ...row, status: "completed", conclusion: "success" }));
  const latestFailure = checkRuns().map(row => ({ ...row, status: "completed", conclusion: "failure" }));
  const checks = [
    ...stale.map(row => ({ id: row.id, name: row.name, headSha: sha, status: row.status, conclusion: row.conclusion, workflowPath: checkPath, event: "push" as const, workflowRunId: 501, workflowAttempt: 1 })),
    ...latestFailure.map(row => ({ id: row.id + 100, name: row.name, headSha: sha, status: row.status, conclusion: row.conclusion, workflowPath: checkPath, event: "push" as const, workflowRunId: 501, workflowAttempt: 2 })),
  ];
  expect(github.requiredChecksPassed(checks, sha, ["18.8.7"])).toEqual({ ok: false, reason: "check-failed:check (ubuntu-latest, 18.8.7)" });
});

for (const [name, changes] of [
  ["same-named foreign workflow", {path: ".github/workflows/foreign.yml"}],
  ["different head SHA despite filtered query", {head_sha: otherSha}],
  ["foreign repository", {repository: {full_name: "foreign/repo"}}],
  ["pull-request event", {event: "pull_request"}],
  ["different check-suite identity", {check_suite_id: 999}],
] as const) test(`production adapter refuses ${name}`, async () => {
  const github = await fixture();
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 1, workflow_runs: [workflow(changes)]});
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`, {total_count: 1, workflow_runs: [workflow(changes)]});
  await saveRoutes();
  expect(github.requiredChecksPassed(await github.checksFor(sha), sha, ["18.8.7"]).ok).toBe(false);
  if (name !== "different check-suite identity") expect(await github.checkWorkflowRun(sha)).toEqual({kind: "absent"});
}, 30000);

for (const [name, changes] of [
  ["jobs from another run", {run_id: 502}], ["jobs on another SHA", {head_sha: otherSha}],
  ["foreign check-run URL", {check_run_url: "https://api.github.com/repos/foreign/repo/check-runs/701"}],
] as const) test(`production adapter refuses ${name}`, async () => {
  const github = await fixture();
  route(`/repos/${repository}/actions/runs/501/jobs?filter=latest&per_page=100&page=1`, {total_count: 2, jobs: jobs(changes)});
  await saveRoutes();
  expect(github.requiredChecksPassed(await github.checksFor(sha), sha, ["18.8.7"]).ok).toBe(false);
}, 30000);

test("required checks reject foreign workflow even with matching name SHA and push event", async () => {
  const github = await fixture();
  const checks = names.map((name, id) => ({id, name, headSha: sha, status: "completed", conclusion: "success", workflowPath: ".github/workflows/foreign.yml", event: "push"}));
  expect(github.requiredChecksPassed(checks, sha, ["18.8.7"]).ok).toBe(false);
});

test("published proof downloads served catalog archive and checksums through production validators", async () => {
  const github = await fixture();
  expect(await github.verifyPublishedRelease(tag, "501", sha)).toEqual({kind: "found"});
  const seen = await requests();
  expect(seen.some(row => row.key === `/repos/${repository}/releases/assets/903` && row.accept === "application/octet-stream")).toBe(true);
  expect(seen.some(row => row.key.endsWith("/omp-settings-ru-0.6.0.tgz"))).toBe(true);
  expect(seen.some(row => row.key.endsWith("/SHA256SUMS"))).toBe(true);
}, 30000);

for (const [name, bytes, assetDigest, include] of [
  ["wrong catalog source SHA", catalog(otherSha), digest(catalog(otherSha)), true],
  ["tampered served bytes", catalog() + "\n", digest(catalog()), true],
  ["malformed JSON with valid digest", "{malformed", digest("{malformed"), true],
  ["missing served catalog", catalog(), digest(catalog()), false],
  ["missing catalog digest", catalog(), "", true],
] as const) test(`published proof blocks ${name} instead of building a local catalog`, async () => {
  const github = await fixture();
  await publishCatalog(bytes, assetDigest, include);
  const result = await github.verifyPublishedRelease(tag, "501", sha);
  expect(result.kind).toBe("blocked");
  if (include) expect((await requests()).some(row => row.key === `/repos/${repository}/releases/assets/903`)).toBe(true);
}, 30000);

test("published proof binds the catalog and tag to the exact merged commit", async () => {
  const github = await fixture();
  expect((await github.verifyPublishedRelease(tag, "501", otherSha)).kind).toBe("blocked");
}, 30000);

test("published proof refuses a pull-request workflow run despite successful exact-SHA checks", async () => {
  const github = await fixture();
  route(`/repos/${repository}/actions/runs/501`, workflow({event: "pull_request"}));
  await saveRoutes();
  expect((await github.verifyPublishedRelease(tag, "501", sha)).kind).toBe("blocked");
}, 30000);

test("published release with absent archive is blocked rather than pending", async () => {
  const github = await fixture();
  const key = `/repos/${repository}/releases/tags/${tag}`;
  const reply = routes[key];
  if (!reply || Array.isArray(reply)) throw new Error("fixture-release-reply-invalid");
  const release = JSON.parse(Buffer.from(reply.body, "base64").toString());
  release.assets = release.assets.filter((asset: {name: string}) => asset.name !== "omp-settings-ru-0.6.0.tgz");
  route(key, release);
  route(`/repos/${repository}/releases?per_page=100`, [release]);
  await saveRoutes();
  expect((await github.verifyPublishedRelease(tag, "501", sha)).kind).toBe("blocked");
}, 30000);

test("tampered archive bytes remain blocked by the canonical published validator", async () => {
  const github = await fixture();
  route(`/${repository}/releases/download/${tag}/omp-settings-ru-0.6.0.tgz`, "tampered archive", true);
  await saveRoutes();
  expect((await github.verifyPublishedRelease(tag, "501", sha)).kind).toBe("blocked");
}, 30000);

test("release still absent remains pending without any asset download", async () => {
  const github = await fixture();
  route(`/repos/${repository}/releases?per_page=100`, []);
  await saveRoutes();
  expect(await github.verifyPublishedRelease(tag, "501", sha)).toEqual({kind: "pending"});
  expect((await requests()).some(row => row.key.includes("/releases/assets/"))).toBe(false);
}, 30000);

test("run ID mismatch in an exact-SHA endpoint response does not prove publication", async () => {
  const github = await fixture();
  route(`/repos/${repository}/actions/runs/501`, workflow({id: 502}));
  await saveRoutes();
  expect((await github.verifyPublishedRelease(tag, "501", sha)).kind).toBe("blocked");
}, 30000);

for (const rejected of [false, true]) for (const conclusion of ["failure", "cancelled"]) test(`HTTP ${conclusion} rerun ${rejected ? "already-running" : "accepted"} observes a real new attempt and reused jobs`, async () => {
  await fixture();
  const failed = workflow({conclusion});
  const active = workflow({run_attempt: 2, status: "in_progress", conclusion: null});
  const success = workflow({run_attempt: 2});
  sequence(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, [
    {total_count: 1, workflow_runs: [failed]}, {total_count: 1, workflow_runs: [active]},
    {total_count: 1, workflow_runs: [success]},
  ]);
  route(`/repos/${repository}/actions/runs/501/attempts/1/jobs?filter=all&per_page=100&page=1`, {jobs: jobs({conclusion: "failure"})});
  route(`/repos/${repository}/actions/runs/501/attempts/2`, active);
  route("/fixture/rerun/501", {});
  if (rejected) (routes["/fixture/rerun/501"] as HttpReply).status = 409;
  await saveRoutes();
  let clock = 0;
  spyOn(Date, "now").mockImplementation(() => clock);
  spyOn(Bun, "sleep").mockImplementation(((ms: number) => {clock += ms; return Promise.resolve();}) as typeof Bun.sleep);
  await ensureCheckRun(new HostedGitHub({...policy, deadlinesMs: {...policy.deadlinesMs, checks: 40 * 60_000}}, "fixture"), sha, ["18.8.7"], "maintenance/18.8.7");
  expect((await requests()).filter(row => row.key === "/fixture/rerun/501")).toHaveLength(1);
  expect(clock).toBe(15_000);
}, 30000);

test("HTTP recovery gives each observed attempt its own deadline", async () => {
  await fixture();
  const active = workflow({status: "in_progress", conclusion: null});
  const failure = workflow({conclusion: "failure"});
  const success = workflow({run_attempt: 2});
  sequence(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, [
    ...Array.from({length: 3}, () => ({total_count: 1, workflow_runs: [active]})),
    {total_count: 1, workflow_runs: [failure]},
    {total_count: 1, workflow_runs: [workflow({run_attempt: 2, status: "in_progress", conclusion: null})]},
    {total_count: 1, workflow_runs: [success]},
  ]);
  route(`/repos/${repository}/actions/runs/501/attempts/1/jobs?filter=all&per_page=100&page=1`, {jobs: jobs({conclusion: "failure"})});
  route(`/repos/${repository}/actions/runs/501/attempts/2`, success);
  route("/fixture/rerun/501", {});
  await saveRoutes();
  let clock = 0;
  spyOn(Date, "now").mockImplementation(() => clock);
  spyOn(Bun, "sleep").mockImplementation(((ms: number) => {clock += ms; return Promise.resolve();}) as typeof Bun.sleep);
  await ensureCheckRun(new HostedGitHub({...policy, deadlinesMs: {...policy.deadlinesMs, checks: 60_000}}, "fixture"), sha, ["18.8.7"], "maintenance/18.8.7");
  expect(clock).toBe(60_000);
}, 30000);

for (const rejected of [false, true]) test(`HTTP ${rejected ? "rejected" : "accepted"} rerun without observed attempt stops after sixty seconds`, async () => {
  await fixture();
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 1, workflow_runs: [workflow({conclusion: "cancelled"})]});
  route(`/repos/${repository}/actions/runs/501/attempts/1/jobs?filter=all&per_page=100&page=1`, {jobs: jobs({conclusion: "cancelled"})});
  route("/fixture/rerun/501", {});
  if (rejected) (routes["/fixture/rerun/501"] as HttpReply).status = 409;
  await saveRoutes();
  let clock = 0;
  spyOn(Date, "now").mockImplementation(() => clock);
  spyOn(Bun, "sleep").mockImplementation(((ms: number) => {clock += ms; return Promise.resolve();}) as typeof Bun.sleep);
  await expect(ensureCheckRun(new HostedGitHub(policy, "fixture"), sha, ["18.8.7"], "maintenance/18.8.7")).rejects.toThrow("check-rerun-not-started:501");
  expect(clock).toBe(60_000);
  expect((await requests()).filter(row => row.key === "/fixture/rerun/501")).toHaveLength(1);
}, 30000);

test("HTTP attempt three remains exhausted after a new controller starts", async () => {
  await fixture();
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 1, workflow_runs: [workflow({run_attempt: 3, conclusion: "failure"})]});
  await saveRoutes();
  for (let restart = 0; restart < 2; restart++) await expect(ensureCheckRun(new HostedGitHub(policy, "fixture"), sha, ["18.8.7"], "maintenance/18.8.7")).rejects.toThrow("candidate-checks-retries-exhausted:501");
  expect((await requests()).some(row => row.key.startsWith("/fixture/rerun/"))).toBe(false);
}, 30000);

async function publisherFixture(event: "workflow_dispatch" | "workflow_run", attempt: number) {
  await fixture();
  const run = {id: 1002, run_attempt: attempt, path: ".github/workflows/marketplace-index.yml", event,
    head_sha: otherSha, head_branch: "main", display_title: `marketplace-index ${tag}`, status: "completed", conclusion: "failure", repository: {full_name: repository}};
  route(`/repos/${repository}/actions/workflows/marketplace-index.yml/runs?per_page=100&page=1`, {workflow_runs: [run]});
  route(`/repos/${repository}/actions/runs/1002/artifacts?per_page=100&page=1`, {artifacts: [{id: 2002, name: `prepublish-${tag}-1002-1`, expired: false, size_in_bytes: 1000, workflow_run: {id: 1002, head_sha: otherSha}}]});
  route(`/repos/${repository}/actions/runs/1002/attempts/1`, {...run, run_attempt: 1});
  route(`/repos/${repository}/actions/runs/1002/attempts/1/jobs?filter=all&per_page=100&page=1`, {jobs: [{id: 3002, run_id: 1002, run_attempt: 1, head_sha: otherSha, name: "prepublish", status: "completed", conclusion: "success"}]});
  route("/fixture/receipt/1002", {schemaVersion: 1, repository, tag, version: "0.6.0", tagSha: sha, releaseState: "draft", releaseRunId: "1001", releaseRunAttempt: "1", checkRunId: "501", catalogSha256: "c".repeat(64), archiveSha256: "d".repeat(64), sumsSha256: "e".repeat(64), hostVersion: "18.8.7", smoke: "distribution-smoke", smokePassed: true});
  route(`/repos/${repository}/actions/runs/1001/attempts/1`, {id: 1001, run_attempt: 1, path: ".github/workflows/release.yml", event: "push", head_sha: sha, head_branch: tag, status: "completed", conclusion: "success", repository: {full_name: repository}});
  route("/fixture/rerun/1002", {});
  await saveRoutes();
  return new HostedGitHub(policy, "fixture");
}

for (const event of ["workflow_run", "workflow_dispatch"] as const) test(`HTTP ${event} publisher reuses attempt-one prepublish proof without REST inputs`, async () => {
  const github = await publisherFixture(event, 2);
  expect(await workflowRecovery(github, "marketplace-index.yml", tag, sha, new Set())).toBe(false);
  expect((await requests()).filter(row => row.key === "/fixture/rerun/1002")).toHaveLength(1);
}, 30000);

test("HTTP publisher producer attempt does not reset current attempt-three budget after restart", async () => {
  const github = await publisherFixture("workflow_run", 3);
  for (let restart = 0; restart < 2; restart++) await expect(workflowRecovery(new HostedGitHub(github.policy, "fixture"), "marketplace-index.yml", tag, sha, new Set())).rejects.toThrow("publisher-checks-retries-exhausted:1002");
  expect((await requests()).some(row => row.key === "/fixture/rerun/1002")).toBe(false);
}, 30000);

for (const status of ["pending", "requested", "completed"]) test(`HTTP unbound ${status} publisher waits without guessing a new dispatch`, async () => {
  await publisherFixture("workflow_run", 1);
  route(`/repos/${repository}/actions/runs/1002/artifacts?per_page=100&page=1`, {artifacts: []});
  route(`/repos/${repository}/actions/workflows/marketplace-index.yml/runs?per_page=100&page=1`, {workflow_runs: [{id: 1002, run_attempt: 1, path: ".github/workflows/marketplace-index.yml", event: "workflow_run", head_sha: otherSha, head_branch: "main", display_title: `marketplace-index ${tag}`, status, conclusion: null, repository: {full_name: repository}}]});
  await saveRoutes();
  expect(await workflowRecovery(new HostedGitHub(policy, "fixture"), "marketplace-index.yml", tag, sha, new Set())).toBe(false);
  expect((await requests()).some(row => row.key.startsWith("/fixture/rerun/"))).toBe(false);
}, 30000);

test("HTTP selected successful run cannot borrow another same-SHA run's jobs", async () => {
  await fixture();
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 2, workflow_runs: [workflow(), workflow({id: 502, check_suite_id: 602})]});
  route(`/repos/${repository}/actions/runs/502/jobs?filter=latest&per_page=100&page=1`, {total_count: 0, jobs: []});
  await saveRoutes();
  await expect(ensureCheckRun(new HostedGitHub(policy, "fixture"), sha, ["18.8.7"], "maintenance/18.8.7")).rejects.toThrow("check-missing:check (ubuntu-latest, 18.8.7)");
}, 30000);

for (const corruption of ["job-run", "job-attempt", "job-sha", "job-failure", "receipt-sha"] as const) test(`HTTP publisher refuses ${corruption} despite matching artifact title`, async () => {
  const github = await publisherFixture("workflow_run", 2);
  if (corruption === "receipt-sha") {
    const response = routes["/fixture/receipt/1002"] as HttpReply;
    const receipt = JSON.parse(Buffer.from(response.body, "base64").toString("utf8"));
    route("/fixture/receipt/1002", {...receipt, tagSha: otherSha});
  } else {
    const job = {id: 3002, run_id: corruption === "job-run" ? 999 : 1002, run_attempt: corruption === "job-attempt" ? 2 : 1,
      head_sha: corruption === "job-sha" ? sha : otherSha, name: "prepublish", status: "completed", conclusion: corruption === "job-failure" ? "failure" : "success"};
    route(`/repos/${repository}/actions/runs/1002/attempts/1/jobs?filter=all&per_page=100&page=1`, {jobs: [job]});
  }
  await saveRoutes();
  await expect(workflowRecovery(github, "marketplace-index.yml", tag, sha, new Set())).rejects.toThrow(corruption === "receipt-sha" ? "publisher-receipt-binding-invalid" : "publisher-prepublish-job-not-successful");
  expect((await requests()).some(row => row.key === "/fixture/rerun/1002")).toBe(false);
}, 30000);

for (const selected of [
  {id: 501, attempt: 1, headBranch: "foreign-branch"},
  {id: 501, attempt: 2, headBranch: "maintenance/18.8.7"},
]) test(`HTTP jobs cannot prove a different selected ${selected.headBranch === "foreign-branch" ? "branch" : "workflow attempt"}`, async () => {
  const github = await fixture();
  expect(github.requiredChecksPassed(await github.checksFor(sha), sha, ["18.8.7"], {...selected, status: "completed", conclusion: "success"}).ok).toBe(false);
}, 30000);

test("HTTP newer successful run ignores an older run's higher failed attempt", async () => {
  const github = await fixture();
  const newerChecks = checkRuns(602).map(row => ({...row, id: row.id + 10}));
  route(`/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`, {total_count: 4, check_runs: [...checkRuns(), ...newerChecks]});
  route(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, {total_count: 2, workflow_runs: [workflow({run_attempt: 3, conclusion: "failure"}), workflow({id: 502, check_suite_id: 602})]});
  route(`/repos/${repository}/actions/runs/501/jobs?filter=latest&per_page=100&page=1`, {total_count: 2, jobs: jobs({run_attempt: 3, conclusion: "failure"})});
  route(`/repos/${repository}/actions/runs/502/jobs?filter=latest&per_page=100&page=1`, {total_count: 2, jobs: jobs().map((row, index) => ({...row, run_id: 502, check_run_url: `https://api.github.com/repos/${repository}/check-runs/${711 + index}`}))});
  await saveRoutes();
  expect(github.requiredChecksPassed(await github.checksFor(sha), sha, ["18.8.7"], {id: 502, attempt: 1, headBranch: "maintenance/18.8.7", status: "completed", conclusion: "success"})).toEqual({ok: true});
}, 30000);

test("HTTP three failed attempts perform only two failed-job reruns and restart cannot reset them", async () => {
  await fixture();
  sequence(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=1`, [1, 2, 3].map(run_attempt => ({total_count: 1, workflow_runs: [workflow({run_attempt, conclusion: "failure"})]})));
  for (const attempt of [1, 2]) route(`/repos/${repository}/actions/runs/501/attempts/${attempt}/jobs?filter=all&per_page=100&page=1`, {jobs: jobs({run_attempt: attempt, conclusion: "failure"})});
  for (const attempt of [2, 3]) route(`/repos/${repository}/actions/runs/501/attempts/${attempt}`, workflow({run_attempt: attempt, conclusion: "failure"}));
  route("/fixture/rerun/501", {});
  await saveRoutes();
  const hosted = () => new HostedGitHub({...policy, deadlinesMs: {...policy.deadlinesMs, checks: 40 * 60_000}}, "fixture");
  for (let restart = 0; restart < 2; restart++) await expect(ensureCheckRun(hosted(), sha, ["18.8.7"], "maintenance/18.8.7")).rejects.toThrow("candidate-checks-retries-exhausted:501");
  expect((await requests()).filter(row => row.key === "/fixture/rerun/501")).toHaveLength(2);
}, 30000);

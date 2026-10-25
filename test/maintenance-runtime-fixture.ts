import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSourceSnapshot } from "../src/report";
import { hostAliasOf } from "../scripts/maintenance/measurement-environment";
import { SNAPSHOT_DIR, SUPPORTED_HOSTS, snapshotPath } from "../scripts/maintenance/paths";
import { withInstallLock } from "./bun-install-lock";

export const FIXTURE_PLATFORMS = ["win32", "linux", "darwin"] as const;
export const FIXTURE_ADDED = ["terminal.programStatus", "tts.localSpeed", "speech.speed", "bash.gitGuard", "worktree.onStart", "worktree.onExit"] as const;
const repository = join(import.meta.dir, "..");
export function fixtureGit(root: string, args: readonly string[]): string {
  const child = Bun.spawnSync(["git", "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}
const serverSource = `
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const [directory] = process.argv.slice(2);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
 const path = decodeURIComponent(new URL(request.url).pathname);
 appendFileSync(join(directory, "requests.log"), path + "\\n");
 const file = path.endsWith(".tgz") ? join(directory, path.split("/").pop()) : join(directory, path.slice(1).replaceAll("/", "%2F") + ".json");
 return existsSync(file) ? new Response(readFileSync(file)) : new Response("missing", {status:404});
}}); console.log("ready " + server.port);
`;
function schema(candidate: boolean, platform: string) {
  return Object.fromEntries(["theme.dark", ...(candidate ? FIXTURE_ADDED : [])].map(path => [path, {
    type: "string" as const, default: "", ui: { tab: "General", label: `${path} ${platform}`, description: `Configure ${path} on ${platform}` },
  }]));
}
export interface SemanticRuntimeFixture {
  readonly root: string;
  readonly checkout: string;
  readonly base: string;
  readonly registry: string;
  readonly versions: readonly string[];
  readonly candidate: string;
  applyCandidate(target: string): void;
  requests(): string[];
  close(): Promise<void>;
}
/** Real loopback npm packages and accepted production measurement code; no public registry or reused modules. */
export async function semanticRuntimeFixture(versions: readonly string[] = ["18.8.4"], candidate = "18.8.7"): Promise<SemanticRuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), "semantic-runtime-"));
  const checkout = join(root, "checkout");
  const registryDir = join(root, "registry");
  await mkdir(checkout); await mkdir(registryDir);
  await writeFile(join(registryDir, "requests.log"), "");
  await writeFile(join(registryDir, "server.ts"), serverSource);
  const child = Bun.spawn(["bun", join(registryDir, "server.ts"), registryDir], {stdout:"pipe",stderr:"pipe"});
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let ready = "";
  while (!/ready \d+/.test(ready)) { const chunk = await reader.read(); if (chunk.done) throw new Error("registry-start-failed"); ready += new TextDecoder().decode(chunk.value); }
  const port = Number(ready.match(/ready (\d+)/)![1]);
  const registry = `http://127.0.0.1:${port}/`;
  async function publish(name: string, version: string, files: Record<string,string>) {
    const stage = join(root, "stage"); const pkg = join(stage, "package");
    await mkdir(pkg, {recursive:true});
    await writeFile(join(pkg, "package.json"), JSON.stringify({name,version,type:"module",main:"index.js"}));
    for (const [path, text] of Object.entries(files)) { await mkdir(join(pkg,path,".."),{recursive:true}); await writeFile(join(pkg,path),text); }
    const file = `${name.split("/").pop()}-${version}.tgz`;
    const tar = Bun.spawnSync(["tar","-czf",join(registryDir,file),"-C",stage,"package"],{stdout:"pipe",stderr:"pipe"});
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
    await rm(pkg,{recursive:true,force:true});
    const bytes = await readFile(join(registryDir,file));
    const packumentPath = join(registryDir,`${name.replaceAll("/","%2F")}.json`);
    const packument = await Bun.file(packumentPath).json().catch(() => ({name,"dist-tags":{},versions:{}}));
    packument.versions[version] = {name,version,dist:{tarball:`${registry}${file}?nonce=${crypto.randomUUID()}`,integrity:`sha512-${createHash("sha512").update(bytes).digest("base64")}`}};
    packument["dist-tags"].latest = version;
    await writeFile(packumentPath,JSON.stringify(packument));
  }
  await publish("@oh-my-pi/pi-utils","1.0.0",{"index.js":"export const fixtureUtils = true;"});
  for (const version of [...versions,candidate]) {
    const schemas = Object.fromEntries(FIXTURE_PLATFORMS.map(platform => [platform,schema(version === candidate,platform)]));
    await publish("@oh-my-pi/pi-coding-agent",version,{"config/all-settings.js":`const schemas = ${JSON.stringify(schemas)}; export function orderedSettings() { return Object.entries(schemas[process.platform]).map(([id,definition]) => ({id,definition})); }`});
  }
  for (const file of ["scripts/check-coverage.ts","scripts/diff-upstream.ts","scripts/matrix-host.ts","scripts/matrix-registry-worker.ts","scripts/maintenance/paths.ts","src/report.ts","src/source.ts","src/source-templates.ts","src/host-types.ts","src/translations/types.ts","src/translations/resolve.ts"]) {
    mkdirSync(join(checkout,file,".."),{recursive:true}); copyFileSync(join(repository,file),join(checkout,file));
  }
  writeFileSync(join(checkout,"src/translations/ru.ts"),`import catalog from "./ru-catalog.json"; export const ru = catalog;`);
  const catalog = (includeCandidate: boolean) => {
    const settings: Record<string,{variants: {sourceHash:string;label:string;description:string;platforms:string[];observedIn:string[]}[]}> = {};
    for (const version of includeCandidate ? [...versions,candidate] : versions) for (const platform of FIXTURE_PLATFORMS) {
      const snapshot = buildSourceSnapshot({version,platform,schema:schema(version === candidate,platform)});
      for (const [path,source] of Object.entries(snapshot.settings)) {
        const setting = settings[path] ??= {variants:[]};
        const existing = setting.variants.find(variant=>variant.sourceHash===source.sourceHash);
        if (existing) { if (!existing.observedIn.includes(version)) existing.observedIn.push(version); }
        else setting.variants.push({sourceHash:source.sourceHash,label:`Перевод ${path}`,description:`Описание ${path}`,platforms:[platform],observedIn:[version]});
      }
    }
    return JSON.stringify({locale:"ru",settings},null,2)+"\n";
  };
  const manifest = (candidateIncluded: boolean) => ({name:"omp-settings-ru",version:candidateIncluded?"0.6.0":"0.5.0",type:"module",peerDependencies:{},devDependencies:{"@oh-my-pi/pi-utils":"1.0.0",...Object.fromEntries((candidateIncluded?[...versions,candidate]:versions).map(version => [hostAliasOf(version),`npm:@oh-my-pi/pi-coding-agent@${version}`]))}});
  const supported = (included: boolean) => ({schemaVersion:1,versions:(included?[...versions,candidate]:versions).map(version => ({version,package:hostAliasOf(version),platforms:FIXTURE_PLATFORMS}))});
  function data(target: string, included: boolean) {
    mkdirSync(join(target,SNAPSHOT_DIR),{recursive:true});
    writeFileSync(join(target,SUPPORTED_HOSTS),JSON.stringify(supported(included)));
    for (const version of included?[...versions,candidate]:versions) for (const platform of FIXTURE_PLATFORMS) writeFileSync(join(target,snapshotPath(version,platform)),JSON.stringify(buildSourceSnapshot({version,platform,schema:schema(version===candidate,platform)})));
    writeFileSync(join(target,"src/translations/ru-catalog.json"),catalog(included));
    writeFileSync(join(target,"src/translations/variant-review.json"),JSON.stringify({variants:[]}));
    writeFileSync(join(target,"package.json"),JSON.stringify(manifest(included),null,2));
  }
  async function install() {
    await withInstallLock(() => {
      const run = Bun.spawnSync(["bun","install","--ignore-scripts",`--registry=${registry}`,"--cache-dir",join(root,"cache")],{cwd:checkout,stdout:"pipe",stderr:"pipe",timeout:30_000});
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    });
  }
  data(checkout,false); await install();
  writeFileSync(join(checkout,".gitignore"),"node_modules/\n");
  fixtureGit(checkout,["init","-q","-b","main"]);
  fixtureGit(checkout,["config","core.autocrlf","false"]);
  fixtureGit(checkout,["add","-A"]); fixtureGit(checkout,["commit","-q","-m","accepted base"]);
  const base = fixtureGit(checkout,["rev-parse","HEAD"]);
  data(checkout,true); await install(); const candidateLock = readFileSync(join(checkout,"bun.lock"),"utf8");
  // Restore only this freshly-created fixture to its accepted tree.
  fixtureGit(checkout,["restore","--source=HEAD","--worktree","."]);
  for (const platform of FIXTURE_PLATFORMS) await rm(join(checkout,snapshotPath(candidate,platform)),{force:true});
  return {root,checkout,base,registry,versions,candidate,applyCandidate(target) {data(target,true);writeFileSync(join(target,"bun.lock"),candidateLock);},requests:()=>readFileSync(join(registryDir,"requests.log"),"utf8").split("\n").filter(Boolean),async close(){child.kill("SIGKILL");await child.exited;await rm(root,{recursive:true,force:true});}};
}

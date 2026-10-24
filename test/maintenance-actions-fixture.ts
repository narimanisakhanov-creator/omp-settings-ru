import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";
import { maintenanceBody } from "../scripts/maintenance/actions-github";
import { SNAPSHOT_DIR, SUPPORTED_HOSTS } from "../scripts/maintenance/paths";

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode) throw new Error(proc.stderr.toString()); return proc.stdout.toString().trim();
}
/** The HTTP service owns durable bare refs and release state. Test transport changes URLs only. */
const service = `
import {readFileSync,writeFileSync,appendFileSync} from "node:fs";
import {join} from "node:path";
const [root] = process.argv.slice(2); const config=JSON.parse(readFileSync(join(root,"config.json"),"utf8"));
const {repository,base,head,merge,identity,policy,names,mode}=config;
const bare=join(root,"origin.git");
function git(...args){const p=Bun.spawnSync(["git",...args],{cwd:bare,stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout.toString().trim();}
let draft=mode==="draft"||mode==="manual-draft"||mode==="manual-advanced";let published=!draft;let workflowFailed=draft;let reruns=0;
function save(){writeFileSync(join(root,"state.json"),JSON.stringify({draft,published,reruns}));}save();
const catalog=JSON.stringify({name:"omp-settings-ru",owner:{name:"narimanisakhanov-creator"},plugins:[{name:"omp-settings-ru",description:"Fixture",version:"0.6.0",source:{source:"github",repo:repository,ref:"v0.6.0",sha:merge}}]});
const archive="real fixture archive bytes";const digest=value=>Bun.CryptoHasher.hash("sha256",value,"hex");const sums=digest(archive)+"  omp-settings-ru-0.6.0.tgz\\n";
const assets=[["omp-settings-ru-0.6.0.tgz",archive],["SHA256SUMS",sums],["marketplace.json",catalog]].map(([name,bytes],index)=>({id:901+index,name,digest:"sha256:"+digest(bytes),browser_download_url:"https://github.com/"+repository+"/releases/download/v0.6.0/"+name}));
const release=()=>({id:900,tag_name:"v0.6.0",target_commitish:merge,draft,prerelease:false,published_at:published?"2026-10-24T00:00:00Z":null,assets});
const checkRun={id:501,path:".github/workflows/check.yml",event:"push",head_sha:merge,head_branch:"main",status:"completed",conclusion:"success",check_suite_id:601,run_attempt:1,repository:{full_name:repository},head_repository:{full_name:repository}};
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const url=new URL(request.url);const path=url.pathname;appendFileSync(join(root,"requests.jsonl"),JSON.stringify({method:request.method,path})+"\\n");
const reply=value=>Response.json(value);const api="/repos/"+repository;
if(path===api+"/pulls")return reply([{number:1,state:"closed",draft:false,merged_at:"2026-10-24T00:00:00Z",merge_commit_sha:merge,body:config.body,user:{login:policy.controllerLogin,type:"User"},base:{ref:"main",sha:merge,repo:{full_name:repository}},head:{ref:"upgrade/omp-18.9.0",sha:head,repo:{full_name:repository}}}]);
if(path==="/user")return reply({login:policy.controllerLogin,type:"User"});
if(path===api+"/actions/runs/123/attempts/2")return reply({id:123,run_attempt:2,path:".github/workflows/upstream-watch.yml",event:"schedule",head_branch:"main",head_sha:base,repository:{full_name:repository}});
if(path===api+"/actions/runs/501")return reply(checkRun);
if(path===api+"/actions/runs")return reply({total_count:1,workflow_runs:[checkRun]});
if(path===api+"/commits/"+merge+"/check-runs")return reply({total_count:names.length,check_runs:names.map((name,index)=>({id:701+index,name,head_sha:merge,status:"completed",conclusion:"success",app:{slug:"github-actions"},check_suite:{id:601}}))});
if(path===api+"/actions/runs/501/jobs")return reply({total_count:names.length,jobs:names.map((name,index)=>({id:801+index,run_id:501,name,head_sha:merge,status:"completed",conclusion:"success",check_run_url:"https://api.github.com/repos/"+repository+"/check-runs/"+(701+index)}))});
if(path===api+"/git/ref/heads/main")return reply({object:{type:"commit",sha:git("rev-parse","refs/heads/main")}});
if(path===api+"/git/ref/heads/upgrade/omp-18.9.0"){const p=Bun.spawnSync(["git","rev-parse","--verify","refs/heads/upgrade/omp-18.9.0"],{cwd:bare,stdout:"pipe",stderr:"pipe"});return p.exitCode?new Response("HTTP 404",{status:404}):reply({object:{type:"commit",sha:p.stdout.toString().trim()}});}
if(path===api+"/git/refs/heads/upgrade/omp-18.9.0"&&request.method==="DELETE"){git("update-ref","-d","refs/heads/upgrade/omp-18.9.0",head);return new Response(null,{status:204});}
if(path===api+"/git/ref/tags/v0.6.0"){const p=Bun.spawnSync(["git","rev-parse","--verify","refs/tags/v0.6.0"],{cwd:bare,stdout:"pipe",stderr:"pipe"});return p.exitCode?new Response("HTTP 404",{status:404}):reply({object:{type:"commit",sha:p.stdout.toString().trim()}});}
if(path===api+"/git/refs"&&request.method==="POST"){const body=await request.json();if(body.ref!=="refs/tags/v0.6.0"||body.sha!==merge)return new Response("bad tag",{status:400});git("update-ref",body.ref,body.sha,"0".repeat(40));return reply({ref:body.ref,object:{sha:body.sha}});}
if(path===api+"/releases")return reply([release()]);
if(path===api+"/releases/tags/v0.6.0"||path===api+"/releases/latest")return reply(release());
if(path===api+"/releases/assets/903")return new Response(catalog);
if(path.endsWith("/releases/download/v0.6.0/omp-settings-ru-0.6.0.tgz"))return new Response(archive);
if(path.endsWith("/releases/download/v0.6.0/SHA256SUMS"))return new Response(sums);
if(path.endsWith("/releases/latest/download/marketplace.json"))return new Response(catalog);
if(path===api+"/actions/workflows/release.yml/runs")return reply({workflow_runs:[{id:1001,run_attempt:1,path:".github/workflows/release.yml",event:"push",head_sha:merge,head_branch:"v0.6.0",status:"completed",conclusion:"success",repository:{full_name:repository}}]});
if(path===api+"/actions/workflows/marketplace-index.yml/runs")return reply({workflow_runs:[{id:1002,run_attempt:1,path:".github/workflows/marketplace-index.yml",event:(mode==="manual-draft"||mode==="manual-advanced")?"workflow_dispatch":"workflow_run",head_sha:mode==="manual-draft"?merge:base,head_branch:(mode==="manual-draft"||mode==="manual-advanced")?"main":"main",display_title:(mode==="manual-draft"||mode==="manual-advanced")?"Publish v0.6.0":"marketplace-index",inputs:(mode==="manual-draft"||mode==="manual-advanced")?{tag:"v0.6.0"}:undefined,status:"completed",conclusion:workflowFailed?"failure":"success",repository:{full_name:repository}}]});
if(path===api+"/actions/runs/1002/artifacts")return reply({artifacts:[{id:2002,name:"prepublish-v0.6.0-1002-1",expired:false,workflow_run:{id:1002,head_sha:base}}]});
if(path==="/fixture/rerun"&&request.method==="POST"){reruns++;workflowFailed=false;draft=false;published=true;save();return reply({ok:true});}
return new Response("HTTP 404",{status:404});}});console.log(server.port);
`;
export async function recoveryFixture(mode: "merge-without-tag" | "draft" | "manual-draft" | "manual-advanced" | "published") {
  const root = await mkdtemp(join(tmpdir(), "omp-hosted-recovery-")); const repo = join(root, "repo"); const bare = join(root, "origin.git"); await mkdir(repo);
  git(repo, "init", "-b", "main"); await writeFile(join(repo, "package.json"), JSON.stringify({ version: "0.5.0" })); await writeFile(join(repo, "supported.json"), "base"); git(repo, "add", "."); git(repo, "commit", "-m", "base"); const base = git(repo, "rev-parse", "HEAD");
  await mkdir(join(repo, SNAPSHOT_DIR), { recursive: true }); await writeFile(join(repo, SUPPORTED_HOSTS), JSON.stringify({ versions: [{ version: "18.9.0" }] })); await writeFile(join(repo, "package.json"), JSON.stringify({ version: "0.6.0" })); git(repo, "add", "."); git(repo, "commit", "-m", "chore: support OMP 18.9.0"); const head = git(repo, "rev-parse", "HEAD");
  const merge = git(repo, "commit-tree", git(repo, "rev-parse", "HEAD^{tree}"), "-p", base, "-p", head, "-m", "Merge candidate"); git(repo, "update-ref", "refs/heads/main", merge);
  git(root, "init", "--bare", bare); git(repo, "remote", "add", "origin", bare); git(repo, "push", "origin", "main", `${head}:refs/heads/upgrade/omp-18.9.0`);
  if (mode !== "merge-without-tag") git(bare, "update-ref", "refs/tags/v0.6.0", merge);
  const policy = validatePolicy(rawPolicy); const identity = { schemaVersion: 1 as const, repository: policy.repository, upstreamVersion: "18.9.0", releaseVersion: "0.6.0", baseSha: base, headSha: head, runId: "123", runAttempt: "2", artifactId: "42", manifestSha256: "c".repeat(64) };
  const names = [...policy.requiredCheckPlatforms.map(pair => policy.requiredCheckTemplate.replaceAll("{os}", pair.os).replaceAll("{version}", "18.9.0")), ...policy.additionalRequiredChecks];
  await writeFile(join(root, "config.json"), JSON.stringify({ repository: policy.repository, base, head, merge, identity, policy, names, mode, body: maintenanceBody(identity) }));
  await writeFile(join(root, "server.ts"), service); await writeFile(join(root, "requests.jsonl"), "");
  const child = Bun.spawn([process.execPath, join(root, "server.ts"), root], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader(); let line = "";
  while (!line.includes("\n")) { const next = await reader.read(); if (next.done) throw new Error("recovery-service-failed:" + await new Response(child.stderr).text()); line += new TextDecoder().decode(next.value); } reader.releaseLock();
  const origin = `http://127.0.0.1:${Number(line.trim())}`;
  const transport = join(root, "gh.ts");
  await writeFile(transport, `const args=process.argv.slice(2);let path="";let method="GET";const body={};if(args[0]==="run"&&args[1]==="rerun"){method="POST";path="fixture/rerun";}else if(args[0]==="api"){for(let i=1;i<args.length;i++){if(args[i]==="--method")method=args[++i];else if(args[i]==="-f"||args[i]==="-F"){const value=args[++i];const at=value.indexOf("=");body[value.slice(0,at)]=value.slice(at+1);}else if(args[i]==="-H")i++;else path=args[i];}}else throw new Error("refused");const response=await fetch(${JSON.stringify(origin)}+"/"+path,{method,...(method==="POST"||method==="PATCH"?{body:JSON.stringify(body),headers:{"content-type":"application/json"}}:{})});if(!response.ok){console.error("HTTP "+response.status);process.exit(1);}process.stdout.write(Buffer.from(await response.arrayBuffer()));`);
  return { root, repo, bare, base, head, merge, policy, origin, transport, async cleanup() { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }, git: (...args: string[]) => git(bare, ...args) };
}

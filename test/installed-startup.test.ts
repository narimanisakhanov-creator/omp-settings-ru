import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInstalledSmoke } from "../scripts/installed-smoke";
import { updaterTestExecutable } from "../scripts/ci/prepare-host";
const executable=updaterTestExecutable(process.env,()=>process.platform==="win32"?join(process.env.LOCALAPPDATA??"","omp","omp.exe"):Bun.which("omp"));
const versionProbe=Bun.spawnSync([executable,"--version"],{stdout:"pipe",stderr:"pipe",timeout:30000});
const hostVersion=/^(?:omp(?: v|\/))?(\d+\.\d+\.\d+)\s*$/.exec(versionProbe.stdout.toString().trim())?.[1];
if(versionProbe.exitCode!==0||!hostVersion)throw new Error("installed-startup-host-unverifiable");
if(process.env.OMP_UPDATER_HOST_VERSION&&process.env.OMP_UPDATER_HOST_VERSION!==hostVersion)throw new Error("installed-startup-host-version-mismatch");
test("startup-only driver observes real settings without claiming translation roundtrip",async()=>{
 const receipt=await runInstalledSmoke({executable,pluginPath:process.cwd(),ownedProfile:`omp-settings-ru-proof-startup-${hostVersion.replaceAll(".","")}`,mode:"pre-activation",startupOnly:true});
 expect(receipt.hostVersion).toBe(hostVersion);
 expect(receipt.observations.map(observation=>observation.kind)).toEqual(["startup","settings-panel"]);
 expect(receipt.observations.find(observation=>observation.kind==="startup")?.output).toContain("no-model");
 expect(receipt.startupPassed).toBe(true);
 expect(receipt.installedPanel).toBe(false);
},60000);
/**
 * Bun re-reads .env from the child cwd even when the parent passes an explicit
 * env allowlist. This drives the real runInstalledSmoke from a disposable cwd
 * whose only .env entry is a non-secret sentinel: the production worker must
 * start with --no-env-file, otherwise the startup/panel smoke sees the sentinel
 * and the outer isolation check rejects it.
 */
test("installed smoke keeps its env allowlist when cwd has a .env file",()=>{
 const root=mkdtempSync(join(tmpdir(),"omp-smoke-env-file-"));
 try {
  const home=join(root,"home");
  const profile=`omp-settings-ru-proof-envfile-${hostVersion.replaceAll(".","")}-${process.pid}-${Date.now()}`;
  const wrapper=resolve(import.meta.dir,"fixtures","env-file-smoke-wrapper.ts");
  mkdirSync(home,{recursive:true});
  writeFileSync(join(root,".env"),"OMP_SMOKE_PRIVATE_SENTINEL=dotenv-only\n");
  const environment:Record<string,string>={};
  for(const key of ["PATH","PATHEXT","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","TMPDIR"]){const value=process.env[key];if(value)environment[key]=value;}
  environment.HOME=home;
  environment.USERPROFILE=home;
  const result=Bun.spawnSync([process.execPath,"--no-env-file",wrapper,executable,process.cwd(),profile,home],{cwd:root,env:environment,stdout:"pipe",stderr:"pipe",timeout:150000});
  const stderr=result.stderr.toString().replaceAll(root,"[owned-root]");
  if(result.exitCode!==0)throw new Error("env-file-smoke-failed:"+stderr.slice(-2000));
  const receipt=JSON.parse(result.stdout.toString());
  expect(receipt.hostVersion).toBe(hostVersion);
  expect(receipt.observations.map((observation:{kind:string})=>observation.kind)).toEqual(["startup","settings-panel"]);
  expect(receipt.observations.find((observation:{kind:string;output:string})=>observation.kind==="startup")?.output).toContain("no-model");
  expect(receipt.startupPassed).toBe(true);
  expect(receipt.installedPanel).toBe(false);
  expect(receipt.isolation.ambientCredentialInherited).toBe(false);
 } finally {
  rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
},180000);

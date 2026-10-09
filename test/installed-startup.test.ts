import { expect, test } from "bun:test";
import { join } from "node:path";
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
 expect(receipt.startupPassed).toBe(true);
 expect(receipt.installedPanel).toBe(false);
},60000);

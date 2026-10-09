import { expect, test } from "bun:test";
import { mkdtemp, cp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("candidate refresh preserves tested peer range and historical baseline lineage", async()=>{
 const directory=await mkdtemp(join(tmpdir(),"omp-upgrade-domain-"));
 try {
  for(const path of ["src","scripts","baseline","package.json","bun.lock","tsconfig.json"])await cp(path,join(directory,path),{recursive:true});
  await symlink(join(process.cwd(),"node_modules"),join(directory,"node_modules"),process.platform==="win32"?"junction":"dir");
  const before=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
  // Refresh to the version already pinned, so the proof follows each host bump instead of one literal.
  const current=before.devDependencies["@oh-my-pi/pi-coding-agent"] as string;
  const alias=`omp-host-${current.replaceAll(".","")}`;
  const result=Bun.spawnSync(["bun","scripts/upgrade-host.ts",current],{cwd:directory,stdout:"pipe",stderr:"pipe",timeout:120000});
  if(result.exitCode!==0)console.error(result.stderr.toString());
  expect(result.exitCode).toBe(0);
  const after=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
  expect(after.peerDependencies).toEqual(before.peerDependencies);
  expect(after.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe(current);
  expect(after.devDependencies[alias]).toBe(`npm:@oh-my-pi/pi-coding-agent@${current}`);
  expect((await readFile(join(directory,"upgrade-report.md"),"utf8"))).toContain(`${current} → ${current}`);
 } finally {await rm(directory,{recursive:true,force:true});}
},180000);

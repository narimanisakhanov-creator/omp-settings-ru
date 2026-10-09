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
  const result=Bun.spawnSync(["bun","scripts/upgrade-host.ts","18.8.4"],{cwd:directory,stdout:"pipe",stderr:"pipe",timeout:120000});
  if(result.exitCode!==0)console.error(result.stderr.toString());
  expect(result.exitCode).toBe(0);
  const after=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
  expect(after.peerDependencies).toEqual(before.peerDependencies);
  expect(after.devDependencies["@oh-my-pi/pi-coding-agent"]).toBe("18.8.4");
  expect(after.devDependencies["omp-host-1884"]).toBe("npm:@oh-my-pi/pi-coding-agent@18.8.4");
  expect((await readFile(join(directory,"upgrade-report.md"),"utf8"))).toContain("18.8.4 → 18.8.4");
 } finally {await rm(directory,{recursive:true,force:true});}
},180000);

import { expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precheck, mergeGate, deriveChecks, releaseDecision, publicationPlan, command, verifyLockChange, botIdentity, manifestChecks, validateMetadata, verifyProvenance, prepareScanner, validateReleasePairs } from "../scripts/maintenance/github";
import type { PublicationEvidence, PrObservation } from "../scripts/maintenance/github";
import { StateStore, initialState, effectDecision, resumeFence, rebaseReviewState } from "../scripts/maintenance/state";
import { workerDecision, Orca } from "../scripts/maintenance/orca";
import { registrationDecision, policyDigest, hostPrecheck, maintenancePrompt } from "../scripts/maintenance/automation";
import type { MaintenancePolicy, ReleasePin } from "../scripts/maintenance/contracts";
import { advanceController } from "../scripts/maintenance";
import * as maintenanceGithub from "../scripts/maintenance/github";
const policy:MaintenancePolicy=await Bun.file("maintenance.config.json").json();
const sha="a".repeat(40),base="b".repeat(40);
const pr:PrObservation={repository:policy.repository,number:4,headRepository:policy.repository,baseBranch:"main",branch:"upgrade/omp-18.8.4",headSha:sha,baseSha:base,author:{login:policy.botLogin,type:"Bot"},state:"OPEN",draft:false,files:[{path:"baseline/18.8.4-win32.json",mode:"100644"}],hostPins:["18.8.4"]};
const eligible={repository:policy.repository,number:4,sourceHeadSha:sha,baseSha:base,branch:pr.branch,candidateVersion:"18.8.4",changedPaths:[]};
for(const [label,patch,kind,reason] of [
  ["trusted",{},"eligible",undefined],
  ["untrusted",{author:{login:"human",type:"User"}},"skip","untrusted-author"],
  ["foreign",{headRepository:"attacker/repo"},"skip","foreign-head"],
  ["wrong branch",{branch:"feature/free-text"},"skip","branch-ineligible"],
  ["unsafe paths",{files:[{path:".github/workflows/release.yml",mode:"100644"}]},"blocked","path-outside-policy"],
  ["symlink",{files:[{path:"package.json",mode:"120000"}]},"blocked","unsafe-file-mode"],
  ["missing SHA",{headSha:""},"blocked","invalid-sha"],
  ["pin mismatch",{hostPins:["18.8.0"]},"blocked","candidate-pin-mismatch"],
] satisfies readonly [string,Partial<PrObservation>,"eligible"|"skip"|"blocked",string|undefined][])test(`precheck ${label}`,()=>{const result=precheck(policy,{...pr,...patch},{now:1,deadline:2});expect(result.kind).toBe(kind);if(reason&&result.kind!=="eligible")expect(result.reason).toBe(reason);if(result.kind==="eligible")expect(result.pr.sourceHeadSha).toBe(sha);});
test("deadline never grants launch",()=>{expect(precheck(policy,pr,{now:2,deadline:2})).toEqual({kind:"blocked",reason:"deadline-expired"});});
test("candidate host registry alias is allowed only for the exact candidate version",()=>{
  const candidate="18.9.0", alias="omp-host-1890", spec=`npm:@oh-my-pi/pi-coding-agent@${candidate}`;
  const beforePackage={version:"0.2.0",devDependencies:{"@oh-my-pi/pi-coding-agent":"18.8.4","omp-host-1861":"npm:@oh-my-pi/pi-coding-agent@18.6.1","omp-host-1880":"npm:@oh-my-pi/pi-coding-agent@18.8.0","omp-host-1884":"npm:@oh-my-pi/pi-coding-agent@18.8.4"},peerDependencies:{"@oh-my-pi/pi-coding-agent":"18.6.1 || 18.8.0 || 18.8.4"}};
  const afterPackage={...beforePackage,version:"0.2.1",devDependencies:{...beforePackage.devDependencies,"@oh-my-pi/pi-coding-agent":candidate,[alias]:spec},peerDependencies:{"@oh-my-pi/pi-coding-agent":"18.6.1 || 18.8.0 || 18.8.4 || 18.9.0"}};
  const beforeSupport={schemaVersion:1,versions:[{version:"18.6.1",package:"omp-host-1861",platforms:["win32","darwin","linux"]},{version:"18.8.0",package:"omp-host-1880",platforms:["win32","darwin","linux"]},{version:"18.8.4",package:"omp-host-1884",platforms:["win32","darwin","linux"]}]};
  const afterSupport={...beforeSupport,versions:[...beforeSupport.versions,{version:candidate,package:alias,platforms:["win32","darwin","linux"]}]};
  expect(validateMetadata(policy,beforePackage,afterPackage,beforeSupport,afterSupport,candidate)).toBeUndefined();
  const wrongAlias={...afterPackage,devDependencies:{...afterPackage.devDependencies,"omp-host-9990":spec}};
  expect(validateMetadata(policy,beforePackage,wrongAlias,beforeSupport,afterSupport,candidate)).toBe("package-dependency-outside-policy");
  const wrongSpec={...afterPackage,devDependencies:{...afterPackage.devDependencies,[alias]:"npm:@oh-my-pi/pi-coding-agent@18.9.1"}};
  expect(validateMetadata(policy,beforePackage,wrongSpec,beforeSupport,afterSupport,candidate)).toBe("package-dependency-outside-policy");
  const changedHistory={...afterPackage,devDependencies:{...afterPackage.devDependencies,"omp-host-1861":"npm:@oh-my-pi/pi-coding-agent@18.6.2"}};
  expect(validateMetadata(policy,beforePackage,changedHistory,beforeSupport,afterSupport,candidate)).toBe("package-dependency-outside-policy");
  const incoming=precheck(policy,{...pr,branch:"upgrade/omp-18.9.0",hostPins:[candidate],files:[{path:"package.json",mode:"100644"}],packageBefore:beforePackage,packageAfter:afterPackage},{now:1,deadline:2});
  expect(incoming.kind).toBe("eligible");
});
test("generation key is PR plus original head",()=>{const state=initialState(eligible,100);expect(state.key).toBe(`${policy.repository}/pr-4/${sha}`);expect(state.workingHeadSha).toBeUndefined();expect(state.reviewedHeadSha).toBeUndefined();expect(state.mergeSha).toBeUndefined();});
test("exclusive repo lock refuses concurrent tasks and foreign cleanup",async()=>{const dir=await mkdtemp(join(tmpdir(),"controller-"));try{const first=new StateStore(dir),second=new StateStore(dir);const lock=await first.acquire("pr-4");await expect(second.acquire("pr-5")).rejects.toThrow("repo-locked");await expect(second.release({...lock,nonce:"foreign"})).rejects.toThrow("lock-owner-mismatch");expect(JSON.parse(await readFile(join(dir,"repo.lock"),"utf8")).key).toBe("pr-4");await first.release(lock);}finally{await rm(dir,{recursive:true,force:true});}});
test("atomic revision refuses lost writer update",async()=>{const dir=await mkdtemp(join(tmpdir(),"controller-"));try{const store=new StateStore(dir),state=initialState(eligible,100);const lock=await store.acquire(state.key);await store.save(state,-1,lock);await store.save({...state,revision:1,stage:"working"},0,lock);await expect(store.save({...state,revision:1,stage:"blocked"},0,lock)).rejects.toThrow("revision-conflict");expect((await store.load(state.key))?.stage).toBe("working");await store.release(lock);}finally{await rm(dir,{recursive:true,force:true});}});
test("intent after crash refuses unknown mutation evidence",()=>{const effect={key:"tag",intent:{sha}};expect(effectDecision(effect,{kind:"unknown"})).toBe("blocked");expect(effectDecision(effect,{kind:"absent"})).toBe("apply");expect(effectDecision(effect,{kind:"found",receipt:{sha}})).toBe("record");expect(effectDecision({...effect,receipt:{sha}},{kind:"found",receipt:{sha}})).toBe("complete");});
test("stale working SHA and expired deadline block resume",()=>{expect(resumeFence({sourceHeadSha:sha,workingHeadSha:base,deadline:100},sha,1)).toBe("stale-head");expect(resumeFence({sourceHeadSha:sha,deadline:100},sha,100)).toBe("deadline-expired");});
function evidence():PublicationEvidence {
  const binding={schemaVersion:1 as const,headSha:sha,treeHash:"2".repeat(40),archiveSha256:"3".repeat(64),contentHash:"5".repeat(64),fileCount:25,extractionVerified:true as const};
  const checks=deriveChecks(policy,["18.6.1","18.8.0"],"18.8.4").map((name,index)=>({id:index+1,name,headSha:sha,status:"completed",conclusion:"success"}));
  const smoke=policy.requiredCheckPlatforms.flatMap(({platform,os})=>["18.6.1","18.8.0","18.8.4"].map(version=> {
    const checkRunId=checks.find(c=>c.name===policy.requiredCheckTemplate.replaceAll("{os}",os).replaceAll("{version}",version))!.id;
    const workflowRunId="123",runAttempt="1",executable={name:"omp",sha256:"6".repeat(64)};
    const receipt={schemaVersion:1,version,platform,native:true,passed:true,checkRunId,checkRunHeadSha:sha,workflowRunId,runAttempt,binding,executable,smoke:{passed:true,installedPanel:true,hostVersion:version,platform,contentHash:binding.contentHash,executableSha256:executable.sha256,isolation:{ambientCredentialInherited:false,homeIsolated:true,providerRoundTrip:false},observations:[{kind:"settings-panel",output:"domain fixture"}]}};
    return {checkRunId,checkRunHeadSha:sha,platform,version,passed:true,native:true,headSha:sha,treeHash:binding.treeHash,contentHash:binding.contentHash,binding,receipt,workflowRunId,runAttempt,executableSha256:executable.sha256};
  }));
  return {headSha:sha,baseSha:base,supportedVersions:["18.6.1","18.8.0"],candidateVersion:"18.8.4",review:{headSha:sha,baseSha:base,verdict:"approved",dispatchId:"review",executorDispatchId:"executor",evidenceHashes:["1".repeat(64)]},checks,treeHash:binding.treeHash,artifactHash:binding.archiveSha256,binding,smoke,privacy:{headSha:sha,artifactHash:binding.archiveSha256,passed:true,scanner:"gitleaks",scannerHash:"4".repeat(64),scopes:["refs","worktree","package"]}};
}
for(const failure of ["missing-checks","failed-check","stale-check","review-missing","review-rejected","same-reviewer","smoke-missing","smoke-stale","wrong-tree","wrong-artifact","privacy-missing","head-changed","base-changed"])test(`publication refuses ${failure}`,()=>{const e=evidence();let head=sha,currentBase=base;
  if(failure==="missing-checks")e.checks=[];if(failure==="failed-check")e.checks=[{...e.checks[0]!,conclusion:"skipped"},...e.checks.slice(1)];if(failure==="stale-check")e.checks=[{...e.checks[0]!,headSha:base},...e.checks.slice(1)];
  if(failure==="review-missing")delete e.review;if(failure==="review-rejected")e.review={...e.review!,verdict:"inconclusive"};if(failure==="same-reviewer")e.review={...e.review!,dispatchId:"executor"};
  if(failure==="smoke-missing")e.smoke=[];if(failure==="smoke-stale")e.smoke=[{...e.smoke[0]!,headSha:base},...e.smoke.slice(1)];if(failure==="wrong-tree")e.treeHash="9".repeat(40);if(failure==="wrong-artifact")e.artifactHash="9".repeat(64);if(failure==="privacy-missing")delete e.privacy;if(failure==="head-changed")head=base;if(failure==="base-changed")currentBase=sha;expect(mergeGate(policy,e,head,currentBase).ok).toBe(false);
});
test("complete autonomous evidence pins verified head without per run human flag",()=>{expect(mergeGate(policy,evidence(),sha,base)).toEqual({ok:true,headSha:sha});});
test("candidate extends finite matrix and unexpected version blocks",()=>{const expected=deriveChecks(policy,["18.6.1","18.8.0"],"18.9.0");expect(expected).toContain("check (windows-2025, 18.9.0)");expect(expected).not.toContain("check (windows-2025, 18.8.4)");const e=evidence();e.checks=[...e.checks,{name:"check (windows-2025, 99.0.0)",headSha:sha,status:"completed",conclusion:"success"}];expect(mergeGate(policy,e,sha,base).ok).toBe(false);});
test("release reconciliation pins tag asset workflow and stable",()=>{const pin:ReleasePin={tag:"v0.3.0",commitSha:sha,assetId:42,sha256:"3".repeat(64),packageVersion:"0.3.0",supportedPairs:[{hostVersion:"18.8.4",platform:"win32"}]};const observed={tagSha:sha,release:{tag:pin.tag,draft:false,assetId:42,sha256:pin.sha256,packageVersion:pin.packageVersion},workflow:{headSha:sha,status:"completed",conclusion:"success"},stableSha:sha};expect(releaseDecision(pin,observed)).toBe("ready");expect(releaseDecision(pin,{...observed,tagSha:base})).toBe("tag-conflict");expect(releaseDecision(pin,{...observed,stableSha:base})).toBe("stable-mismatch");expect(releaseDecision(pin,{...observed,release:undefined})).toBe("wait-release");});
test("publication plan never recreates matching tag release",()=>{expect(publicationPlan(policy,evidence(),sha,base,{state:"OPEN"}).merge.headSha).toBe(sha);expect(publicationPlan(policy,evidence(),base,base,{state:"OPEN"}).reason).toBe("stale-head");expect(publicationPlan(policy,evidence(),sha,base,{state:"MERGED",mergeSha:sha,tagSha:sha,releaseExists:true}).mutations).toEqual([]);});
test("unknown worker failure and question never imply settled success",()=>{expect(workerDecision({})).toBe("blocked-unknown-receipt");expect(workerDecision({failedStage:"consumer_fenced",residualResources:{terminal:"kept"}})).toBe("consumer_fenced");expect(workerDecision({kind:"question"})).toBe("blocked-question");expect(workerDecision({taskId:"t",dispatchId:"d",activeDispatchId:"d",type:"worker_done",outcome:"failed"})).toBe("failed");});
test("disabled schedule refuses enabled or drifted duplicate",()=>{expect(registrationDecision([],"digest")).toBe("create-disabled");expect(registrationDecision([{name:"omp-settings-ru-maintenance",digest:"digest",enabled:false}],"digest")).toBe("existing-disabled");expect(registrationDecision([{name:"omp-settings-ru-maintenance",digest:"digest",enabled:true}],"digest")).toBe("blocked-enabled");});
test("CLI fixture grants eligible only and cannot launch unsafe",async()=>{for(const [observation,code,kind] of [[pr,0,"eligible"],[{...pr,author:{login:"human",type:"User"}},10,"skip"],[{...pr,headSha:""},11,"blocked"]] as const){const child=Bun.spawn(["bun","scripts/maintenance.ts","--precheck","--fixture-stdin"],{stdin:new TextEncoder().encode(JSON.stringify({policy,pr:observation})),stdout:"pipe",stderr:"pipe"});const output=await new Response(child.stdout).text();expect(await child.exited).toBe(code);expect(JSON.parse(output).kind).toBe(kind);}});
test("sanitized stderr retains cause without user paths or credential",async()=>{const result=await command("bun",["-e","console.error('ENOENT C:/Users/alice/private ghp_abcdefghijklmnopqrstuvwxyz1234567890');process.exit(2)"],1000);expect(result.code).toBe(2);expect(result.stderr).toContain("ENOENT");expect(result.stderr).toContain("<user>");expect(result.stderr).not.toContain("alice");expect(result.stderr).not.toContain("ghp_");});
test("real previous mode and deletion have exact refusals",()=>{expect(precheck(policy,{...pr,files:[{path:"package.json",mode:"100644",previousMode:"100755"}]},{now:1,deadline:2})).toEqual({kind:"blocked",reason:"unsafe-file-mode"});expect(precheck(policy,{...pr,files:[{path:"package.json",mode:"100644",previousMode:"100644",deleted:true}]},{now:1,deadline:2})).toEqual({kind:"blocked",reason:"incoming-file-deletion"});});
test("lock verification binds actual bytes and rejects new dependency",()=>{const old={lockfileVersion:1,workspaces:{"":{devDependencies:{"@oh-my-pi/pi-utils":"18.8.0"}}},packages:{"@oh-my-pi/pi-utils":["@oh-my-pi/pi-utils@18.8.0","",{},"sha512-abc"]} satisfies Record<string,unknown[]>};const next=structuredClone(old);next.workspaces[""].devDependencies["@oh-my-pi/pi-utils"]="18.8.4";next.packages["@oh-my-pi/pi-utils"][0]="@oh-my-pi/pi-utils@18.8.4";const receipt=verifyLockChange(JSON.stringify(old),JSON.stringify(next),sha,"18.8.4",JSON.stringify(next));expect(precheck(policy,{...pr,files:[{path:"bun.lock",mode:"100644"}],lockReceipt:receipt},{now:1,deadline:2}).kind).toBe("eligible");expect(verifyLockChange(JSON.stringify(old),JSON.stringify({...next,packages:{...next.packages,evil:["evil@1.0.0"]}}),sha,"18.8.4",JSON.stringify(next)).refusal).toBe("lockfile-unexpected-package-change");
});
test("filesystem restart reconciles tag and release with zero mutation",async()=>{const dir=await mkdtemp(join(tmpdir(),"controller-"));try{const store=new StateStore(dir);let state=initialState(eligible,Date.now()+10000);const lock=await store.acquire(state.key);await store.save(state,-1,lock);state={...state,revision:1,effects:[{key:"tag",intent:{sha}}]};await store.save(state,0,lock);let mutations=0;const apply=async()=>{mutations++;return {sha};};await expect(store.effect(state,lock,"tag",{sha},async()=>({kind:"unknown"}),apply)).rejects.toThrow("effect-unverifiable");state=await store.effect(state,lock,"tag",{sha},async()=>({kind:"found",receipt:{sha}}),apply);state=(await store.load(state.key))!;state=await store.effect(state,lock,"tag",{sha},async()=>({kind:"found",receipt:{sha}}),apply);state=await store.effect(state,lock,"release",{sha},async()=>({kind:"found",receipt:{assetId:42}}),apply);expect(mutations).toBe(0);expect(state.effects.map(e=>e.key)).toEqual(["tag","release"]);await store.release(lock);}finally{await rm(dir,{recursive:true,force:true});}});
test("REST bot identity matches only configured app and real Bot type",()=>{expect(botIdentity({login:"github-actions[bot]",type:"Bot"},"app/github-actions")).toEqual({login:"app/github-actions",type:"Bot"});expect(botIdentity({login:"github-actions[bot]",type:"User"},"app/github-actions").login).toBe("github-actions[bot]");});
test("accepted finite manifest drives candidate check union",()=>{const manifest={schemaVersion:1,versions:[{version:"18.6.1",platforms:["win32","darwin","linux"]}]};expect(manifestChecks(policy,manifest,"18.9.0")).toContain("check (ubuntu-24.04, 18.9.0)");});
test("worker supplied smoke flags cannot authorize publication without receipt provenance",()=>{const e=evidence();e.smoke=e.smoke.map(({checkRunId,...smoke})=>smoke);expect(mergeGate(policy,e,sha,base)).toEqual({ok:false,reason:"native-receipt-provenance-missing"});});
test("support manifest refuses duplicate versions and arbitrary policy fields",()=>{expect(()=>manifestChecks(policy,{schemaVersion:1,versions:[{version:"18.6.1",platforms:["win32","darwin","linux"]},{version:"18.6.1",platforms:["win32","darwin","linux"]}],allowlist:["scripts/maintenance.ts"]},"18.9.0")).toThrow("supported-manifest-field-outside-policy");});
test("host lock update cannot introduce lifecycle or new dependency metadata",()=>{const before={lockfileVersion:1,workspaces:{"":{devDependencies:{"@oh-my-pi/pi-utils":"18.8.0"}}},packages:{"@oh-my-pi/pi-utils":["@oh-my-pi/pi-utils@18.8.0","",{},"sha512-abc"]}};const after={lockfileVersion:1,workspaces:{"":{devDependencies:{"@oh-my-pi/pi-utils":"18.8.4"}}},packages:{"@oh-my-pi/pi-utils":["@oh-my-pi/pi-utils@18.8.4","",{scripts:{postinstall:"evil"},dependencies:{evil:"1.0.0"}},"sha512-abc"]}};expect(verifyLockChange(JSON.stringify(before),JSON.stringify(after),sha,"18.8.4").refusal).toBe("lockfile-host-metadata-change");});
test("support manifest rejects claimed support with missing finite platform",()=>{expect(()=>manifestChecks(policy,{schemaVersion:1,versions:[{version:"18.9.0",platforms:["win32","darwin","linux","other"]}]},"18.9.0")).toThrow("supported-manifest-incomplete");});
test("executor metadata permits finite peers but refuses script dependency and support removal",()=>{const candidate="18.9.0",alias="omp-host-1890",oldAlias="omp-host-1861",previous={schemaVersion:1,versions:[{version:"18.6.1",package:oldAlias,platforms:["win32","linux","darwin"]}],installedEvidence:[],unavailableInstalledRuns:[]};const next={...previous,versions:[...previous.versions,{version:candidate,package:alias,platforms:["win32","darwin","linux"]}]};const pkg={version:"0.2.0",scripts:{test:"bun test"},peerDependencies:{"@oh-my-pi/pi-utils":"18.6.1"},devDependencies:{"@oh-my-pi/pi-utils":"18.6.1",[oldAlias]:"npm:@oh-my-pi/pi-coding-agent@18.6.1"}};const updated={...pkg,version:"0.2.1",peerDependencies:{"@oh-my-pi/pi-utils":"18.6.1 || 18.9.0"},devDependencies:{"@oh-my-pi/pi-utils":candidate,[oldAlias]:"npm:@oh-my-pi/pi-coding-agent@18.6.1",[alias]:"npm:@oh-my-pi/pi-coding-agent@18.9.0"}};expect(validateMetadata(policy,pkg,updated,previous,next,candidate)).toBeUndefined();expect(validateMetadata(policy,pkg,{...updated,dependencies:{evil:"1"}},previous,next,candidate)).toBe("package-field-outside-policy");expect(validateMetadata(policy,pkg,{...updated,devDependencies:{...updated.devDependencies,[alias]:"npm:@oh-my-pi/pi-coding-agent@18.9.1"}},previous,next,candidate)).toBe("package-dependency-outside-policy");expect(validateMetadata(policy,pkg,{...updated,devDependencies:{...updated.devDependencies,[oldAlias]:"npm:@oh-my-pi/pi-coding-agent@18.6.2"}},previous,next,candidate)).toBe("package-dependency-outside-policy");expect(validateMetadata(policy,pkg,updated,next,previous,candidate)).toBe("supported-version-removed");});
test("artifact and scanner provenance verifies actual bytes not report flags",async()=>{const dir=await mkdtemp(join(tmpdir(),"provenance-"));try{await writeFile(join(dir,"package.tgz"),"actual artifact bytes");await writeFile(join(dir,"scan.json"),"[]");await expect(verifyProvenance({sourceDirectory:dir,headSha:sha,artifactPath:join(dir,"package.tgz"),artifactHash:"0".repeat(64),scannerPath:"missing",scannerHash:"0".repeat(64),scannerVersion:"8.30.1",stateDirectory:dir})).rejects.toThrow("artifact-hash-mismatch");}finally{await rm(dir,{recursive:true,force:true});}});
test("stale base invalidates review and advances bounded review generation",()=>{const state={...initialState(eligible,100),stage:"verifying" as const,workingHeadSha:sha,reviewedHeadSha:sha,reviewerDispatchId:"old-review",effects:[{key:"reviewer",intent:{headSha:sha},receipt:{dispatchId:"old-review"}},{key:"review-verdict",intent:{headSha:sha},receipt:{verdict:"approved"}}]};const next=rebaseReviewState(state,"c".repeat(40),1000);expect(next.stage).toBe("pushed");expect(next.pr.baseSha).toBe("c".repeat(40));expect(next.reviewedHeadSha).toBeUndefined();expect(next.reviewerDispatchId).toBeUndefined();expect(next.attempt).toBe(2);expect(next.effects.find(e=>e.key==="reviewer")).toBeUndefined();expect(next.effects.find(e=>e.key==="base-conflict:1")?.receipt?.oldBaseSha).toBe(base);});

test("real host lock closure accepts native and transitive rows only against trusted resolution", async () => {
  const actual = await readFile("bun.lock", "utf8");
  const after = Bun.JSON5.parse(actual) as { packages: Record<string, [string,string,Record<string,unknown>,string]>; workspaces: Record<string,{devDependencies:Record<string,string>}> };
  const before = structuredClone(after);
  // Derive the direct host pin from the committed lockfile so the closure proof follows each version bump.
  const candidate = after.workspaces[""]!.devDependencies["@oh-my-pi/pi-coding-agent"]!;
  const previous = ["18.6.1", "18.8.0", "18.8.4"].filter(version => version !== candidate).at(-1)!;
  for (const [name, row] of Object.entries(before.packages)) {
    if (name.startsWith("@oh-my-pi/")) row[0] = String(row[0]).replace(`@${candidate}`, `@${previous}`);
  }
  for (const name of ["pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"]) before.workspaces[""]!.devDependencies[`@oh-my-pi/${name}`] = previous;
  expect(verifyLockChange(JSON.stringify(before), actual, sha, candidate, actual).refusal).toBeUndefined();
  const evil = structuredClone(after);
  evil.packages.typescript![0] = "typescript@999.0.0";
  expect(verifyLockChange(JSON.stringify(before), JSON.stringify(evil), sha, candidate, actual).refusal).toBe("lockfile-unexpected-package-change");
  const lifecycle = structuredClone(after);
  lifecycle.packages["@oh-my-pi/pi-ai"]![2].scripts = { postinstall: "evil" };
  expect(verifyLockChange(JSON.stringify(before), JSON.stringify(lifecycle), sha, candidate, actual).refusal).toBe("lockfile-host-metadata-change");
});

test("captured CLI worker-start ready receipt preserves actual child identity", async () => {
  // Exact recorded CLI envelope from .tools/orca-worker-start-core-design.json; local path redacted.
  const captured={result:{runId:"run_389309e7a8a5",taskId:"task_2a3b5f1ddc04",dispatchId:"ctx_7ee49d87af41",state:"ready",stage:"input_accepted",effects:[{kind:"worktree",action:"reused",id:"recorded-repo::recorded-workspace"},{kind:"terminal",role:"agent",action:"created",id:"term_5516824d-8975-4ad5-989f-c2bb1002ca50"},{kind:"dispatch_input",role:"agent",id:"term_5516824d-8975-4ad5-989f-c2bb1002ca50",state:"accepted"}],residualResources:[]}};
  class RecordedOrca extends Orca {
    override async invoke() { return captured.result; }
  }
  const adapter = new RecordedOrca(policy);
  const dir=await mkdtemp(join(tmpdir(),"recorded-launch-"));
  try {
    const store=new StateStore(dir),state=initialState(eligible,Date.now()+10000),lock=await store.acquire(state.key);await store.save(state,-1,lock);
    let launches=0;
    const apply=async()=>{launches++;return adapter.start(eligible,captured.result.runId,"executor",sha);};
    const owned=await store.effect(state,lock,"executor",{headSha:sha},async()=>({kind:"absent"}),apply);
    await store.effect(owned,lock,"executor",{headSha:sha},async()=>({kind:"found",receipt:owned.effects.find(e=>e.key==="executor")!.receipt!}),apply);
    expect(launches).toBe(1);
    expect((await store.load(state.key))?.effects.find(e=>e.key==="executor")?.receipt?.validationFailed).toBeUndefined();
    await store.release(lock);
  } finally {await rm(dir,{recursive:true,force:true});}
  const partial = structuredClone(captured.result);
  partial.state = "failed";
  class PartialOrca extends Orca { override async invoke() { return partial; } }
  try { await new PartialOrca(policy).start(eligible, partial.runId, "executor", sha); throw new Error("expected refusal"); }
  catch(error) { expect(error).toMatchObject({message:"worker-receipt-unverifiable",receipt:{dispatchId:partial.dispatchId,taskId:partial.taskId,residualResources:partial.residualResources}}); }
});

test("partial child launch refusal persists ids and residual resources before rethrow", async () => {
  const dir=await mkdtemp(join(tmpdir(),"controller-partial-"));
  try {
    const store=new StateStore(dir),state=initialState(eligible,Date.now()+10000),lock=await store.acquire(state.key);
    await store.save(state,-1,lock);
    const child={taskId:"task_child",dispatchId:"ctx_child",residualResources:[{kind:"terminal",id:"term_child"}]};
    await expect(store.effect(state,lock,"executor",{headSha:sha},async()=>({kind:"absent"}),async()=>{throw Object.assign(new Error("worker-receipt-unverifiable"),{receipt:child});})).rejects.toThrow("worker-receipt-unverifiable");
    expect((await store.load(state.key))?.effects.find(e=>e.key==="executor")?.receipt).toEqual({...child,validationFailed:true});
    await store.release(lock);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("recorded inbox batch replies and settles before ack with durable replay", async () => {
  // Exact recorded consuming-check message schema and payload strings; unrelated prose omitted.
  const messages=[{id:"msg_9b43078ee928",type:"worker_done",payload:'{"taskId":"task_45fe8fcd9a8b","dispatchId":"ctx_f2e9e015a2b8","outcome":"succeeded"}',body:"recorded completion"},{id:"msg_3a1b68f37f2b",type:"question",payload:'{"taskId":"task_9ccfd6f0de45","dispatchId":"ctx_ade4a1a711d5","question":"confirm named profile scope","options":["exact-named-profile-plus-startupOnly","full-plugin-fixtures-and-same-scope"]}',body:"recorded question"}];
  const dir=await mkdtemp(join(tmpdir(),"controller-delivery-"));
  try {
    const store=new StateStore(dir),initial=initialState(eligible,Date.now()+10000),lock=await store.acquire(initial.key);
    await store.save(initial,-1,lock);
    const calls:string[]=[];
    class InboxOrca extends Orca {
      override async invoke(args:readonly string[]) {
        if(args[1]==="reply"){calls.push(`reply:${args[3]}`);return {replied:true};}
        if(args[1]==="worker-show") {const id=args[3]!;const payload=JSON.parse(messages.find(m=>m.type==="worker_done")!.payload) as {taskId:string;outcome:string};return {dispatch:{id,taskId:payload.taskId,completedAt:"recorded",status:"succeeded"},projection:{outcome:payload.outcome},terminalResource:{ownerDispatchId:id,ownershipState:"owned"}};}
        if(args[1]==="worker-release"){calls.push(`release:${args[3]}`);return {released:true};}
        if(args[1]==="check"){calls.push(`ack:${args[3]}`);return {acknowledged:args[3]};}
        throw new Error("unexpected operation");
      }
    }
    const batch={runId:"recorded-run",deliveryId:"recorded-delivery",messages};
    const expected=messages.map(m=>JSON.parse(m.payload) as {taskId:string;dispatchId:string});
    const adapter=new InboxOrca(policy);
    const updated=await adapter.processDelivery(store,lock,initial,batch,expected,async()=>"remain read-only; no active-profile changes");
    expect(calls.at(-1)).toBe("ack:recorded-delivery");
    expect(calls.filter(c=>c.startsWith("reply:"))).toHaveLength(messages.filter(m=>m.type==="question").length);
    expect(calls.filter(c=>c.startsWith("release:"))).toHaveLength(1);
    await adapter.processDelivery(store,lock,updated,batch,expected,async()=>"remain read-only; no active-profile changes");
    expect(calls.filter(c=>c.startsWith("reply:"))).toHaveLength(messages.filter(m=>m.type==="question").length);
    expect(calls.filter(c=>c.startsWith("release:"))).toHaveLength(1);
    await expect(adapter.processDelivery(store,lock,updated,{...batch,deliveryId:"stale",messages:[{...messages.find(m=>m.type==="worker_done")!,id:"new-stale-settlement"}]},[],async()=>undefined)).rejects.toThrow("inbox-stale-settlement");
    expect(calls).not.toContain("ack:stale");
    await expect(adapter.processDelivery(store,lock,updated,{...batch,deliveryId:"unknown",messages:[{id:"unknown",type:"future-message",payload:"{}",body:""}]},expected,async()=>undefined)).rejects.toThrow("inbox-unrecognized-message");
    expect(calls).not.toContain("ack:unknown");
    await store.release(lock);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("publication accepts verified distinct archive and content identities and rejects content mismatch", () => {
  const e=evidence();
  const binding={schemaVersion:1 as const,headSha:sha,treeHash:e.treeHash,archiveSha256:e.artifactHash,contentHash:"5".repeat(64),fileCount:25,extractionVerified:true as const};
  Object.assign(e,{binding});
  e.smoke=e.smoke.map(row=>({...row,contentHash:binding.contentHash,binding}));
  expect(mergeGate(policy,e,sha,base)).toEqual({ok:true,headSha:sha});
  e.smoke=[{...e.smoke[0]!,contentHash:"9".repeat(64)},...e.smoke.slice(1)];
  expect(mergeGate(policy,e,sha,base)).toEqual({ok:false,reason:"smoke-content-mismatch"});
});

test("binding alone cannot authorize worker supplied native evidence", () => {
  const e=evidence();
  e.smoke=e.smoke.map(({receipt,workflowRunId,runAttempt,...row})=>row);
  expect(mergeGate(policy,e,sha,base)).toEqual({ok:false,reason:"native-receipt-provenance-missing"});
});

test("incoming forbidden-source rename is rejected rather than trusted by destination",()=> {
  const observation={...pr,files:[{path:"upgrade-report.md",previousPath:"scripts/maintenance.ts",mode:"100644"}]};
  expect(precheck(policy,observation,{now:1,deadline:2})).toEqual({kind:"blocked",reason:"incoming-file-rename"});
});
test("lock root injection is refused even for unchanged package rows",async()=> {
  const old=await readFile("bun.lock","utf8");
  const parsed:unknown=Bun.JSON5.parse(old);
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("fixture lock invalid");
  const next={...parsed,trustedDependencies:["evil"]};
  expect(verifyLockChange(old,JSON.stringify(next),sha,"18.8.4",old).refusal).toBe("lockfile-format-change");
});
test("executor cannot fabricate installed support evidence",()=> {
  const previous={schemaVersion:1,versions:[{version:"18.6.1",platforms:["win32","linux","darwin"]}],installedEvidence:[],unavailableInstalledRuns:[]};
  const next={...previous,installedEvidence:[{version:"18.6.1",platform:"win32",installedPanel:true,native:true}]};
  const pkg={version:"0.2.0"};
  expect(validateMetadata(policy,pkg,pkg,previous,next,"18.8.4")).toBe("supported-evidence-modified");
});

test("resume fence recognizes exact saved push head after transition crash and rejects foreign head",()=> {
  const pushed="c".repeat(40);
  const state={...initialState(eligible,100),effects:[{key:"commit",intent:{sourceHeadSha:sha},receipt:{headSha:pushed}},{key:"push",intent:{headSha:pushed,branch:pr.branch},receipt:{headSha:pushed}}]};
  expect(resumeFence(state,pushed,1)).toBeUndefined();
  expect(resumeFence(state,"d".repeat(40),1)).toBe("stale-head");
});

test("pinned scanner rejects unsupported platforms and wrong bytes before extraction",async()=> {
  const dir=await mkdtemp(join(tmpdir(),"controller-scanner-"));
  try {
    const archive=join(dir,"gitleaks.zip");await writeFile(archive,"wrong archive bytes");
    const scanner={version:"8.30.1",platform:"win32" as const,asset:"gitleaks_8.30.1_windows_x64.zip",url:"https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_windows_x64.zip",archiveSha256:"d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",executableSha256:"17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c"};
    if(process.platform!==scanner.platform)await expect(prepareScanner(scanner,dir,archive)).rejects.toThrow("scanner-platform-unavailable");
    else await expect(prepareScanner(scanner,dir,archive)).rejects.toThrow("scanner-archive-hash-mismatch");
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("changed host lock integrity requires independent trusted resolution",()=> {
  const before={lockfileVersion:1,workspaces:{"":{devDependencies:{"@oh-my-pi/pi-utils":"18.8.0"}}},packages:{"@oh-my-pi/pi-utils":["@oh-my-pi/pi-utils@18.8.0","",{},"sha512-abc"]}};
  const after=structuredClone(before);after.packages["@oh-my-pi/pi-utils"][3]="sha512-forged";
  after.packages["@oh-my-pi/pi-utils"][0]="@oh-my-pi/pi-utils@18.8.4";
  after.workspaces[""].devDependencies["@oh-my-pi/pi-utils"]="18.8.4";
  expect(verifyLockChange(JSON.stringify(before),JSON.stringify(after),sha,"18.8.4").refusal).toBe("lockfile-trusted-resolution-missing");
});

test("publication binds source artifact separately from verified synthetic workflow commit",()=> {
  const e=evidence(),workflowHead="c".repeat(40);
  Object.assign(e,{workflowHeadSha:workflowHead});
  e.checks=e.checks.map(c=>({...c,headSha:workflowHead}));
  e.smoke=e.smoke.map(s=>({...s,checkRunHeadSha:workflowHead,receipt:{...(s.receipt as Record<string,unknown>),checkRunHeadSha:workflowHead}}));
  expect(mergeGate(policy,e,sha,base)).toEqual({ok:true,headSha:sha});
  e.checks=[{...e.checks[0]!,headSha:"d".repeat(40)},...e.checks.slice(1)];
  expect(mergeGate(policy,e,sha,base)).toEqual({ok:false,reason:"check-incomplete"});
});

test("release pair authority rejects arbitrary executor pair and derives finite supported union",()=> {
  expect(()=>validateReleasePairs([{hostVersion:"99.0.0",platform:"other"}],["18.8.4"])).toThrow("release-supported-pairs-invalid");
  const expected=(["win32","linux","darwin"] as const).map(platform=>({hostVersion:"18.8.4",platform}));
  expect(validateReleasePairs(expected,["18.8.4"])).toEqual(expected);
});

test("final executor precommit validates the exact candidate registry alias and refuses unrelated lock mutations", async () => {
  const dir=await mkdtemp(join(tmpdir(),"controller-final-lock-"));
  const candidate="18.9.0",host="@oh-my-pi/pi-utils",candidateAlias="omp-host-1890",candidateSpec="npm:@oh-my-pi/pi-coding-agent@18.9.0",oldAlias="omp-host-1884";
  const beforeSupport={schemaVersion:1,versions:[{version:"18.8.4",package:oldAlias,platforms:["win32","darwin","linux"]}]};
  const afterSupport={...beforeSupport,versions:[...beforeSupport.versions,{version:candidate,package:candidateAlias,platforms:["win32","darwin","linux"]}]};
  const beforePackage={version:"0.2.0",devDependencies:{[host]:"18.8.4",[oldAlias]:"npm:@oh-my-pi/pi-coding-agent@18.8.4"},peerDependencies:{[host]:"18.8.4"}};
  const afterPackage={version:"0.2.1",devDependencies:{[host]:candidate,[oldAlias]:"npm:@oh-my-pi/pi-coding-agent@18.8.4",[candidateAlias]:candidateSpec},peerDependencies:{[host]:"18.8.4 || 18.9.0"}};
  const oldLock={lockfileVersion:1,workspaces:{"":{"devDependencies":beforePackage.devDependencies,"peerDependencies":beforePackage.peerDependencies}},packages:{[host]:[`${host}@18.8.4`,"",{},"sha512-old"],[oldAlias]:["@oh-my-pi/pi-coding-agent@18.8.4","",{},"sha512-old-alias"],typescript:["typescript@5.0.0","",{},"sha512-def"]}};
  const finalLock={...oldLock,workspaces:{"":{"devDependencies":afterPackage.devDependencies,"peerDependencies":afterPackage.peerDependencies}},packages:{...oldLock.packages,[host]:[`${host}@${candidate}`,"",{},"sha512-new"],[candidateAlias]:[`@oh-my-pi/pi-coding-agent@${candidate}`,"",{},"sha512-newAlias"]}};
  const report={packageVersion:"0.2.1",artifactHash:"1".repeat(64),supportedPairs:["18.8.4",candidate].flatMap(hostVersion=>(["win32","darwin","linux"] as const).map(platform=>({hostVersion,platform})))};
  const commandSpy=spyOn(maintenanceGithub,"command").mockImplementation(async(executable,args)=>{
    if(executable!=="git")throw new Error("unexpected external command");
    const value=args[0]==="diff"?(args[1]==="--name-only"?"package.json\nbun.lock\nbaseline/supported-hosts.json":""):args[0]==="ls-files"?"":args[0]==="show"?args[1]===`${base}:package.json`?JSON.stringify(beforePackage):args[1]===`${base}:baseline/supported-hosts.json`?JSON.stringify(beforeSupport):args[1]===`${base}:bun.lock`?JSON.stringify(oldLock):undefined:undefined;
    if(value===undefined)throw new Error("unexpected git command");return {code:0,stdout:value,stderr:""};
  });
  const resolverSpy=spyOn(maintenanceGithub,"resolveHostLock").mockResolvedValue(JSON.stringify(finalLock));
  const remoteSpy=spyOn(maintenanceGithub.GitHub.prototype,"observePr").mockResolvedValue({...pr,hostPins:[candidate]});
  const orcaSpy=spyOn(Orca.prototype,"invoke").mockImplementation(async(args)=>{
    if(args[1]==="worker-show")return {dispatch:{id:"executor",taskId:"executor-task",completedAt:"recorded"},projection:{outcome:"succeeded"},worker:{worktreeId:`fixture::${dir}`}};
    if(args[1]==="worker-read")return {};throw new Error("unexpected Orca operation");
  });
  class PrecommitStore extends StateStore {
    override async effect(...args:Parameters<StateStore["effect"]>) { if(args[2]==="commit")throw new Error("precommit-validation-complete");return super.effect(...args); }
  }
  try {
    await writeFile(join(dir,"package.json"),JSON.stringify(afterPackage));await Bun.write(join(dir,"baseline/supported-hosts.json"),JSON.stringify(afterSupport));await writeFile(join(dir,".maintenance-executor.json"),JSON.stringify(report));
    const attacks:[string,unknown][]=[
      ["lockfile-unexpected-package-change",{...finalLock,packages:{...finalLock.packages,typescript:["typescript@999.0.0","",{},"sha512-def"]}}],
      ["lockfile-format-change",{...finalLock,trustedDependencies:["evil"]}],
      ["lockfile-workspace-change",{...finalLock,workspaces:{...finalLock.workspaces,unrelated:{name:"evil"}}}],
      ["lockfile-host-metadata-change",{...finalLock,packages:{...finalLock.packages,[host]:[`${host}@${candidate}`,"",{},"sha512-forged"]}}],
      ["lockfile-workspace-change",{...finalLock,workspaces:{"":{...finalLock.workspaces[""],peerDependencies:{[host]:"18.6.1 || 99.0.0 || 18.9.0"}}}}],
    ];
    for(const [index,[expected,bytes]] of [["precommit-validation-complete",finalLock] as [string,unknown],...attacks].entries()) {
      await writeFile(join(dir,"bun.lock"),JSON.stringify(bytes));
      const store=new PrecommitStore(join(dir,`state-${index}`)),state={...initialState({...eligible,candidateVersion:candidate},Date.now()+10000),stage:"working" as const,executorDispatchId:"executor"};
      const lock=await store.acquire(state.key);await store.save(state,-1,lock);
      await expect(advanceController(policy,store,lock,state,[])).rejects.toThrow(expected);
      expect((await store.load(state.key))!.effects.some(e=>e.key==="commit"||e.key==="push")).toBe(false);await store.release(lock);
    }
  } finally {commandSpy.mockRestore();resolverSpy.mockRestore();remoteSpy.mockRestore();orcaSpy.mockRestore();await rm(dir,{recursive:true,force:true});}
});

test("verifying resume regenerates independent review before reading advanced-base synthetic evidence", async () => {
  const dir=await mkdtemp(join(tmpdir(),"controller-base-resume-")),newBase="c".repeat(40),workflowHead="d".repeat(40),foreignHead="e".repeat(40);
  let remoteHead=sha,remoteBase=newBase,released=false,newReviewerBase:string|undefined;
  const reads:string[]=[],mutations:string[]=[];
  const observation=spyOn(maintenanceGithub.GitHub.prototype,"observePr").mockImplementation(async()=>({...pr,headSha:remoteHead,baseSha:remoteBase}));
  const api=spyOn(maintenanceGithub.GitHub.prototype,"api").mockImplementation(async(path)=>{
    reads.push(path);
    if(path.endsWith("/pulls/4"))return {merge_commit_sha:workflowHead};
    if(path.endsWith(`/git/commits/${workflowHead}`))return {parents:[{sha:newBase},{sha}]};
    throw new Error("stale-workflow-evidence-consumed");
  });
  const orca=spyOn(Orca.prototype,"invoke").mockImplementation(async(args)=>{
    if(args[1]==="check")return {runId:"review-run",deliveryId:null,messages:[]};
    if(args[1]==="worker-show") { const old=args[3]==="old-review";return {dispatch:{id:args[3],taskId:old?"old-task":"new-task",completedAt:old?"recorded":undefined},projection:{outcome:old?"succeeded":"running"},terminalResource:{ownerDispatchId:args[3],ownershipState:old&&released?"released":"owned",releaseState:old&&released?"completed":"pending"}}; }
    if(args[1]==="worker-release") {released=true;mutations.push(`release:${args[3]}`);return {released:true};}
    if(args[1]==="worker-start") {
      newReviewerBase=args[3]!.includes(`base ${newBase}`)?newBase:undefined;mutations.push("new-independent-review");
      return {runId:"review-run",taskId:"new-task",dispatchId:"new-review",state:"ready",stage:"input_accepted",effects:[{kind:"worktree",id:`fixture::${dir}`}],residualResources:[]};
    }
    throw new Error("unexpected Orca operation");
  });
  try {
    const store=new StateStore(dir),initial={...initialState(eligible,Date.now()+10000),stage:"verifying" as const,runId:"review-run",workingHeadSha:sha,reviewedHeadSha:sha,reviewerDispatchId:"old-review",effects:[{key:"reviewer",intent:{headSha:sha,runId:"review-run"},receipt:{taskId:"old-task",dispatchId:"old-review"}},{key:"review-verdict",intent:{headSha:sha},receipt:{report:{headSha:sha,baseSha:base,verdict:"approved",evidenceHashes:["1".repeat(64)]}}}]};
    const lock=await store.acquire(initial.key);await store.save(initial,-1,lock);
    const rebased=await advanceController(policy,store,lock,(await store.load(initial.key))!,[]);
    expect(rebased.stage).toBe("pushed");expect(rebased.pr.baseSha).toBe(newBase);expect(rebased.attempt).toBe(2);
    expect(rebased.reviewedHeadSha).toBeUndefined();expect(rebased.reviewerDispatchId).toBeUndefined();
    expect(rebased.effects.find(e=>e.key==="review-verdict")).toBeUndefined();expect(rebased.effects.find(e=>e.key==="review-verdict:attempt-1")?.receipt?.report).toMatchObject({baseSha:base});
    expect(rebased.effects.find(e=>e.key==="worker-release:old-review")?.receipt).toEqual({dispatchId:"old-review",released:true});
    expect(reads).toEqual([]);
    const reviewing=await advanceController(policy,store,lock,(await store.load(initial.key))!,[]);
    expect(reviewing.stage).toBe("reviewing");expect(reviewing.reviewerDispatchId).toBe("new-review");expect(newReviewerBase).toBe(newBase);
    expect(mutations).toEqual(["release:old-review","new-independent-review"]);expect(reads).toEqual([]);
    // Foreign source takes precedence over base recovery and never consumes checks.
    remoteHead=foreignHead;remoteBase="f".repeat(40);
    const verifying={...reviewing,revision:reviewing.revision+1,stage:"verifying" as const,reviewedHeadSha:sha,reviewerDispatchId:undefined};await store.save(verifying,reviewing.revision,lock);
    await expect(advanceController(policy,store,lock,verifying,[])).rejects.toThrow("stale-head");expect((await store.load(initial.key))!.pr.baseSha).toBe(newBase);expect(reads).toEqual([]);
    // Current base still requires parents exactly [selected base, reviewed source].
    remoteHead=sha;remoteBase=newBase;
    api.mockImplementation(async(path)=>{reads.push(path);if(path.endsWith("/pulls/4"))return {merge_commit_sha:workflowHead};if(path.endsWith(`/git/commits/${workflowHead}`))return {parents:[{sha},{sha:newBase}]};throw new Error("stale-workflow-evidence-consumed");});
    await expect(advanceController(policy,store,lock,verifying,[])).rejects.toThrow("workflow-source-parent-mismatch");expect(reads.some(path=>path.includes("check-runs"))).toBe(false);
    await store.release(lock);
  } finally {observation.mockRestore();api.mockRestore();orca.mockRestore();await rm(dir,{recursive:true,force:true});}
});

test("preserved canonical base aliases seed their subtrees while non-canonical aliases cannot", () => {
  const candidate="18.8.6",base="18.8.4",nested="@oh-my-pi/pi-utils";
  const alias=(version:string)=>`omp-host-${version.replaceAll(".","")}`;
  const row=(spec:string,deps:Record<string,string>,integrity:string)=>[spec,"",{dependencies:deps},integrity];
  const root=(direct:string,extra:Record<string,string>)=>({devDependencies:{"@oh-my-pi/pi-coding-agent":direct,[alias("18.6.1")]:"npm:@oh-my-pi/pi-coding-agent@18.6.1",[alias("18.8.0")]:"npm:@oh-my-pi/pi-coding-agent@18.8.0",[alias(base)]:`npm:@oh-my-pi/pi-coding-agent@${base}`,...extra},peerDependencies:{"@oh-my-pi/pi-coding-agent":"18.6.1 || 18.8.0 || 18.8.4"}});
  const before={lockfileVersion:1,workspaces:{"":root(base,{})},packages:{"@oh-my-pi/pi-coding-agent":row(`@oh-my-pi/pi-coding-agent@${base}`,{},"sha512-AAAA"),[alias(base)]:row(`@oh-my-pi/pi-coding-agent@${base}`,{[nested]:base},"sha512-BBBB"),[`${alias(base)}/${nested}`]:row(`${nested}@${base}`,{},"sha512-CCCC")}};
  const after=structuredClone(before);
  after.workspaces[""].devDependencies["@oh-my-pi/pi-coding-agent"]=candidate;
  after.workspaces[""].devDependencies[alias(candidate)]=`npm:@oh-my-pi/pi-coding-agent@${candidate}`;
  after.packages["@oh-my-pi/pi-coding-agent"][0]=`@oh-my-pi/pi-coding-agent@${candidate}`;
  after.packages[alias(candidate)]=row(`@oh-my-pi/pi-coding-agent@${candidate}`,{},"sha512-DDDD");
  after.packages[`${alias(base)}/${nested}`]=row(`${nested}@18.8.5`,{},"sha512-EEEE");
  expect(verifyLockChange(JSON.stringify(before),JSON.stringify(after),sha,candidate,JSON.stringify(after)).refusal).toBeUndefined();
  const forgedAliases:readonly [string,string][]=[["omp-host-legacy",`npm:@oh-my-pi/pi-coding-agent@${base}`],["omp-host-1887",`npm:@oh-my-pi/pi-coding-agent@${base}`]];
  for(const [name,spec] of forgedAliases){
    const forgedBefore=structuredClone(before),forged=structuredClone(after);
    for(const lock of [forgedBefore,forged]){
      lock.workspaces[""].devDependencies[name]=spec;
      lock.packages[name]=row(`@oh-my-pi/pi-coding-agent@${base}`,{[nested]:base},`sha512-FFFF`);
      lock.packages[`${name}/${nested}`]=row(`${nested}@${lock===forged?"18.8.5":base}`,{},"sha512-GGGG");
    }
    expect(verifyLockChange(JSON.stringify(forgedBefore),JSON.stringify(forged),sha,candidate,JSON.stringify(forged)).refusal).toBe("lockfile-unexpected-package-change");
  }
});
test("policy digest is deterministic and bound to the accepted policy, selector and registration checkout", async () => {
  const selector=`github:${policy.repository}`,checkout=process.cwd();
  const accepted=JSON.parse((await command("git",["show","origin/main:maintenance.config.json"],5000)).stdout) as MaintenancePolicy;
  const precheck=hostPrecheck(join(checkout,"scripts","maintenance.ts"));
  const digest=policyDigest(accepted,selector,precheck);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(policyDigest({...accepted,baseBranch:"release"},selector,precheck)).not.toBe(digest);
  expect(policyDigest(accepted,`github:${accepted.repository}-fork`,precheck)).not.toBe(digest);
  expect(policyDigest(accepted,selector,hostPrecheck(join(tmpdir(),"other-checkout","scripts","maintenance.ts")))).not.toBe(digest);
  const child=Bun.spawn(["bun","scripts/maintenance.ts","--policy-digest","--repo",selector,"--checkout",checkout],{stdout:"pipe",stderr:"pipe"});
  const output=await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toBe(`${digest}\n`);
  const otherCheckout=join(tmpdir(),"omp-settings-ru-registration");
  const otherChild=Bun.spawn(["bun","scripts/maintenance.ts","--policy-digest","--repo",selector,"--checkout",otherCheckout],{stdout:"pipe",stderr:"pipe"});
  const otherOutput=await new Response(otherChild.stdout).text();
  expect(await otherChild.exited).toBe(0);
  expect(otherOutput).toBe(`${policyDigest(accepted,selector,hostPrecheck(join(otherCheckout,"scripts","maintenance.ts")))}\n`);
  expect(otherOutput).not.toBe(output);
  const rejected=Bun.spawn(["bun","scripts/maintenance.ts","--policy-digest","--repo",selector,"--checkout","relative/checkout"],{stdout:"pipe",stderr:"pipe"});
  const rejectedOutput=await new Response(rejected.stdout).text();
  expect(await rejected.exited).not.toBe(0);
  expect(JSON.parse(rejectedOutput)).toMatchObject({kind:"blocked",reason:"policy-digest-input-invalid"});
});
test("maintenance prompt refuses an unsafe selector, unsafe path and non-absolute checkout", () => {
  const selector=`github:${policy.repository}`,checkout=process.cwd();
  const digest=policyDigest(policy,selector,hostPrecheck(join(checkout,"scripts","maintenance.ts")));
  expect(()=>maintenancePrompt(digest,"evil;rm -rf /",checkout)).toThrow("automation-selector-unsafe");
  expect(()=>maintenancePrompt(digest,selector,`${tmpdir()}\\unsafe"path`)).toThrow("automation-path-unsafe");
  expect(()=>maintenancePrompt(digest,selector,"relative-checkout")).toThrow("automation-checkout-not-absolute");
});


import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { command, GitHub, precheck, botIdentity, sanitizeCause, mergeGate, manifestChecks, validateMetadata, verifyProvenance, prepareScanner, verifyLockChange, resolveHostLock, validateReleasePairs } from "./maintenance/github";
import type { Precheck, PrObservation, PublicationEvidence } from "./maintenance/github";
import { StateStore, initialState, resumeFence, rebaseReviewState } from "./maintenance/state";
import { Orca } from "./maintenance/orca";
import { hostPrecheck, policyDigest } from "./maintenance/automation";
import { runUpdate, prepareActivation, hasCompletedActivation, type UpdateOptions } from "./maintenance/updater";
import type { MaintenancePolicy, MaintenanceState, LockRecord, ReleasePin, MaintenanceStage } from "./maintenance/contracts";
export async function loadAcceptedPolicy():Promise<MaintenancePolicy>{
  const pinned=await command("git",["rev-parse","--verify","origin/main^{commit}"],5000);const sha=pinned.stdout.trim();if(pinned.code!==0||!/^[a-f0-9]{40}$/.test(sha))throw Object.assign(new Error("accepted-base-unavailable"),{cause:pinned.stderr});
  const result=await command("git",["show",`${sha}:maintenance.config.json`],5000);if(result.code!==0)throw Object.assign(new Error("policy-unavailable"),{cause:result.stderr});
  const policy:MaintenancePolicy=JSON.parse(result.stdout);if(policy.schemaVersion!==1||!policy.repository||policy.botType!=="Bot"||!policy.deadlinesMs?.precheck||policy.deadlinesMs.precheck>30000)throw new Error("policy-invalid");return policy;
}
function exitCode(result:Precheck):number{if(result.kind==="eligible")return 0;if(result.kind==="skip")return 10;if(result.reason.includes("deadline")||result.reason.includes("unavailable"))return 12;if(result.reason.includes("lock")||result.reason.includes("authority"))return 13;return 11;}
async function git(args:readonly string[],cwd:string,timeout:number):Promise<string>{const result=await command("git",args,timeout,cwd);if(result.code!==0)throw Object.assign(new Error("git-effect-refused"),{cause:result.stderr});return result.stdout.trim();}
interface ExecutorReport{packageVersion:string;artifactHash:string;supportedPairs:ReleasePin["supportedPairs"]}
interface ReviewerReport{headSha:string;baseSha:string;verdict:string;evidenceHashes:string[];smoke:PublicationEvidence["smoke"];privacy:PublicationEvidence["privacy"]}
async function worktreePath(orca:Orca,dispatchId:string):Promise<string>{const r=await orca.observe(dispatchId);const id=r.worker?.worktreeId;if(typeof id!=="string"||!id.includes("::"))throw new Error("worker-worktree-unverified");const folder=id.slice(id.indexOf("::")+2);if(await realpath(folder)===await realpath(process.cwd()))throw new Error("human-root-forbidden");return folder;}
export async function runControllerUpdate(options: UpdateOptions) {
  if (options.activate && options.accepted && !await hasCompletedActivation(options)) await prepareActivation(options);
  return runUpdate(options);
}
export async function advanceController(policy:MaintenancePolicy,store:StateStore,lock:LockRecord,initial:MaintenanceState,args:readonly string[]):Promise<MaintenanceState>{
  let state=initial;const github=new GitHub(policy),orca=new Orca(policy),root=`repos/${policy.repository}`;
  if(state.runId) {
    const inbox=await orca.inbox();
    if(inbox.runId!==state.runId)throw new Error("inbox-run-mismatch");
    const expected=state.effects.filter(e=>["executor","reviewer"].includes(e.key)&&e.receipt).map(e=>({taskId:String(e.receipt!.taskId),dispatchId:String(e.receipt!.dispatchId)}));
    state=await orca.processDelivery(store,lock,state,inbox,expected,async()=>"Stay within your trusted dispatched scope; do not publish or mutate any active profile. If the requested action needs authority absent from the task, preserve work and report outcome failed with the exact prerequisite; do not invent a workaround.");
  }
  const transition=async(stage:MaintenanceStage,patch:Partial<MaintenanceState>={})=>{const duration=stage==="verifying"?policy.deadlinesMs.verification:stage==="merged"?policy.deadlinesMs.release:stage==="released"?policy.deadlinesMs.updater:policy.deadlinesMs.agent;const next={...state,...patch,stage,deadline:Date.now()+duration,revision:state.revision+1};await store.save(next,state.revision,lock);state=next;};
  const releaseSettled=async(dispatchId:string)=>{state=await store.effect(state,lock,`worker-release:${dispatchId}`,{dispatchId},async()=>{const observed=await orca.observe(dispatchId);const resource=observed.terminalResource;if(resource?.releaseState==="completed"||resource?.ownershipState==="released")return {kind:"found",receipt:{dispatchId,released:true}};if(!["succeeded","failed"].includes(observed.projection?.outcome))return {kind:"unknown"};return {kind:"absent"};},async()=>{await orca.release(dispatchId);const observed=await orca.observe(dispatchId);if(observed.terminalResource?.releaseState!=="completed"&&observed.terminalResource?.ownershipState!=="released")throw new Error("worker-release-unverified");return {dispatchId,released:true};});};
  if(Date.now()>=state.deadline)throw new Error("stage-deadline-expired");
  if(state.stage==="working") {
    const commit=state.effects.find(e=>e.key==="commit"),push=state.effects.find(e=>e.key==="push");
    const head=commit?.receipt?.headSha;
    if(typeof head==="string"&&push?.intent.headSha===head) {
      const remote=await github.observePr(state.pr.number);
      const fence=resumeFence(state,remote.headSha,Date.now());if(fence)throw new Error(fence);
      if(remote.headSha===head) {
        state=await store.effect(state,lock,"push",push.intent,async()=>({kind:"found",receipt:{headSha:head}}),async()=>{throw new Error("push-recovery-mutation-forbidden");});
        await transition("pushed",{workingHeadSha:head});
      }
    }
  }
  if(state.stage==="locked"){
    state=await store.effect(state,lock,"orca-run",{number:state.pr.number,sourceHeadSha:state.sourceHeadSha},async()=>{const record=state.effects.find(e=>e.key==="orca-run");return record?.receipt?{kind:"found",receipt:record.receipt}:record?{kind:"unknown"}:{kind:"absent"};},()=>orca.createRun(state.pr));
    const runId=String(state.effects.find(e=>e.key==="orca-run")!.receipt!.runId);
    state=await store.effect(state,lock,"executor",{runId,headSha:state.sourceHeadSha},async()=>{const record=state.effects.find(e=>e.key==="executor");return record?.receipt?{kind:"found",receipt:record.receipt}:record?{kind:"unknown"}:{kind:"absent"};},()=>orca.start(state.pr,runId,"executor",state.sourceHeadSha));
    if(state.effects.find(e=>e.key==="executor")?.receipt?.validationFailed)throw new Error("worker-launch-requires-reconciliation");
    const receipt=state.effects.find(e=>e.key==="executor")!.receipt!;await transition("working",{runId,worktreeId:String(receipt.worktreeId),executorDispatchId:String(receipt.dispatchId)});
  }
  if(state.stage==="working"){
    if(!state.executorDispatchId)throw new Error("executor-dispatch-missing");const worker=await orca.observe(state.executorDispatchId);if(worker.projection?.outcome==="failed")throw new Error("executor-failed");if(worker.projection?.outcome!=="succeeded")return state;
    const folder=await worktreePath(orca,state.executorDispatchId);await orca.invoke(["orchestration","worker-read","--dispatch",state.executorDispatchId,"--source","auto","--limit","50","--json"]);
    const report:ExecutorReport=JSON.parse(await readFile(join(folder,".maintenance-executor.json"),"utf8"));if(!/^\d+\.\d+\.\d+$/.test(report.packageVersion)||!/^[a-f0-9]{64}$/.test(report.artifactHash)||!Array.isArray(report.supportedPairs))throw new Error("executor-report-invalid");
    state=await store.effect(state,lock,"executor-settlement",{dispatchId:state.executorDispatchId},async()=>({kind:"found",receipt:{dispatchId:state.executorDispatchId,outcome:"succeeded"}}),async()=>({}));
    const remote=await github.observePr(state.pr.number);const fence=resumeFence(state,remote.headSha,Date.now());if(fence)throw new Error(fence);
    const changes=(await git(["diff","--name-only",state.sourceHeadSha],folder,policy.deadlinesMs.command)).split("\n").filter(Boolean);const untracked=(await git(["ls-files","--others","--exclude-standard"],folder,policy.deadlinesMs.command)).split("\n").filter(p=>p&&!p.startsWith(".maintenance-"));const paths=[...new Set([...changes,...untracked])];
    if(!paths.length)throw new Error("executor-no-changes");for(const path of paths){if(path.includes("\\")||path.split("/").includes("..")||!policy.executorPaths.some(p=>{const allowed=p.replaceAll("<candidate>",state.pr.candidateVersion);return allowed.endsWith("/")?path.startsWith(allowed):path===allowed;}))throw new Error("executor-path-outside-policy");}
    const modes=await git(["diff","--summary",state.sourceHeadSha],folder,policy.deadlinesMs.command);if(/mode change|120000|160000/.test(modes))throw new Error("executor-unsafe-file-mode");
    const pkg=JSON.parse(await readFile(join(folder,"package.json"),"utf8"));if(pkg.version!==report.packageVersion)throw new Error("package-version-receipt-mismatch");
    const beforePackage=JSON.parse(await git(["show",`${state.pr.baseSha}:package.json`],folder,policy.deadlinesMs.command));const beforeSupport=JSON.parse(await git(["show",`${state.pr.baseSha}:baseline/supported-hosts.json`],folder,policy.deadlinesMs.command));const afterSupport=JSON.parse(await readFile(join(folder,"baseline/supported-hosts.json"),"utf8"));const semanticRefusal=validateMetadata(policy,beforePackage,pkg,beforeSupport,afterSupport,state.pr.candidateVersion);if(semanticRefusal)throw new Error(semanticRefusal);
    const oldLock=await git(["show",`${state.pr.baseSha}:bun.lock`],folder,policy.deadlinesMs.command),finalLock=await readFile(join(folder,"bun.lock"),"utf8");
    const trustedLock=await resolveHostLock(oldLock,state.pr.candidateVersion,policy.deadlinesMs.command);
    const lockReceipt=verifyLockChange(oldLock,finalLock,state.sourceHeadSha,state.pr.candidateVersion,trustedLock,afterSupport.versions.map((v:{version:string})=>v.version));if(lockReceipt.refusal)throw new Error(lockReceipt.refusal);
    validateReleasePairs(report.supportedPairs,afterSupport.versions.map((v:{version:string})=>v.version));
    state=await store.effect(state,lock,"commit",{sourceHeadSha:state.sourceHeadSha,paths},async()=>{const head=await git(["rev-parse","HEAD"],folder,policy.deadlinesMs.command);return head!==state.sourceHeadSha?{kind:"found",receipt:{headSha:head,folder,report}}:{kind:"absent"};},async()=>{await git(["add","--",...paths],folder,policy.deadlinesMs.command);await git(["commit","-m",`Maintain OMP ${state.pr.candidateVersion}`],folder,policy.deadlinesMs.command);return {headSha:await git(["rev-parse","HEAD"],folder,policy.deadlinesMs.command),folder,report};});
    const headSha=String(state.effects.find(e=>e.key==="commit")!.receipt!.headSha);
    state=await store.effect(state,lock,"push",{headSha,branch:state.pr.branch},async()=>{const current=await github.observePr(state.pr.number);return current.headSha===headSha?{kind:"found",receipt:{headSha}}:current.headSha===state.sourceHeadSha?{kind:"absent"}:{kind:"conflict"};},async()=>{const current=await github.observePr(state.pr.number);if(current.headSha!==state.sourceHeadSha)throw new Error("remote-head-changed-before-push");await git(["push","origin",`${headSha}:refs/heads/${state.pr.branch}`],folder,policy.deadlinesMs.command);if((await github.observePr(state.pr.number)).headSha!==headSha)throw new Error("push-receipt-unverified");return {headSha};});await transition("pushed",{workingHeadSha:headSha});
    await releaseSettled(state.executorDispatchId!);
  }
  if(state.stage==="pushed"){
    if(state.executorDispatchId)await releaseSettled(state.executorDispatchId);
    if(!state.runId||!state.workingHeadSha)throw new Error("review-input-missing");state=await store.effect(state,lock,"reviewer",{headSha:state.workingHeadSha,runId:state.runId},async()=>{const r=state.effects.find(e=>e.key==="reviewer");return r?.receipt?{kind:"found",receipt:r.receipt}:r?{kind:"unknown"}:{kind:"absent"};},()=>orca.start(state.pr,state.runId!,"reviewer",state.workingHeadSha!));const receipt=state.effects.find(e=>e.key==="reviewer")!.receipt!;if(receipt.validationFailed)throw new Error("worker-launch-requires-reconciliation");await transition("reviewing",{reviewerDispatchId:String(receipt.dispatchId)});
  }
  if(state.stage==="reviewing"){
    if(!state.reviewerDispatchId)throw new Error("reviewer-dispatch-missing");const worker=await orca.observe(state.reviewerDispatchId);if(worker.projection?.outcome==="failed")throw new Error("reviewer-failed");if(worker.projection?.outcome!=="succeeded")return state;const folder=await worktreePath(orca,state.reviewerDispatchId);const report:ReviewerReport=JSON.parse(await readFile(join(folder,".maintenance-review.json"),"utf8"));if(report.headSha!==state.workingHeadSha||report.baseSha!==state.pr.baseSha||report.verdict!=="approved"||!report.evidenceHashes.length)throw new Error("independent-review-incomplete");state=await store.effect(state,lock,"review-verdict",{headSha:report.headSha},async()=>({kind:"found",receipt:{report}}),async()=>({report}));await transition("verifying",{reviewedHeadSha:report.headSha});
    await releaseSettled(state.reviewerDispatchId!);
  }
  if(state.stage==="verifying"){
    const remote=await github.observePr(state.pr.number);const fence=resumeFence(state,remote.headSha,Date.now());if(fence)throw new Error(fence);
    if(remote.baseSha!==state.pr.baseSha){if(state.reviewerDispatchId)await releaseSettled(state.reviewerDispatchId);const next=rebaseReviewState(state,remote.baseSha,Date.now()+policy.deadlinesMs.agent);await store.save(next,state.revision,lock);return next;}
    if(state.reviewerDispatchId)await releaseSettled(state.reviewerDispatchId);
    const pull=await github.api(`${root}/pulls/${state.pr.number}`);const workflowHeadSha=typeof pull.merge_commit_sha==="string"?pull.merge_commit_sha:state.reviewedHeadSha!;if(workflowHeadSha!==state.reviewedHeadSha){const merged=await github.api(`${root}/git/commits/${workflowHeadSha}`);if(merged.parents?.length!==2||merged.parents[0]?.sha!==state.pr.baseSha||merged.parents[1]?.sha!==state.reviewedHeadSha)throw new Error("workflow-source-parent-mismatch");}const checks=await github.api(`${root}/commits/${workflowHeadSha}/check-runs?per_page=100`);const commit=state.effects.find(e=>e.key==="commit")!.receipt!;const report=commit.report as unknown as ExecutorReport;const review=state.effects.find(e=>e.key==="review-verdict")!.receipt!.report as unknown as ReviewerReport;const accepted=await command("git",["show",`${state.pr.baseSha}:baseline/supported-hosts.json`],policy.deadlinesMs.command);if(accepted.code!==0)throw new Error("accepted-supported-manifest-unavailable");const manifest=JSON.parse(accepted.stdout);manifestChecks(policy,manifest,state.pr.candidateVersion);const folder=String(commit.folder);const treeHash=await git(["rev-parse",`${state.reviewedHeadSha}^{tree}`],folder,policy.deadlinesMs.command);
    if(!policy.scanner)throw new Error("scanner-policy-missing");const scanner=await prepareScanner(policy.scanner,join(store.directory,"scanner",policy.scanner.version));const artifactPath=join(folder,`omp-settings-ru-${report.packageVersion}.tgz`);const provenance=await verifyProvenance({sourceDirectory:folder,headSha:state.reviewedHeadSha!,artifactPath,artifactHash:report.artifactHash,scannerPath:scanner.executable,scannerHash:scanner.sha256,scannerVersion:scanner.version,stateDirectory:join(store.directory,"provenance",state.reviewedHeadSha!)});
    const observedChecks=checks.check_runs.map((c:{id:number;name:string;head_sha:string;status:string;conclusion:string;details_url:string})=>({id:c.id,name:c.name,headSha:c.head_sha,status:c.status,conclusion:c.conclusion,detailsUrl:c.details_url}));
    const supportedVersions=manifest.versions.map((v:{version:string})=>v.version) as string[];
    const native=await github.nativeReceipts(provenance.binding,[...new Set([...supportedVersions,state.pr.candidateVersion])],observedChecks,join(store.directory,"native-receipts",state.reviewedHeadSha!));
    const e:PublicationEvidence={headSha:state.reviewedHeadSha!,workflowHeadSha,baseSha:state.pr.baseSha,treeHash,artifactHash:report.artifactHash,binding:provenance.binding,supportedVersions,candidateVersion:state.pr.candidateVersion,review:{...review,dispatchId:state.reviewerDispatchId!,executorDispatchId:state.executorDispatchId!},checks:observedChecks,smoke:native,privacy:provenance};const gate=mergeGate(policy,e,remote.headSha,remote.baseSha);if(!gate.ok)throw new Error(gate.reason);
    state=await store.effect(state,lock,"verified-supported-pairs",{headSha:state.reviewedHeadSha},async()=>({kind:"found",receipt:{supportedPairs:native.map(s=>({hostVersion:s.version,platform:s.platform}))}}),async()=>{throw new Error("verified-pairs-unavailable");});
    state=await store.effect(state,lock,"merge",{headSha:gate.headSha},async()=>{const pr=await github.api(`${root}/pulls/${state.pr.number}`);return pr.merged&&pr.merge_commit_sha?{kind:"found",receipt:{mergeSha:pr.merge_commit_sha}}:pr.state==="open"?{kind:"absent"}:{kind:"unknown"};},()=>github.merge(state.pr.number,gate.headSha));await transition("merged",{mergeSha:String(state.effects.find(e=>e.key==="merge")!.receipt!.mergeSha)});
  }
  if(state.stage==="merged"){
    const commit=state.effects.find(e=>e.key==="commit")!.receipt!;const report=commit.report as unknown as ExecutorReport;const tag=`v${report.packageVersion}`;
    state=await store.effect(state,lock,"tag",{tag,sha:state.mergeSha},async()=>{const result=await command("gh",["api",`${root}/git/ref/tags/${tag}`],policy.deadlinesMs.command);if(result.code!==0)return result.stderr.includes("404")?{kind:"absent"}:{kind:"unknown"};const ref=JSON.parse(result.stdout);return ref.object.sha===state.mergeSha?{kind:"found",receipt:{tag,sha:state.mergeSha}}:{kind:"conflict"};},()=>github.tag(tag,state.mergeSha!));
    // Existing release workflow owns the single release and stable; controller never duplicates its release creation.
    const verifiedPairs=state.effects.find(e=>e.key==="verified-supported-pairs")?.receipt?.supportedPairs as ReleasePin["supportedPairs"]|undefined;if(!verifiedPairs)throw new Error("verified-supported-pairs-missing");const pin=await github.releasePin(tag,state.mergeSha!,report.packageVersion,verifiedPairs);if(!pin)return state;const releaseDirectory=join(store.directory,"releases",pin.tag);await mkdir(releaseDirectory,{recursive:true});await writeFile(join(releaseDirectory,"release-pin.json"),JSON.stringify(pin),{flag:"wx"}).catch(error=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});
    state=await store.effect(state,lock,"release",{tag,sha:state.mergeSha},async()=>({kind:"found",receipt:{pin}}),async()=>({pin}));await transition("released");
  }
  if(["released","safe-pending","waiting-session","verified","staged"].includes(state.stage)){
    const pin=state.effects.find(e=>e.key==="release")!.receipt!.pin as unknown as ReleasePin;const releaseDirectory=join(store.directory,"releases",pin.tag);const packagePath=join(releaseDirectory,`omp-settings-ru-${pin.packageVersion}.tgz`);if(!await Bun.file(packagePath).exists()){const download=await command("gh",["release","download",pin.tag,"--repo",policy.repository,"--pattern",`omp-settings-ru-${pin.packageVersion}.tgz`,"--dir",releaseDirectory],policy.deadlinesMs.command);if(download.code!==0)throw Object.assign(new Error("release-download-refused"),{cause:download.stderr});}
    const activation=policy.activation;if(!activation||typeof activation.accepted!=="boolean"||typeof activation.activate!=="boolean")throw new Error("activation-policy-missing");const receipt=await runControllerUpdate({pin,packagePath,stateDirectory:releaseDirectory,executable:"omp",activate:activation.activate,accepted:activation.accepted,targetProfile:activation.targetProfile});const stage:MaintenanceStage=receipt.phase==="activated"&&receipt.smokePassed?"done":receipt.phase==="safe-pending"?"safe-pending":receipt.phase==="deferred"?"waiting-session":receipt.phase;await transition(stage,{refusal:receipt.refusal});
  }
  return state;
}
async function pendingState(store:StateStore,number?:number):Promise<MaintenanceState|undefined>{return number?store.findPr(number):store.findAnyPending();}
export async function cli(args:readonly string[]):Promise<number>{
  const subcommand=args[0]??"status";if(!["--precheck","run","resume","status","--policy-digest"].includes(subcommand)){console.log(JSON.stringify({kind:"blocked",reason:"unknown-subcommand"}));return 11;}
  if(subcommand==="--policy-digest"){
    const repoIndex=args.indexOf("--repo"),checkoutIndex=args.indexOf("--checkout");
    const selector=repoIndex>=0?args[repoIndex+1]:undefined,checkout=checkoutIndex>=0?args[checkoutIndex+1]:undefined;
    if(!selector||!checkout||!isAbsolute(checkout)){console.log(JSON.stringify({kind:"blocked",reason:"policy-digest-input-invalid"}));return 13;}
    try{
      const accepted=await loadAcceptedPolicy();
      if(selector!==accepted.repository&&selector!==`github:${accepted.repository}`){console.log(JSON.stringify({kind:"blocked",reason:"policy-selector-mismatch"}));return 13;}
      console.log(policyDigest(accepted,selector,hostPrecheck(resolve(checkout,"scripts","maintenance.ts"))));
      return 0;
    }catch(error){const reason=error instanceof Error&&/^[a-z0-9-]+$/.test(error.message)?error.message:"policy-digest-unverifiable";console.log(JSON.stringify({kind:"blocked",reason}));return 13;}
  }
  const fixture=args.includes("--fixture-stdin");if(fixture&&subcommand!=="--precheck"){console.log(JSON.stringify({kind:"blocked",reason:"fixture-cannot-launch"}));return 13;}
  const deadline=Date.now()+30000;let timer:NodeJS.Timeout|undefined;if(subcommand==="--precheck")timer=setTimeout(()=>{console.log(JSON.stringify({kind:"blocked",reason:"deadline-expired"}));process.exit(12);},30000);let lock:LockRecord|undefined;let store:StateStore|undefined;
  try{
    let policy:MaintenancePolicy,observation:PrObservation|undefined;if(fixture){const input=JSON.parse(await Bun.stdin.text());policy=input.policy;observation=input.pr;}else policy=await loadAcceptedPolicy();const index=args.indexOf("--state-dir");const directory=index>=0?args[index+1]:join(homedir(),".local","state","omp-settings-ru-maintenance");if(!directory)throw new Error("state-directory-missing");store=new StateStore(directory);
    const requested=args.indexOf("--pr"),number=requested>=0?Number(args[requested+1]):undefined;const existing=await pendingState(store,number);
    if(subcommand==="status"){console.log(JSON.stringify(existing?{kind:existing.stage==="done"?"done":"pending",stage:existing.stage,key:existing.key,refusal:existing.refusal}:{kind:(await store.lock())?"blocked":"idle"}));return existing?.stage==="done"?0:10;}
    if(await store.lock())throw new Error("repo-locked-owner-liveness-unknown");
    if(existing&&subcommand==="--precheck"){
      if(Date.now()>=existing.deadline)throw new Error("stage-deadline-expired");
      const dispatchId=existing.stage==="working"?existing.executorDispatchId:existing.stage==="reviewing"?existing.reviewerDispatchId:undefined;
      if(dispatchId){const worker=await new Orca(policy).observe(dispatchId);if(worker.projection?.outcome!=="succeeded"&&worker.projection?.outcome!=="failed"){console.log(JSON.stringify({kind:"skip",reason:"worker-active-or-unverifiable",key:existing.key}));return 10;}}
      console.log(JSON.stringify({kind:"eligible",reason:"pending-owned-stage",stage:existing.stage,number:existing.pr.number,headSha:existing.workingHeadSha??existing.sourceHeadSha}));return 0;
    }
    if(existing&&subcommand!=="--precheck"){lock=await store.acquire(existing.key);const state=await advanceController(policy,store,lock,existing,args);console.log(JSON.stringify({kind:state.stage==="done"?"done":"pending",stage:state.stage,key:state.key,reason:state.refusal}));return state.stage==="done"?0:10;}
    if(!fixture){const github=new GitHub(policy);if(number)observation=await github.observePr(number);else{const prs=await github.api(`repos/${policy.repository}/pulls?state=open&per_page=100`);const candidate=prs.find((pr:{user:{login:string;type:string}})=>botIdentity(pr.user,policy.botLogin).login===policy.botLogin&&pr.user.type===policy.botType);if(candidate)observation=await github.observePr(candidate.number);}}
    const result=precheck(policy,observation,{now:Date.now(),deadline});if(result.kind!=="eligible"){console.log(JSON.stringify({...result,unblock:result.reason.startsWith("lockfile-")?"Exact-head lock receipt must contain only approved host dependency changes":undefined}));return exitCode(result);}
    if(subcommand==="--precheck"){console.log(JSON.stringify({kind:"eligible",number:result.pr.number,headSha:result.pr.sourceHeadSha}));return 0;}
    let state=initialState(result.pr,Date.now()+policy.deadlinesMs.agent);lock=await store.acquire(state.key);const fresh=await new GitHub(policy).observePr(result.pr.number);const decision=precheck(policy,fresh,{now:Date.now(),deadline});if(decision.kind!=="eligible"||fresh.headSha!==result.pr.sourceHeadSha)throw new Error("precheck-changed-under-lock");await store.save(state,-1,lock);state=await advanceController(policy,store,lock,state,args);console.log(JSON.stringify({kind:state.stage==="done"?"done":"pending",stage:state.stage,key:state.key}));return state.stage==="done"?0:10;
  }catch(error){const reason=error instanceof Error&&/^[a-z0-9-]+$/.test(error.message)?error.message:"controller-evidence-unverifiable";const cause=error instanceof Error?sanitizeCause(typeof error.cause==="string"?error.cause:error.message):undefined;console.log(JSON.stringify({kind:"blocked",reason,cause}));return exitCode({kind:"blocked",reason});}finally{clearTimeout(timer);if(lock&&store)await store.release(lock);}
}
if(import.meta.main)process.exitCode=await cli(process.argv.slice(2));

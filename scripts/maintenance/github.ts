import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EligiblePr, MaintenancePolicy, ReleasePin, ScannerPin } from "./contracts";
import { verifyArtifactBinding, validateArtifactReceipt, type ArtifactBinding } from "../installed-smoke";
export const candidateHostAlias=(version:string)=>`omp-host-${version.replaceAll(".","")}`;
export interface PrObservation {
  repository:string; number:number; headRepository:string; baseBranch:string; branch:string; headSha:string; baseSha:string;
  author:{login:string;type:string};state:string;draft:boolean;files:readonly {path:string;mode:string;previousPath?:string;previousMode?:string;deleted?:boolean}[];hostPins:readonly string[];
  packageBefore?:Record<string,unknown>;packageAfter?:Record<string,unknown>;lockReceipt?:LockReceipt;
}
export type Precheck = {kind:"eligible";pr:EligiblePr}|{kind:"skip"|"blocked";reason:string};
export function precheck(policy:MaintenancePolicy,pr:PrObservation|undefined,time:{now:number;deadline:number}):Precheck {
  const blocked=(reason:string):Precheck=>({kind:"blocked",reason}); const skip=(reason:string):Precheck=>({kind:"skip",reason});
  if(time.now>=time.deadline)return blocked("deadline-expired");if(!pr)return skip("no-work");
  if(pr.author?.login!==policy.botLogin || pr.author.type!==policy.botType)return skip("untrusted-author");
  if(pr.repository!==policy.repository || pr.headRepository!==policy.repository)return skip("foreign-head");
  if(pr.state!=="OPEN" || pr.draft || pr.baseBranch!==policy.baseBranch)return skip("pr-ineligible");
  const match=new RegExp(policy.branchPattern).exec(pr.branch);if(!match?.[1])return skip("branch-ineligible"); const candidate=match[1];
  if(!Number.isSafeInteger(pr.number)||pr.number<1|| !/^[a-f0-9]{40}$/.test(pr.headSha)|| !/^[a-f0-9]{40}$/.test(pr.baseSha))return blocked("invalid-sha");
  if(!pr.hostPins?.length || pr.hostPins.some(pin=>pin!==candidate))return blocked("candidate-pin-mismatch");
  if(!pr.files?.length)return blocked("changed-paths-unavailable");
  for(const f of pr.files){
    if(f.path.includes("\\")||f.path.startsWith("/")||f.path.split("/").some(part=>part===".."||part==="."||part===""))return blocked("unsafe-path");
    if(f.previousPath)return blocked("incoming-file-rename");
    if(f.deleted)return blocked("incoming-file-deletion");
    if(f.mode!=="100644" || (f.previousMode && f.previousMode!==f.mode))return blocked("unsafe-file-mode");
    if(!policy.incomingPaths.some(path=>path.replaceAll("<candidate>",candidate)===f.path))return blocked("path-outside-policy");
  }
  if(pr.files.some(f=>f.path==="package.json")){
    if(!pr.packageBefore || !pr.packageAfter)return blocked("package-evidence-missing");
    for(const key of new Set([...Object.keys(pr.packageBefore),...Object.keys(pr.packageAfter)])){
      if(JSON.stringify(pr.packageBefore[key])===JSON.stringify(pr.packageAfter[key]))continue;
      if(key==="version"&&typeof pr.packageAfter[key]==="string"&&/^\d+\.\d+\.\d+$/.test(pr.packageAfter[key]))continue;
      if(key==="devDependencies"||key==="peerDependencies"){
        const before=record(pr.packageBefore[key]),after=record(pr.packageAfter[key]),candidateAlias=candidateHostAlias(candidate);
        const valid=[...new Set([...Object.keys(before),...Object.keys(after)])].every(name=>{
          if(before[name]===after[name])return true;
          if(/^@oh-my-pi\/(pi-coding-agent|pi-utils|pi-tui|pi-natives)$/.test(name)){
            if(key==="devDependencies")return after[name]===candidate;
            if(typeof before[name]!=="string")return false;
            const versions=before[name].split(" || ");
            return versions.includes(candidate)?after[name]===before[name]:after[name]===[...versions,candidate].join(" || ");
          }
          return key==="devDependencies"&&name===candidateAlias&&before[name]===undefined&&after[name]===`npm:@oh-my-pi/pi-coding-agent@${candidate}`;
        });
        if(valid)continue;
      }
      return blocked("package-field-outside-policy");
    }
  }
  if(pr.files.some(f=>f.path==="bun.lock") && (!pr.lockReceipt || pr.lockReceipt.headSha!==pr.headSha || pr.lockReceipt.candidate!==candidate || pr.lockReceipt.refusal || !/^[a-f0-9]{64}$/.test(pr.lockReceipt.oldHash) || !/^[a-f0-9]{64}$/.test(pr.lockReceipt.newHash)))return blocked(pr.lockReceipt?.refusal??"lockfile-semantic-evidence-missing");
  return {kind:"eligible",pr:{repository:policy.repository,number:pr.number,sourceHeadSha:pr.headSha,baseSha:pr.baseSha,branch:pr.branch,candidateVersion:candidate,changedPaths:pr.files.map(f=>f.path)}};
}
export function sanitizeCause(text:string):string {
  return text.replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[^\\/\s]+/g,"<user>").replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|Bearer\s+\S+|(?:token|password|secret)\s*[=:]\s*\S+)/gi,"<redacted>").slice(-4096);
}
export async function command(executable:string,args:readonly string[],timeoutMs:number,cwd?:string):Promise<{code:number;stdout:string;stderr:string}> {
  const {promise,resolve,reject}=Promise.withResolvers<{code:number;stdout:string;stderr:string}>();
  const child=spawn(executable,[...args],{cwd,stdio:["ignore","pipe","pipe"],windowsHide:true});let stdout="",stderr="";let bytes=0;
  const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error("command-deadline"),{cause:sanitizeCause(stderr)}));},timeoutMs);
  child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4_000_000){child.kill();reject(new Error("command-output-limit"));}else stdout+=chunk.toString();});
  child.stderr.on("data",(chunk:Buffer)=>{stderr=sanitizeCause(stderr+chunk.toString());});
  child.on("error",error=>{clearTimeout(timer);reject(Object.assign(new Error("command-unavailable"),{cause:sanitizeCause(error.message)}));});child.on("close",code=>{clearTimeout(timer);resolve({code:code??1,stdout,stderr:sanitizeCause(stderr)});});
  return promise;
}

export async function prepareScanner(pin:ScannerPin,stateDirectory:string,providedArchive?:string) {
  if(pin.platform!==process.platform)throw new Error("scanner-platform-unavailable");
  if(pin.version!=="8.30.1"||pin.asset!=="gitleaks_8.30.1_windows_x64.zip"||pin.url!==`https://github.com/gitleaks/gitleaks/releases/download/v${pin.version}/${pin.asset}`||pin.archiveSha256!=="d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e"||pin.executableSha256!=="17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c")throw new Error("scanner-policy-untrusted");
  await mkdir(stateDirectory,{recursive:true});
  const archive=providedArchive??join(stateDirectory,pin.asset);
  if(!await Bun.file(archive).exists()) {
    const response=await fetch(pin.url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error("scanner-download-unavailable");
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(createHash("sha256").update(bytes).digest("hex")!==pin.archiveSha256)throw new Error("scanner-archive-hash-mismatch");
    await writeFile(archive,bytes,{flag:"wx"});
  }
  if(createHash("sha256").update(await readFile(archive)).digest("hex")!==pin.archiveSha256)throw new Error("scanner-archive-hash-mismatch");
  const target=join(stateDirectory,"gitleaks.exe");
  if(!await Bun.file(target).exists()) {
    const result=await command("tar",["-xf",archive,"-C",stateDirectory,"gitleaks.exe"],30000);
    if(result.code!==0)throw new Error("scanner-extraction-unavailable");
  }
  if(createHash("sha256").update(await readFile(target)).digest("hex")!==pin.executableSha256)throw new Error("scanner-hash-mismatch");
  const version=await command(target,["version"],30000);if(version.code!==0||version.stdout.trim()!==pin.version)throw new Error("scanner-version-mismatch");
  return {executable:target,sha256:pin.executableSha256,version:pin.version};
}
export class GitHub {
  constructor(readonly policy:MaintenancePolicy){}
  async api(path:string):Promise<any>{const result=await command("gh",["api",path],this.policy.deadlinesMs.command);if(result.code!==0)throw Object.assign(new Error("github-read-unavailable"),{cause:result.stderr});return JSON.parse(result.stdout);}
  async observePr(number:number):Promise<PrObservation>{
    if(!Number.isSafeInteger(number)||number<1)throw new Error("invalid-pr-number");const root=`repos/${this.policy.repository}`;const pr=await this.api(`${root}/pulls/${number}`);
    const contents=(ref:string,path="package.json")=>this.api(`${root}/contents/${path}?ref=${ref}`).then(data=>Buffer.from(data.content,"base64").toString("utf8"));
    const changedFiles=async()=>{const files=[];for(let page=1;page<=30;page++){const rows=await this.api(`${root}/pulls/${number}/files?per_page=100&page=${page}`);files.push(...rows);if(rows.length<100)break;if(page===30)throw new Error("changed-paths-truncated");}return files;};
    const [files,tree,baseTree,afterBytes,beforeBytes]=await Promise.all([changedFiles(),this.api(`${root}/git/trees/${pr.head.sha}?recursive=1`),this.api(`${root}/git/trees/${pr.base.sha}?recursive=1`),contents(pr.head.sha),contents(pr.base.sha)]);
    if(tree.truncated||baseTree.truncated)throw new Error("git-tree-truncated");
    const after=JSON.parse(afterBytes),before=JSON.parse(beforeBytes);
    const candidate=new RegExp(this.policy.branchPattern).exec(pr.head.ref)?.[1]??"";
    const candidateAlias=candidateHostAlias(candidate);
    const hostPins=Object.entries(after.devDependencies??{}).filter(([name,value])=>/^@oh-my-pi\/(pi-coding-agent|pi-utils|pi-tui|pi-natives)$/.test(name)||name===candidateAlias&&value===`npm:@oh-my-pi/pi-coding-agent@${candidate}`).map(([,value])=>typeof value==="string"?value.replace(/^npm:@oh-my-pi\/pi-coding-agent@/,""):String(value));
    let lockReceipt:LockReceipt|undefined;
    if(files.some(f=>f.filename==="bun.lock"&&f.status!=="removed")) {
      const [oldLock,newLock]=await Promise.all([contents(pr.base.sha,"bun.lock"),contents(pr.head.sha,"bun.lock")]);
      const candidate=new RegExp(this.policy.branchPattern).exec(pr.head.ref)?.[1]??"";
      const trusted=await resolveHostLock(oldLock,candidate,this.policy.deadlinesMs.command);
      const workspace=record(record(Bun.JSON5.parse(oldLock)).workspaces)[""] as Record<string,unknown>;
      const peerMap=record(workspace.peerDependencies??{});
      const versions=String(peerMap["@oh-my-pi/pi-coding-agent"]??"").split(" || ").filter(Boolean);
      lockReceipt=verifyLockChange(oldLock,newLock,pr.head.sha,candidate,trusted,versions);
    }
    return {repository:pr.base.repo.full_name,number,headRepository:pr.head.repo?.full_name,baseBranch:pr.base.ref,branch:pr.head.ref,headSha:pr.head.sha,baseSha:pr.base.sha,author:botIdentity(pr.user,this.policy.botLogin),state:String(pr.state).toUpperCase(),draft:pr.draft,files:files.map(f=>{const previousMode=baseTree.tree.find((entry:{path:string;mode:string})=>entry.path===(f.previous_filename??f.filename))?.mode;return {path:f.filename,previousPath:f.previous_filename,mode:tree.tree.find((entry:{path:string;mode:string})=>entry.path===f.filename)?.mode??previousMode??"unknown",previousMode,deleted:f.status==="removed"};}),hostPins,packageBefore:before,packageAfter:after,lockReceipt};
  }
  async merge(number:number,headSha:string):Promise<Record<string,unknown>>{
    const before=await this.api(`repos/${this.policy.repository}/pulls/${number}`);if(before.head.sha!==headSha)throw new Error("stale-head");if(before.merged&&before.merge_commit_sha)return {mergeSha:before.merge_commit_sha};
    const result=await command("gh",["pr","merge",String(number),"--repo",this.policy.repository,"--merge","--match-head-commit",headSha],this.policy.deadlinesMs.command);if(result.code!==0)throw Object.assign(new Error("merge-refused"),{cause:result.stderr});
    const after=await this.api(`repos/${this.policy.repository}/pulls/${number}`);if(!after.merged||after.state!=="closed"||!after.merge_commit_sha)throw new Error("merge-receipt-unverified");return {mergeSha:after.merge_commit_sha};
  }
  async tag(tag:string,sha:string):Promise<Record<string,unknown>>{
    if(!/^v\d+\.\d+\.\d+$/.test(tag)||!/^[a-f0-9]{40}$/.test(sha))throw new Error("tag-input-invalid");
    const result=await command("gh",["api","--method","POST",`repos/${this.policy.repository}/git/refs`,"-f",`ref=refs/tags/${tag}`,"-f",`sha=${sha}`],this.policy.deadlinesMs.command);if(result.code!==0)throw Object.assign(new Error("tag-create-refused"),{cause:result.stderr});return {tag,sha};
  }
  async releasePin(tag:string,sha:string,version:string,supportedPairs:ReleasePin["supportedPairs"]):Promise<ReleasePin|undefined>{
    const root=`repos/${this.policy.repository}`;const result=await command("gh",["api",`${root}/releases/tags/${tag}`],this.policy.deadlinesMs.command);if(result.code!==0){if(result.stderr.includes("404"))return;throw Object.assign(new Error("release-read-unavailable"),{cause:result.stderr});}
    const release=JSON.parse(result.stdout);if(release.draft)return;const asset=release.assets?.find((a:{name:string})=>a.name===`omp-settings-ru-${version}.tgz`);if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??""))return;
    const ref=await this.api(`${root}/git/ref/tags/${tag}`);if(ref.object.sha!==sha)throw new Error("tag-conflict");const stable=await this.api(`${root}/git/ref/heads/stable`);if(stable.object.sha!==sha)throw new Error("stable-mismatch");
    const runs=await this.api(`${root}/actions/runs?head_sha=${sha}&per_page=100`);if(!runs.workflow_runs?.some((r:{name:string;head_sha:string;status:string;conclusion:string})=>r.name==="release"&&r.head_sha===sha&&r.status==="completed"&&r.conclusion==="success"))return;
    return {tag,commitSha:sha,assetId:asset.id,sha256:asset.digest.slice(7),packageVersion:version,supportedPairs};
  }
  async nativeReceipts(binding:ArtifactBinding,versions:readonly string[],checks:readonly {id?:number;name:string;detailsUrl?:string;headSha:string}[],stateDirectory:string):Promise<PublicationEvidence["smoke"]> {
    const receipts:PublicationEvidence["smoke"][number][]=[];
    for(const {platform,os} of this.policy.requiredCheckPlatforms)for(const version of versions) {
      const name=this.policy.requiredCheckTemplate.replaceAll("{os}",os).replaceAll("{version}",version);
      const check=checks.find(c=>c.name===name);
      const runId=check?.detailsUrl?/\/actions\/runs\/(\d+)(?:\/|$)/.exec(check.detailsUrl)?.[1]:undefined;
      if(!check?.id||!runId)throw new Error("native-ci-run-unavailable");
      const run=await this.api(`repos/${this.policy.repository}/actions/runs/${runId}`);
      if(run.status!=="completed"||run.conclusion!=="success"||run.head_sha!==check.headSha||!Number.isSafeInteger(run.run_attempt))throw new Error("native-ci-run-stale");
      const directory=join(stateDirectory,`${runId}-${run.run_attempt}-${version}-${platform}`);
      await mkdir(directory,{recursive:true});
      const filename=`installed-smoke-${version}-${platform}.json`;
      const download=await command("gh",["run","download",runId,"--repo",this.policy.repository,"--name",filename.slice(0,-5),"--dir",directory],this.policy.deadlinesMs.command);
      if(download.code!==0)throw new Error("native-ci-artifact-unavailable");
      const receipt:unknown=JSON.parse(await readFile(join(directory,filename),"utf8"));
      const metadata=record(receipt),executable=record(metadata.executable);
      if(metadata.checkRunHeadSha!==check.headSha||metadata.checkName!==name)throw new Error("native-ci-check-mismatch");
      const host=await this.api(`repos/can1357/oh-my-pi/releases/tags/v${version}`);
      const asset=host.assets?.find((row:{id:number})=>row.id===executable.assetId);
      if(!asset||asset.name!==executable.name||asset.digest!==`sha256:${executable.sha256}`||executable.releaseTag!==`v${version}`)throw new Error("native-host-release-unverified");
      const executableSha256=String(asset.digest).slice(7);
      const expected={version,platform,headSha:binding.headSha,treeHash:binding.treeHash,archiveSha256:binding.archiveSha256,contentHash:binding.contentHash,executableSha256,checkRunId:check.id,workflowRunId:runId,runAttempt:String(run.run_attempt)};
      const verdict=validateArtifactReceipt(receipt,expected);if(!verdict.ok)throw new Error(verdict.reason);
      receipts.push({checkRunId:check.id,checkRunHeadSha:check.headSha,version,platform,headSha:binding.headSha,treeHash:binding.treeHash,contentHash:binding.contentHash,binding,passed:true,native:true,receipt,workflowRunId:runId,runAttempt:String(run.run_attempt),executableSha256});
    }
    return receipts;
  }
}
export type DynamicChecks = Pick<MaintenancePolicy,"requiredCheckTemplate"|"requiredCheckPlatforms"|"additionalRequiredChecks">;
export function deriveChecks(policy:DynamicChecks, supportedVersions:readonly string[],candidate:string):string[]{
  if(!policy.requiredCheckTemplate.includes("{os}")||!policy.requiredCheckTemplate.includes("{version}"))throw new Error("check-template-invalid");
  const versions=[...new Set([...supportedVersions,candidate])];if(!versions.length||versions.some(v=>!/^\d+\.\d+\.\d+$/.test(v)))throw new Error("support-version-invalid");
  if(policy.requiredCheckPlatforms.length!==3||new Set(policy.requiredCheckPlatforms.map(p=>p.platform)).size!==3)throw new Error("check-platforms-incomplete");
  return [...policy.requiredCheckPlatforms.flatMap(({os})=>versions.map(version=>policy.requiredCheckTemplate.replaceAll("{os}",os).replaceAll("{version}",version))),...policy.additionalRequiredChecks];
}
export interface PublicationEvidence {
  headSha:string;baseSha:string;treeHash:string;artifactHash:string;supportedVersions?:readonly string[];candidateVersion?:string;
  workflowHeadSha?:string;
  binding:ArtifactBinding;
  review?:{headSha:string;baseSha:string;verdict:string;dispatchId:string;executorDispatchId:string;evidenceHashes:readonly string[]};
  checks:readonly {id?:number;name:string;headSha:string;status:string;conclusion:string}[];
  smoke:readonly {checkRunId?:number;checkRunHeadSha?:string;version:string;platform:string;headSha:string;treeHash:string;contentHash:string;binding:ArtifactBinding;passed:boolean;native:boolean;receipt?:unknown;workflowRunId?:string;runAttempt?:string;executableSha256?:string}[];
  privacy?:{headSha:string;artifactHash:string;passed:boolean;scanner:string;scannerHash:string;scopes:readonly string[]};
}
export function validateReleasePairs(pairs:readonly {hostVersion:string;platform:string}[],versions:readonly string[]):ReleasePin["supportedPairs"] {
  const expected=versions.flatMap(hostVersion=>(["win32","linux","darwin"] as const).map(platform=>({hostVersion,platform})));
  if(!expected.length||pairs.length!==expected.length||new Set(pairs.map(p=>`${p.hostVersion}/${p.platform}`)).size!==pairs.length||pairs.some(p=>!expected.some(e=>e.hostVersion===p.hostVersion&&e.platform===p.platform)))throw new Error("release-supported-pairs-invalid");
  return expected;
}
export function mergeGate(policy:MaintenancePolicy|DynamicChecks,e:PublicationEvidence,currentHead:string,currentBase:string):{ok:true;headSha:string}|{ok:false;reason:string}{
  const refuse=(reason:string)=>({ok:false as const,reason});
  if(!/^[a-f0-9]{40}$/.test(e.headSha)||currentHead!==e.headSha)return refuse("stale-head");if(currentBase!==e.baseSha)return refuse("stale-base");
  const review=e.review;if(!review||review.verdict!=="approved"||review.headSha!==e.headSha||review.baseSha!==e.baseSha||!review.dispatchId||review.dispatchId===review.executorDispatchId||!review.evidenceHashes.length||review.evidenceHashes.some(h=>!/^[a-f0-9]{64}$/.test(h)))return refuse("review-incomplete");
  let expected:readonly string[];try{expected=deriveChecks(policy,e.supportedVersions??[],e.candidateVersion??"");}catch{return refuse("check-derivation-unavailable");}
  if(!expected?.length||!e.checks?.length)return refuse("missing-checks");
  for(const name of expected){const rows=e.checks.filter(c=>c.name===name);if(rows.length!==1||rows[0]!.headSha!==(e.workflowHeadSha??e.headSha)||rows[0]!.status!=="completed"||rows[0]!.conclusion!=="success")return refuse("check-incomplete");}
  if(e.checks.some(c=>c.name.startsWith("check (")&&!expected.includes(c.name)))return refuse("matrix-mismatch");
  if(!/^[a-f0-9]{40}$/.test(e.treeHash)||!/^[a-f0-9]{64}$/.test(e.artifactHash)||!e.smoke?.length)return refuse("smoke-incomplete");
  if(!e.binding||e.binding.schemaVersion!==1||e.binding.headSha!==e.headSha||e.binding.treeHash!==e.treeHash||e.binding.archiveSha256!==e.artifactHash||!/^[a-f0-9]{64}$/.test(e.binding.contentHash)||e.binding.extractionVerified!==true||!Number.isSafeInteger(e.binding.fileCount)||e.binding.fileCount<1)return refuse("artifact-binding-unverified");
  const versions=e.supportedVersions&&e.candidateVersion?[...new Set([...e.supportedVersions,e.candidateVersion])]:[];
  if(!versions.length)return refuse("smoke-support-unavailable");
  for(const version of versions)for(const platform of ["win32","linux","darwin"]){const rows=e.smoke.filter(s=>s.version===version&&s.platform===platform);if(rows.length!==1)return refuse("smoke-incomplete");const s=rows[0]!;if(!s.passed||!s.native||s.headSha!==e.headSha||s.treeHash!==e.treeHash)return refuse("smoke-stale");if(s.contentHash!==e.binding.contentHash||s.binding?.contentHash!==e.binding.contentHash||s.binding?.archiveSha256!==e.artifactHash||s.binding?.headSha!==e.headSha||s.binding?.treeHash!==e.treeHash)return refuse("smoke-content-mismatch");}
  for(const smoke of e.smoke){const platform=policy.requiredCheckPlatforms.find(p=>p.platform===smoke.platform);const expectedName=platform?policy.requiredCheckTemplate.replaceAll("{os}",platform.os).replaceAll("{version}",smoke.version):undefined;const check=e.checks.find(c=>c.name===expectedName);if(!smoke.checkRunId||check?.id!==smoke.checkRunId||!smoke.receipt||!smoke.workflowRunId||!smoke.runAttempt||!smoke.executableSha256||smoke.checkRunHeadSha!==check.headSha||record(smoke.receipt).checkRunHeadSha!==check.headSha)return refuse("native-receipt-provenance-missing");const validated=validateArtifactReceipt(smoke.receipt,{version:smoke.version,platform:smoke.platform,headSha:e.headSha,treeHash:e.treeHash,archiveSha256:e.artifactHash,contentHash:e.binding.contentHash,executableSha256:smoke.executableSha256,checkRunId:smoke.checkRunId,workflowRunId:smoke.workflowRunId,runAttempt:smoke.runAttempt});if(!validated.ok)return refuse(validated.reason);}
  const privacy=e.privacy;if(!privacy||!privacy.passed||privacy.headSha!==e.headSha||privacy.artifactHash!==e.artifactHash||privacy.scanner!=="gitleaks"||!/^[a-f0-9]{64}$/.test(privacy.scannerHash)||["refs","worktree","package"].some(s=>!privacy.scopes.includes(s)))return refuse("privacy-incomplete");
  return {ok:true,headSha:e.headSha};
}
export interface ReleaseObservation {tagSha?:string;release?:{tag:string;draft:boolean;assetId:number;sha256:string;packageVersion:string};workflow?:{headSha:string;status:string;conclusion:string};stableSha?:string}
export function releaseDecision(pin:ReleasePin,o:ReleaseObservation):string {
  if(!/^[a-f0-9]{40}$/.test(pin.commitSha)||!/^[a-f0-9]{64}$/.test(pin.sha256)||pin.assetId<1)return "pin-invalid";
  if(!o.tagSha)return "wait-tag";if(o.tagSha!==pin.commitSha)return "tag-conflict";if(!o.release||o.release.draft)return "wait-release";
  if(o.release.tag!==pin.tag||o.release.assetId!==pin.assetId||o.release.sha256!==pin.sha256||o.release.packageVersion!==pin.packageVersion)return "release-conflict";
  if(!o.workflow||o.workflow.headSha!==pin.commitSha||o.workflow.status!=="completed"||o.workflow.conclusion!=="success")return "wait-workflow";
  if(!o.stableSha)return "wait-stable";if(o.stableSha!==pin.commitSha)return "stable-mismatch";return "ready";
}
export function publicationPlan(policy:MaintenancePolicy|DynamicChecks,evidence:PublicationEvidence,head:string,base:string,observation:{state:string;mergeSha?:string;tagSha?:string;releaseExists?:boolean}):any {
  if(observation.state!=="MERGED"){
    const gate=mergeGate(policy,evidence,head,base);if(!gate.ok)return gate;
    if(observation.state!=="OPEN")return {reason:"pr-state-inconclusive"};return {merge:{headSha:gate.headSha},mutations:["merge"]};
  }
  if(!observation.mergeSha||!/^[a-f0-9]{40}$/.test(observation.mergeSha))return {reason:"merge-sha-unverified"};
  if(observation.tagSha && observation.tagSha!==observation.mergeSha)return {reason:"tag-conflict"};
  const mutations=[];if(!observation.tagSha)mutations.push("tag");if(!observation.releaseExists)mutations.push("release");return {mergeSha:observation.mergeSha,mutations};
}
export interface LockReceipt {headSha:string;candidate:string;oldHash:string;newHash:string;refusal?:string}
export function verifyLockChange(oldBytes:string,newBytes:string,headSha:string,candidate:string,trustedBytes?:string,supportedVersions:readonly string[]=[]):LockReceipt {
  const receipt:LockReceipt={headSha,candidate,oldHash:createHash("sha256").update(oldBytes).digest("hex"),newHash:createHash("sha256").update(newBytes).digest("hex")};
  try {
    const before=record(Bun.JSON5.parse(oldBytes)),after=record(Bun.JSON5.parse(newBytes));
    if(before.lockfileVersion!==after.lockfileVersion||JSON.stringify(before.configVersion)!==JSON.stringify(after.configVersion))return {...receipt,refusal:"lockfile-format-change"};
    const oldPackages=record(before.packages),packages=record(after.packages);
    const oldWorkspaces=record(before.workspaces),workspaces=record(after.workspaces);
    const normalized=structuredClone(workspaces),oldRoot=record(oldWorkspaces[""]),root=record(normalized[""]);
    const direct=/^@oh-my-pi\/(pi-coding-agent|pi-utils|pi-tui|pi-natives)$/;
    const expectedPeers=[...new Set([...supportedVersions,candidate])].join(" || ");
    for(const field of ["devDependencies","peerDependencies"]) {
      const previous=record(oldRoot[field]??{}),next=record(root[field]??{});
      for(const name of new Set([...Object.keys(previous),...Object.keys(next)])) {
        if(previous[name]===next[name])continue;
        const candidateAlias=candidateHostAlias(candidate);
        const exactAlias=field==="devDependencies"&&name===candidateAlias&&previous[name]===undefined&&next[name]===`npm:@oh-my-pi/pi-coding-agent@${candidate}`;
        if(!exactAlias&&(!direct.test(name)||next[name]!== (field==="devDependencies"?candidate:expectedPeers)))return {...receipt,refusal:"lockfile-workspace-change"};
        if(previous[name]===undefined)delete next[name];else next[name]=previous[name];
      }
    }
    if(JSON.stringify(oldWorkspaces)!==JSON.stringify(normalized))return {...receipt,refusal:"lockfile-workspace-change"};
    const trusted=trustedBytes?record(record(Bun.JSON5.parse(trustedBytes)).packages):undefined;
    const reachable=new Set<string>();
    const visit=(key:string):void=> {
      if(reachable.has(key))return;
      const row=(trusted??packages)[key];if(!Array.isArray(row))return;
      reachable.add(key);
      const metadata=record(row[2]);
      for(const field of ["dependencies","optionalDependencies","peerDependencies"]) {
        for(const name of Object.keys(record(metadata[field]??{}))) {
          let prefix=key;
          let child:string|undefined;
          while(prefix) {const nested=`${prefix}/${name}`;if((trusted??packages)[nested]){child=nested;break;}prefix=prefix.includes("/")?prefix.slice(0,prefix.lastIndexOf("/")):"";}
          visit(child??name);
        }
      }
    };
    const canonicalAlias=(name:string,value:unknown):boolean=>{if(typeof value!=="string")return false;const match=/^npm:@oh-my-pi\/pi-coding-agent@(\d+\.\d+\.\d+)$/.exec(value);return !!match&&name===candidateHostAlias(match[1]!);};
    const seed=(deps:Record<string,unknown>,candidateOnly:boolean):void=>{for(const name of Object.keys(deps)){if(direct.test(name)){visit(name);continue;}if(!canonicalAlias(name,deps[name]))continue;if(candidateOnly&&deps[name]!==`npm:@oh-my-pi/pi-coding-agent@${candidate}`)continue;visit(name);}};
    seed(record(oldRoot.devDependencies??{}),false);
    seed(record(record(workspaces[""]).devDependencies??{}),true);
    for(const name of new Set([...Object.keys(oldPackages),...Object.keys(packages)])) {
      if(JSON.stringify(oldPackages[name])===JSON.stringify(packages[name]))continue;
      const row=packages[name];
      if(!reachable.has(name)||!Array.isArray(row)||row.length!==4||typeof row[3]!=="string"||!/^(sha512|sha256)-[A-Za-z0-9+/=]+$/.test(row[3])||row[1]!=="")return {...receipt,refusal:"lockfile-unexpected-package-change"};
      const metadata=record(row[2]);
      if(Object.keys(metadata).some(key=>!["dependencies","optionalDependencies","peerDependencies","optionalPeers","bin","os","cpu"].includes(key)))return {...receipt,refusal:"lockfile-host-metadata-change"};
      if(!trusted)return {...receipt,refusal:"lockfile-trusted-resolution-missing"};
      if(JSON.stringify(row)!==JSON.stringify(trusted[name]))return {...receipt,refusal:"lockfile-host-metadata-change"};
    }
    if(Object.keys(after).some(key=>!["lockfileVersion","configVersion","workspaces","packages"].includes(key)))return {...receipt,refusal:"lockfile-format-change"};
    return receipt;
  } catch {return {...receipt,refusal:"lockfile-parse-unverified"};}
}

export async function resolveHostLock(oldBytes:string,candidate:string,timeoutMs:number) {
  const before=record(Bun.JSON5.parse(oldBytes)),workspace=record(record(before.workspaces)[""]);
  const dependencies=structuredClone(record(workspace.devDependencies??{}));
  for(const name of Object.keys(dependencies))if(/^@oh-my-pi\/(pi-coding-agent|pi-utils|pi-tui|pi-natives)$/.test(name))dependencies[name]=candidate;
  const candidateAlias=candidateHostAlias(candidate);
  if(Object.hasOwn(dependencies,candidateAlias)&&dependencies[candidateAlias]!==`npm:@oh-my-pi/pi-coding-agent@${candidate}`)throw new Error("candidate-alias-conflict");
  dependencies[candidateAlias]=`npm:@oh-my-pi/pi-coding-agent@${candidate}`;
  const directory=await mkdtemp(join(tmpdir(),"maintenance-host-resolution-"));
  try {
    await writeFile(join(directory,"bun.lock"),oldBytes);
    await writeFile(join(directory,"package.json"),JSON.stringify({name:"trusted-host-resolution",devDependencies:dependencies,peerDependencies:workspace.peerDependencies??{},trustedDependencies:[]}));
    const result=await command("bun",["install","--lockfile-only","--ignore-scripts","--registry","https://registry.npmjs.org"],timeoutMs,directory);
    if(result.code!==0)throw new Error("trusted-host-resolution-unavailable");
    return await readFile(join(directory,"bun.lock"),"utf8");
  } finally {await rm(directory,{recursive:true,force:true});}
}
export function botIdentity(author:{login:string;type:string},configuredLogin:string):{login:string;type:string}{
  if(configuredLogin==="app/github-actions"&&author.login==="github-actions[bot]"&&author.type==="Bot")return {login:configuredLogin,type:"Bot"};
  return {login:author.login,type:author.type};
}
export function manifestChecks(policy:DynamicChecks,manifest:unknown,candidate:string):string[]{
  if(!manifest||typeof manifest!=="object"||!("schemaVersion" in manifest)||manifest.schemaVersion!==1||!("versions" in manifest)||!Array.isArray(manifest.versions)||!manifest.versions.length)throw new Error("supported-manifest-invalid");
  const allowed:Record<string,true>={schemaVersion:true,structuralFallback:true,versions:true,installedEvidence:true,unavailableInstalledRuns:true};if(Object.keys(manifest).some(key=>!allowed[key]))throw new Error("supported-manifest-field-outside-policy");
  const versions:string[]=[];for(const entry of manifest.versions){if(!entry||typeof entry!=="object"||!("version" in entry)||typeof entry.version!=="string"||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(entry.version)||!("platforms" in entry)||!Array.isArray(entry.platforms)||entry.platforms.length!==3||new Set(entry.platforms).size!==3||["win32","darwin","linux"].some(p=>!entry.platforms.includes(p)))throw new Error("supported-manifest-incomplete");if(Object.keys(entry).some(key=>!["version","package","platforms","baselines"].includes(key)))throw new Error("supported-manifest-field-outside-policy");if(entry.version===candidate&&entry.package!==candidateHostAlias(candidate))throw new Error("candidate-package-alias-invalid");if("baselines" in entry){const hashes=record(entry.baselines);if(Object.keys(hashes).length!==3||["win32","darwin","linux"].some(p=>typeof hashes[p]!=="string"||!/^[a-f0-9]{64}$/.test(String(hashes[p]))))throw new Error("supported-baseline-hash-invalid");}versions.push(entry.version);}
  return deriveChecks(policy,versions,candidate);
}
export function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("metadata-object-invalid");return value as Record<string,unknown>;}
export function validateMetadata(policy:DynamicChecks,beforePackage:unknown,afterPackage:unknown,beforeSupport:unknown,afterSupport:unknown,candidate:string):string|undefined{
  try{
    manifestChecks(policy,beforeSupport,candidate);manifestChecks(policy,afterSupport,candidate);
    const before=record(beforeSupport),after=record(afterSupport);const oldRows=before.versions as Record<string,unknown>[],rows=after.versions as Record<string,unknown>[];
    for(const previous of oldRows){const current=rows.find(r=>r.version===previous.version);if(!current)return "supported-version-removed";if(JSON.stringify(previous)!==JSON.stringify(current))return "accepted-support-entry-modified";}
    if(rows.some(r=>!oldRows.some(old=>old.version===r.version)&&r.version!==candidate))return "unsupported-version-added";
    const candidateAlias=candidateHostAlias(candidate);
    for(const row of rows)if(row.version===candidate&&row.package!==candidateAlias)return "candidate-package-alias-invalid";
    if(before.structuralFallback!==after.structuralFallback)return "supported-policy-text-modified";
    if(["installedEvidence","unavailableInstalledRuns"].some(field=>JSON.stringify(before[field])!==JSON.stringify(after[field])))return "supported-evidence-modified";
    const a=record(beforePackage),b=record(afterPackage),versions=rows.map(r=>String(r.version)),expectedPeers=versions.join(" || ");
    for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
      if(JSON.stringify(a[key])===JSON.stringify(b[key]))continue;
      if(key==="version"&&typeof a.version==="string"&&typeof b.version==="string"){const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(a.version);if(match&&b.version===`${match[1]}.${match[2]}.${Number(match[3])+1}`)continue;return "package-version-not-single-patch";}
      if(key==="devDependencies"||key==="peerDependencies"){
        const old=record(a[key]),next=record(b[key]),candidateAlias=candidateHostAlias(candidate);
        for(const name of new Set([...Object.keys(old),...Object.keys(next)])){
          if(old[name]===next[name])continue;
          const exactAlias=key==="devDependencies"&&name===candidateAlias&&old[name]===undefined&&next[name]===`npm:@oh-my-pi/pi-coding-agent@${candidate}`;
          if(!exactAlias&&(!/^@oh-my-pi\/(pi-coding-agent|pi-utils|pi-tui|pi-natives)$/.test(name)||typeof next[name]!=="string"||next[name]!== (key==="devDependencies"?candidate:expectedPeers)))return "package-dependency-outside-policy";
        }
        continue;
      }
      return "package-field-outside-policy";
    }
  }catch(error){return error instanceof Error?error.message:"metadata-invalid";}
}
export interface ProvenanceOptions {sourceDirectory:string;headSha:string;artifactPath:string;artifactHash:string;scannerPath:string;scannerHash:string;scannerVersion:string;stateDirectory:string}
export async function verifyProvenance(options:ProvenanceOptions){
  const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
  if(hash(await readFile(options.artifactPath))!==options.artifactHash)throw new Error("artifact-hash-mismatch");
  if(hash(await readFile(options.scannerPath))!==options.scannerHash)throw new Error("scanner-hash-mismatch");
  const version=await command(options.scannerPath,["version"],30000);if(version.code!==0||version.stdout.trim()!==options.scannerVersion)throw new Error("scanner-version-mismatch");
  const head=await command("git",["rev-parse","HEAD"],30000,options.sourceDirectory);if(head.code!==0||head.stdout.trim()!==options.headSha)throw new Error("source-head-mismatch");
  const dirty=await command("git",["diff","--name-only","HEAD"],30000,options.sourceDirectory);if(dirty.code!==0||dirty.stdout.trim())throw new Error("source-tree-dirty");
  const tree=await command("git",["rev-parse","HEAD^{tree}"],30000,options.sourceDirectory);if(tree.code!==0)throw new Error("source-tree-unavailable");
  const binding=await verifyArtifactBinding({sourceDirectory:options.sourceDirectory,archivePath:options.artifactPath,headSha:options.headSha,treeHash:tree.stdout.trim(),archiveSha256:options.artifactHash});
  await mkdir(options.stateDirectory,{recursive:true});const unpacked=join(options.stateDirectory,"scanned-package");await mkdir(unpacked,{recursive:true});
  const scannerConfig=join(options.stateDirectory,"trusted-gitleaks.toml");await writeFile(scannerConfig,"[extend]\nuseDefault = true\n",{flag:"wx"}).catch(error=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});if(await readFile(scannerConfig,"utf8")!=="[extend]\nuseDefault = true\n")throw new Error("scanner-config-conflict");
  const listing=await command("tar",["-tzf",options.artifactPath],30000);if(listing.code!==0||listing.stdout.split(/\r?\n/).filter(Boolean).some(p=>!p.startsWith("package/")||p.split("/").includes("..")||p.includes("\\")))throw new Error("artifact-archive-unsafe");
  const extract=await command("tar",["-xzf",options.artifactPath,"-C",unpacked],30000);if(extract.code!==0)throw new Error("artifact-extract-failed");
  const receipts=[];for(const [scope,target] of [["refs",options.sourceDirectory],["worktree",options.sourceDirectory],["package",unpacked]] as const){
    const reportPath=join(options.stateDirectory,`scanner-${scope}.json`);const argv=scope==="refs"?["git",target,"--log-opts=--all --full-history -m"]:["dir",target];const scan=await command(options.scannerPath,[...argv,"--config",scannerConfig,"--redact=100","--no-banner","--no-color","--ignore-gitleaks-allow","--gitleaks-ignore-path",join(options.stateDirectory,"no-ignore"),"--report-format=json","--report-path",reportPath],30000);if(scan.code!==0)throw Object.assign(new Error("scanner-findings-or-failure"),{cause:scan.stderr});const bytes=await readFile(reportPath);const findings:unknown=JSON.parse(bytes.toString());if(!Array.isArray(findings)||findings.length)throw new Error("scanner-findings");receipts.push({scope,reportHash:hash(bytes),findings:0,exitCode:scan.code});
  }
  return {headSha:options.headSha,treeHash:tree.stdout.trim(),artifactHash:options.artifactHash,binding,scanner:"gitleaks",scannerHash:options.scannerHash,scannerVersion:options.scannerVersion,scopes:receipts.map(r=>r.scope),receipts,passed:true};
}

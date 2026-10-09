import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EffectRecord, EligiblePr, LockRecord, MaintenanceState } from "./contracts";
const processStartedAt = Date.now() - Math.floor(process.uptime() * 1000);
export function initialState(pr: EligiblePr, deadline: number): MaintenanceState {
  return {schemaVersion:1,key:`${pr.repository}/pr-${pr.number}/${pr.sourceHeadSha}`,revision:0,stage:"locked",pr,attempt:1,deadline,sourceHeadSha:pr.sourceHeadSha,effects:[]};
}
export function resumeFence(state: Pick<MaintenanceState,"deadline"|"sourceHeadSha"|"workingHeadSha"> & Partial<Pick<MaintenanceState,"effects">>, head: string, now: number): string | undefined {
  if(now >= state.deadline)return "deadline-expired";
  const committed=state.effects?.find(e=>e.key==="commit")?.receipt?.headSha;
  const push=state.effects?.find(e=>e.key==="push");
  const savedPush=typeof committed==="string"&&push?.intent.headSha===committed&&(!push.receipt||push.receipt.headSha===committed)?committed:undefined;
  if(head !== (state.workingHeadSha ?? savedPush ?? state.sourceHeadSha))return "stale-head";
}
export type EffectObservation = {kind:"absent"} | {kind:"unknown"} | {kind:"conflict"} | {kind:"found";receipt:Readonly<Record<string,unknown>>};
export function effectDecision(effect: EffectRecord | undefined, observation: EffectObservation): "begin"|"apply"|"record"|"complete"|"blocked" {
  if(observation.kind === "unknown" || observation.kind === "conflict")return "blocked";
  if(!effect)return "begin";
  if(observation.kind === "absent")return effect.receipt ? "blocked" : "apply";
  if(effect.receipt)return JSON.stringify(effect.receipt) === JSON.stringify(observation.receipt) ? "complete" : "blocked";
  return "record";
}
export function rebaseReviewState(state:MaintenanceState,baseSha:string,deadline:number):MaintenanceState{
  if(!/^[a-f0-9]{40}$/.test(baseSha)||state.mergeSha)throw new Error("base-recovery-invalid");if(baseSha===state.pr.baseSha)return state;
  const previous=state.pr.baseSha;const archived=state.effects.map(effect=>effect.key==="reviewer"||effect.key==="review-verdict"?{...effect,key:`${effect.key}:attempt-${state.attempt}`}:effect);
  return {...state,revision:state.revision+1,stage:"pushed",attempt:state.attempt+1,deadline,pr:{...state.pr,baseSha},reviewedHeadSha:undefined,reviewerDispatchId:undefined,refusal:"base-advanced-independent-review-required",effects:[...archived,{key:`base-conflict:${state.attempt}`,intent:{baseSha},receipt:{oldBaseSha:previous,newBaseSha:baseSha}}]};
}
export class StateStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly directory: string) {}
  private file(key:string) {return join(this.directory,`${createHash("sha256").update(key).digest("hex")}.json`);}
  async acquire(key:string):Promise<LockRecord> {
    await mkdir(this.directory,{recursive:true});
    const lock:LockRecord={schemaVersion:1,key,nonce:randomUUID(),pid:process.pid,processStartedAt,acquiredAt:Date.now()};
    let handle; try {handle=await open(join(this.directory,"repo.lock"),"wx",0o600);} catch(e) {if((e as NodeJS.ErrnoException).code === "EEXIST")throw new Error("repo-locked");throw e;}
    try{await handle.writeFile(JSON.stringify(lock));await handle.sync();}finally{await handle.close();} return lock;
  }
  async lock():Promise<LockRecord|undefined> {try{return JSON.parse(await readFile(join(this.directory,"repo.lock"),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code === "ENOENT")return;throw new Error("lock-unverifiable");}}
  private async assertOwner(lock:LockRecord){const current=await this.lock();if(!current || current.nonce!==lock.nonce || current.pid!==process.pid || current.processStartedAt!==processStartedAt)throw new Error("lock-owner-mismatch");}
  async release(lock:LockRecord){await this.assertOwner(lock);await unlink(join(this.directory,"repo.lock"));}
  async load(key:string):Promise<MaintenanceState|undefined>{try{const state=JSON.parse(await readFile(this.file(key),"utf8"));if(state.schemaVersion!==1 || state.key!==key || !Number.isSafeInteger(state.revision))throw new Error("state-invalid");return state;}catch(e){if((e as NodeJS.ErrnoException).code === "ENOENT")return;throw e;}}
  async findPr(number:number):Promise<MaintenanceState|undefined>{
    let files:string[];try{files=await readdir(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}
    const matches:MaintenanceState[]=[];for(const name of files){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const state=JSON.parse(await readFile(join(this.directory,name),"utf8")) as MaintenanceState;if(state.schemaVersion===1&&state.pr.number===number&&state.stage!=="done")matches.push(state);}
    if(matches.length>1)throw new Error("multiple-pr-generations-require-selection");return matches[0];
  }
  async findAnyPending():Promise<MaintenanceState|undefined>{
    let files:string[];try{files=await readdir(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}
    const matches:MaintenanceState[]=[];for(const name of files){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const state=JSON.parse(await readFile(join(this.directory,name),"utf8")) as MaintenanceState;if(state.schemaVersion===1&&state.stage!=="done")matches.push(state);}
    if(matches.length>1)throw new Error("multiple-pending-runs-require-selection");return matches[0];
  }
  async save(state:MaintenanceState, expectedRevision:number, lock:LockRecord):Promise<void>{
    const prior=this.writes.get(state.key)??Promise.resolve();
    const write=prior.catch(()=>{}).then(async()=>{
      await this.assertOwner(lock);const current=await this.load(state.key);
      if((current?.revision??-1)!==expectedRevision || state.revision!==expectedRevision+1)throw new Error("revision-conflict");
      if(lock.key!==state.key && lock.key!==`pr-${state.pr.number}`)throw new Error("lock-key-mismatch");
      const temporary=join(this.directory,`${randomUUID()}.tmp`);const handle=await open(temporary,"wx",0o600);
      try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}
      try{await rename(temporary,this.file(state.key));}catch(e){await unlink(temporary).catch(()=>{});throw e;}
    });this.writes.set(state.key,write);try{await write;}finally{if(this.writes.get(state.key)===write)this.writes.delete(state.key);}
  }
  async effect(state:MaintenanceState,lock:LockRecord,key:string,intent:Readonly<Record<string,unknown>>,observe:()=>Promise<EffectObservation>,apply:()=>Promise<Readonly<Record<string,unknown>>>):Promise<MaintenanceState>{
    if(Date.now()>=state.deadline)throw new Error("deadline-expired");
    let current=state; let record=current.effects.find(e=>e.key===key);
    if(record && JSON.stringify(record.intent)!==JSON.stringify(intent))throw new Error("effect-intent-conflict");
    let observation=await observe();let decision=effectDecision(record,observation);
    if(decision==="blocked")throw new Error("effect-unverifiable");
    if(decision==="complete")return current;
    if(!record){record={key,intent};current={...current,revision:current.revision+1,effects:[...current.effects,record]};await this.save(current,state.revision,lock);decision=observation.kind==="found"?"record":"apply";}
    // Once an intent exists, only positive absence authorizes a mutation.
    let receipt:Readonly<Record<string,unknown>>;
    try {receipt=decision==="record" && observation.kind==="found"?observation.receipt:await apply();}
    catch(error) {
      if(error&&typeof error==="object"&&"receipt" in error&&error.receipt&&typeof error.receipt==="object"&&!Array.isArray(error.receipt)) {
        const partial=error.receipt as Record<string,unknown>;
        if(typeof partial.dispatchId==="string"&&typeof partial.taskId==="string") {
          const failed={...current,revision:current.revision+1,effects:current.effects.map(e=>e.key===key?{...e,receipt:{...partial,validationFailed:true}}:e)};
          await this.save(failed,current.revision,lock);
        }
      }
      throw error;
    }
    const next={...current,revision:current.revision+1,effects:current.effects.map(e=>e.key===key?{...e,receipt}:e)};await this.save(next,current.revision,lock);return next;
  }
}

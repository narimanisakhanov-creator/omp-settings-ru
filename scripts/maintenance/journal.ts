import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EffectObservation, EffectRecord, LockRecord, MaintenanceState } from "./contracts.ts";

/**
 * Durable bookkeeping for one maintenance generation.
 *
 * Layout (outside the repository, one state root):
 *   lock.json                    — one global exclusive maintenance lock (nonce, pid, process start)
 *   runs/<sha256 generation>/    — one directory per generation, never overwritten by another
 *     journal.jsonl              — append-only intent/receipt lines, fsynced before the action
 *     state.json                 — atomic snapshot (temp + rename) guarded by a revision check
 *
 * Every generation owns its own directory, so two runs that reuse an effect key never read each
 * other's receipts and a new run cannot overwrite an unfinished one. The global lock is keyed by
 * the generation it was taken for: acting on a different generation is refused, and a lock is
 * never removed without proving ownership.
 *
 * A lock left behind by a dead process is not removed here. There is no OS-bound proof-of-death
 * helper yet, so recovery fails closed: `acquire` keeps reporting `lock-held` and the controller
 * reports the blocker instead of guessing. Automatic crash healing is therefore not claimed.
 */

export type JournalErrorCode =
 | "lock-held"
 | "lock-ownership"
 | "lock-corrupt"
 | "state-ambiguous"
 | "revision-conflict"
 | "effect-conflict"
 | "effect-unproven";

export class JournalError extends Error {
 readonly code: JournalErrorCode;
 constructor(code: JournalErrorCode, message: string) {
  super(message);
  this.name = "JournalError";
  this.code = code;
 }
}

interface JournalLine {
 readonly kind: "intent" | "receipt";
 readonly at: number;
 readonly stateKey: string;
 readonly key: string;
 readonly intent?: Readonly<Record<string, unknown>>;
 readonly receipt?: Readonly<Record<string, unknown>>;
}

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

const canonical = (value: Readonly<Record<string, unknown>>): string =>
 JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));

const sameIntent = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean =>
 canonical(left) === canonical(right);

const sameOwner = (left: LockRecord, right: LockRecord): boolean =>
 left.nonce === right.nonce && left.pid === right.pid && left.processStartedAt === right.processStartedAt;

const settled = (stage: MaintenanceState["stage"]): boolean => stage === "done" || stage === "blocked";

export class Journal {
 private readonly root: string;
 private readonly lockPath: string;

 private constructor(root: string) {
  this.root = root;
  this.lockPath = join(root, "lock.json");
 }

 static async open(root: string): Promise<Journal> {
  const journal = new Journal(root);
  await mkdir(join(root, "runs"), { recursive: true });
  return journal;
 }

 async lock(): Promise<LockRecord | undefined> {
  const raw = await this.readLockFile();
  if (raw === undefined) return undefined;
  try {
   return JSON.parse(raw) as LockRecord;
  } catch {
   throw new JournalError("lock-corrupt", "lock.json is not readable JSON; treating the lock as held by an unknown owner");
  }
 }

 async acquire(key: string): Promise<LockRecord> {
  const record: LockRecord = {
   schemaVersion: 1,
   key,
   nonce: randomUUID(),
   pid: process.pid,
   processStartedAt: Math.round(Date.now() - process.uptime() * 1000),
   acquiredAt: Date.now(),
  };
  try {
   await writeFile(this.lockPath, JSON.stringify(record), { flag: "wx" });
  } catch (error) {
   if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") {
    throw new JournalError("lock-held", "another maintenance lock exists; it is never removed without proof of owner exit");
   }
   throw error;
  }
  return record;
 }

 async release(lock: LockRecord): Promise<void> {
  const raw = await this.readLockFile();
  if (raw === undefined) return;
  let current: LockRecord;
  try {
   current = JSON.parse(raw) as LockRecord;
  } catch {
   throw new JournalError("lock-corrupt", "lock.json is not readable JSON; refusing to remove an unknown owner's lock");
  }
  if (!sameOwner(current, lock)) {
   throw new JournalError("lock-ownership", "lock.json belongs to a different owner; refusing to remove it");
  }
  await unlink(this.lockPath);
 }

 async load(key: string): Promise<MaintenanceState | undefined> {
  const persisted = await this.readState(key);
  return persisted?.key === key ? persisted : undefined;
 }

 /**
  * The one generation that has not settled yet, if any.
  *
  * `run` resumes it and `precheck` treats its PR as the controller's own. Two unsettled
  * generations mean the state root is inconsistent, which is reported rather than guessed at.
  */
 async findAnyPending(): Promise<MaintenanceState | undefined> {
  const pending: MaintenanceState[] = [];
  for (const entry of await this.runEntries()) {
   const persisted = await this.readStateByDirectory(entry);
   if (persisted !== undefined && !settled(persisted.stage)) pending.push(persisted);
  }
  if (pending.length > 1) throw new JournalError("state-ambiguous", `${pending.length} generations are unsettled; refusing to choose one`);
  return pending[0];
 }

 /** Same query as {@link findAnyPending}, named for the precheck call site. */
 async loadAnyPending(): Promise<MaintenanceState | undefined> {
  return this.findAnyPending();
 }

 async save(state: MaintenanceState, expectedRevision: number, lock: LockRecord): Promise<MaintenanceState> {
  await this.assertOwnership(lock, state);
  const persisted = await this.readState(state.key);
  const revision = persisted?.revision ?? 0;
  if (revision !== expectedRevision) {
   throw new JournalError("revision-conflict", `state.json for this generation holds revision ${revision}, the caller expected ${expectedRevision}`);
  }
  const next: MaintenanceState = { ...state, revision: expectedRevision + 1 };
  const directory = this.runDirectory(state.key);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "journal.jsonl"), "", { flag: "a" });
  const temporary = join(directory, `.state.json.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(next));
  try {
   await rename(temporary, join(directory, "state.json"));
  } catch (error) {
   await unlink(temporary).catch(() => undefined);
   throw error;
  }
  return next;
 }

 /** Read immutable intent/receipt before caller guards inspect mutable external state. */
 async persistedEffect(state: MaintenanceState, key: string): Promise<EffectRecord | undefined> {
  const records = state.effects.filter(record => record.key === key);
  const durable = await this.readJournal(state.key);
  for (const line of durable) {
   if (!line || typeof line !== "object" || line.stateKey !== state.key || typeof line.key !== "string"
    || (line.kind !== "intent" && line.kind !== "receipt")) throw new JournalError("effect-unproven", "journal line is malformed");
  }
  const lines = durable.filter(line => line.key === key);
  let intent: Readonly<Record<string, unknown>> | undefined;
  let receipt: Readonly<Record<string, unknown>> | undefined;
  const object = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value);
  for (const record of records) {
   if (!object(record.intent) || (record.receipt !== undefined && !object(record.receipt))) throw new JournalError("effect-unproven", "persisted effect is malformed");
   if (intent && !sameIntent(intent, record.intent)) throw new JournalError("effect-conflict", "persisted intents disagree");
   intent = record.intent;
   if (record.receipt) {
    if (receipt && !sameIntent(receipt, record.receipt)) throw new JournalError("effect-conflict", "persisted receipts disagree");
    receipt = record.receipt;
   }
  }
  for (const line of lines) {
   if (line.stateKey !== state.key || (line.kind !== "intent" && line.kind !== "receipt")) throw new JournalError("effect-unproven", "journal identity is malformed");
   if (line.kind === "intent") {
    if (!object(line.intent)) throw new JournalError("effect-unproven", "journal intent is malformed");
    if (intent && !sameIntent(intent, line.intent)) throw new JournalError("effect-conflict", "journal intents disagree");
    intent = line.intent;
   } else {
    if (!object(line.receipt)) throw new JournalError("effect-unproven", "journal receipt is malformed");
    if (receipt && !sameIntent(receipt, line.receipt)) throw new JournalError("effect-conflict", "journal receipts disagree");
    receipt = line.receipt;
   }
  }
  if (!intent && receipt) throw new JournalError("effect-unproven", "receipt has no immutable intent");
  return intent ? { key, intent, ...(receipt ? { receipt } : {}) } : undefined;
 }


 /**
  * Apply one external effect at most once, for one generation.
  *
  * The intent is appended and fsynced before anything leaves this process. A receipt for this
  * generation and key short-circuits, but only when the recorded intent equals the intent being
  * requested; a reused key with a different target is a conflict, not a replay. Without a receipt,
  * `observe` decides — `found` records the observation and skips `apply`, so a crash between the
  * action and its receipt cannot reapply the effect. `conflict` and `unknown` block.
  */
 async effect(
  state: MaintenanceState,
  lock: LockRecord,
  key: string,
  intent: Readonly<Record<string, unknown>>,
  observe: () => Promise<EffectObservation>,
  apply: () => Promise<Readonly<Record<string, unknown>>>,
 ): Promise<MaintenanceState> {
  await this.assertOwnership(lock, state);
  const recorded = state.effects.find((record) => record.key === key && record.receipt !== undefined);
  if (recorded !== undefined) {
   if (!sameIntent(recorded.intent, intent)) throw new JournalError("effect-conflict", `effect ${key} was already applied with a different intent in this generation`);
   return state;
  }

  const lines = (await this.readJournal(state.key)).filter((line) => line.key === key);
  const pending = lines.find((line) => line.kind === "intent");
  if (pending?.intent !== undefined && !sameIntent(pending.intent, intent)) {
   throw new JournalError("effect-conflict", `effect ${key} was started with a different intent in this generation`);
  }
  const journalReceipt = lines.find((line) => line.kind === "receipt")?.receipt;
  if (journalReceipt !== undefined) {
   return this.record(state, lock, { key, intent, receipt: journalReceipt });
  }
  if (pending === undefined) {
   await this.append(state.key, { kind: "intent", at: Date.now(), stateKey: state.key, key, intent });
  }

  const observation = await observe();
  if (observation.kind === "conflict" || observation.kind === "unknown") {
   throw new JournalError("effect-unproven", `effect ${key} cannot be proven ${observation.kind}; refusing to apply it`);
  }
  const receipt = observation.kind === "found" ? observation.receipt : await apply();
  await this.append(state.key, { kind: "receipt", at: Date.now(), stateKey: state.key, key, receipt });
  return this.record(state, lock, { key, intent, receipt });
 }

 private async record(state: MaintenanceState, lock: LockRecord, record: EffectRecord): Promise<MaintenanceState> {
  return this.save({ ...state, effects: [...state.effects, record] }, state.revision, lock);
 }

 private async assertOwnership(lock: LockRecord, state: MaintenanceState): Promise<void> {
  const scopes = [state.key, `controller:${state.generation.repository}`];
  if (!scopes.includes(lock.key)) {
   throw new JournalError("lock-ownership", `lock.json is held for ${lock.key}; refusing to act on generation ${state.key}`);
  }
  const current = await this.lock();
  if (current === undefined) {
   throw new JournalError("lock-ownership", "lock.json is absent; the caller no longer holds the maintenance lock");
  }
  if (!sameOwner(current, lock)) {
   throw new JournalError("lock-ownership", "lock.json belongs to a different owner; refusing to act");
  }
 }

 private async runEntries(): Promise<readonly string[]> {
  try {
   return await readdir(join(this.root, "runs"));
  } catch (error) {
   if (absent(error)) return [];
   throw error;
  }
 }

 private async readStateByDirectory(entry: string): Promise<MaintenanceState | undefined> {
  let raw: string;
  try {
   raw = await readFile(join(this.root, "runs", entry, "state.json"), "utf8");
  } catch (error) {
   if (absent(error)) return undefined;
   throw error;
  }
  return JSON.parse(raw) as MaintenanceState;
 }

 private runDirectory(key: string): string {
  return join(this.root, "runs", createHash("sha256").update(key).digest("hex"));
 }

 private async readState(key: string): Promise<MaintenanceState | undefined> {
  let raw: string;
  try {
   raw = await readFile(join(this.runDirectory(key), "state.json"), "utf8");
  } catch (error) {
   if (absent(error)) return undefined;
   throw error;
  }
  return JSON.parse(raw) as MaintenanceState;
 }

 private async readLockFile(): Promise<string | undefined> {
  try {
   return await readFile(this.lockPath, "utf8");
  } catch (error) {
   if (absent(error)) return undefined;
   throw error;
  }
 }

 private async readJournal(key: string): Promise<readonly JournalLine[]> {
  let raw: string;
  try {
   raw = await readFile(join(this.runDirectory(key), "journal.jsonl"), "utf8");
  } catch (error) {
   if (absent(error)) return [];
   throw error;
  }
  return raw
   .split("\n")
   .filter((line) => line.length > 0)
   .map((line) => JSON.parse(line) as JournalLine);
 }

 private async append(key: string, line: JournalLine): Promise<void> {
  const directory = this.runDirectory(key);
  await mkdir(directory, { recursive: true });
  const handle = await open(join(directory, "journal.jsonl"), "a");
  try {
   await handle.write(`${JSON.stringify(line)}\n`);
   await handle.sync();
  } finally {
   await handle.close();
  }
 }
}

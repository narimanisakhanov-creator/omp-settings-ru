import { expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, JournalError, type JournalErrorCode } from "../scripts/maintenance/journal.ts";
import type { LockRecord, MaintenanceState } from "../scripts/maintenance/contracts.ts";

const fresh = (): Promise<string> => mkdtemp(join(tmpdir(), "omp-journal-test-"));
const sha = (seed: string): string => seed.repeat(40);
// The controller owns the state key: (repository, candidate, baseSha, attempt nonce). It never
// contains the head sha, so a head move during one attempt keeps the same journal identity.
const runKey = (candidate: string, baseSeed: string, attempt: number): string =>
 `narimanisakhanov-creator/omp-settings-ru#${candidate}@${sha(baseSeed)}~${attempt}`;
const initial = (key: string): MaintenanceState => ({
 schemaVersion: 1,
 key,
 generation: { repository: "narimanisakhanov-creator/omp-settings-ru", candidateVersion: "18.8.9", baseSha: sha("9"), attemptNonce: "1" },
 revision: 0,
 stage: "locked",
 attempt: 1,
 deadline: 0,
 upstreamVersion: "18.8.9",
 releaseVersion: "0.6.0",
 pr: { number: 41, branch: "upgrade/omp-18.8.9", baseSha: sha("9"), headSha: sha("8"), candidateVersion: "18.8.9" },
 effects: [],
});
async function countLines(path: string): Promise<number> {
 return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0).length;
}
async function runDirs(root: string): Promise<readonly string[]> {
 return await readdir(join(root, "runs"));
}
async function expectJournalError(run: () => Promise<unknown>, code: JournalErrorCode): Promise<void> {
 try { await run(); } catch (error) { expect(error).toBeInstanceOf(JournalError); expect((error as JournalError).code).toBe(code); return; }
 throw new Error(`expected JournalError(${code})`);
}
async function withJournal(run: (root: string) => Promise<void>): Promise<void> {
 const root = await fresh();
 try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("intent is durable before the external effect and the receipt is recorded after", async()=>{
 await withJournal(async(root)=>{
  const journal = await Journal.open(root);
  const key = runKey("18.8.9", "1", 1);
  const lock = await journal.acquire(key);
  let journalAtApply = "";
  const applied = await journal.effect(initial(key), lock, "create-pr", { number: 41 }, async()=>({ kind: "absent" as const }), async()=>{
   journalAtApply = await readFile(join(root, "runs", (await runDirs(root))[0]!, "journal.jsonl"), "utf8");
   return { number: 41, headSha: sha("a") };
  });
  const directory = join(root, "runs", (await runDirs(root))[0]!);
  expect(journalAtApply).toContain("create-pr");
  expect(journalAtApply).toContain(key);
  expect(journalAtApply).not.toContain("headSha");
  const lines = (await readFile(join(directory, "journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; key: string; stateKey: string; receipt?: Record<string, unknown> });
  expect(lines.map((line) => line.kind)).toEqual(["intent", "receipt"]);
  expect(lines[0]?.key).toBe("create-pr");
  expect(lines[0]?.stateKey).toBe(key);
  expect(lines[1]?.receipt?.headSha).toBe(sha("a"));
  expect(applied.revision).toBe(1);
  expect(applied.effects).toEqual([{ key: "create-pr", intent: { number: 41 }, receipt: { number: 41, headSha: sha("a") } }]);
  expect(applied.schemaVersion).toBe(1);
  expect(applied.attempt).toBe(1);
  expect(applied.pr.headSha).toBe(sha("8"));
  expect(applied.stage).toBe("locked");
 });
});

test("a rerun with a recorded receipt does not repeat the external action", async()=>{
 await withJournal(async(root)=>{
  const key = runKey("18.8.9", "1", 1);
  const effectFile = join(root, "effect.log");
  const first = await Journal.open(root);
  const lock = await first.acquire(key);
  const afterApply = await first.effect(initial(key), lock, "tag-release", { tag: "v18.8.9" }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "tagged\n");
   return { tag: "v18.8.9", sha: sha("b") };
  });
  expect(afterApply.revision).toBe(1);
  const resumed = await Journal.open(root);
  const loaded = await resumed.load(key);
  expect(loaded?.revision).toBe(1);
  const rerun = await resumed.effect(loaded!, lock, "tag-release", { tag: "v18.8.9" }, async()=>{ throw new Error("observe must not run when a receipt exists"); }, async()=>{ throw new Error("apply must not rerun when a receipt exists"); });
  expect(rerun.revision).toBe(1);
  expect(rerun.effects[0]?.receipt).toEqual({ tag: "v18.8.9", sha: sha("b") });
  expect(await countLines(effectFile)).toBe(1);
  expect(await countLines(join(root, "runs", (await runDirs(root))[0]!, "journal.jsonl"))).toBe(2);
 });
});

test("a crash after intent without receipt observes the existing external effect instead of reapplying it", async()=>{
 await withJournal(async(root)=>{
  const key = runKey("18.8.9", "1", 1);
  const effectFile = join(root, "effect.log");
  const crashed = await Journal.open(root);
  const lock = await crashed.acquire(key);
  await expect(crashed.effect(initial(key), lock, "merge-pr", { number: 41 }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "merged\n");
   throw new Error("simulated crash before the receipt was recorded");
  })).rejects.toThrow("simulated crash");
  const directory = join(root, "runs", (await runDirs(root))[0]!);
  expect(await countLines(join(directory, "journal.jsonl"))).toBe(1);
  await expect(readFile(join(directory, "state.json"), "utf8")).rejects.toThrow();
  const resumed = await Journal.open(root);
  const observed: string[] = [];
  const recovered = await resumed.effect(initial(key), lock, "merge-pr", { number: 41 }, async()=>{
   observed.push("observe");
   return { kind: "found" as const, receipt: { number: 41, mergeSha: sha("c") } };
  }, async()=>{ throw new Error("apply must not reapply an effect that already happened"); });
  expect(observed).toEqual(["observe"]);
  expect(recovered.revision).toBe(1);
  expect(recovered.effects[0]?.receipt).toEqual({ number: 41, mergeSha: sha("c") });
  expect(await countLines(effectFile)).toBe(1);
  const lines = (await readFile(join(directory, "journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
  expect(lines.map((line) => line.kind)).toEqual(["intent", "receipt"]);
 });
});

test("a conflicting or unknown observation blocks and never applies", async()=>{
 await withJournal(async(root)=>{
  const effectFile = join(root, "effect.log");
  const journal = await Journal.open(root);
  for (const [seed, kind] of [["5", "conflict"], ["6", "unknown"]] as const) {
   const key = runKey("18.8.9", seed, 1);
   const lock = await journal.acquire(key);
   await expectJournalError(() => journal.effect(initial(key), lock, "merge-pr", { number: 41 }, async()=>({ kind }), async()=>{
    await appendFile(effectFile, `${kind} applied\n`);
    return { number: 41, mergeSha: sha("e") };
   }), "effect-unproven");
   await journal.release(lock);
  }
  expect(await readFile(effectFile, "utf8").catch(() => "")).toBe("");
  expect(await runDirs(root)).toHaveLength(2);
 });
});

test("a foreign lock is never removed and ownership is verified on release", async()=>{
 await withJournal(async(root)=>{
  const key = runKey("18.8.9", "1", 1);
  const owner = await Journal.open(root);
  const lock = await owner.acquire(key);
  const other = await Journal.open(root);
  const foreign: LockRecord = { ...lock, nonce: "foreign-nonce", pid: lock.pid + 1 };
  await expectJournalError(() => other.release(foreign), "lock-ownership");
  await expectJournalError(() => other.save(initial(key), 0, foreign), "lock-ownership");
  expect(JSON.parse(await readFile(join(root, "lock.json"), "utf8")).nonce).toBe(lock.nonce);
  await expectJournalError(() => other.acquire(key), "lock-held");
  expect(JSON.parse(await readFile(join(root, "lock.json"), "utf8")).nonce).toBe(lock.nonce);
  expect((await other.lock())?.nonce).toBe(lock.nonce);
  await other.release(lock);
  await expect(readFile(join(root, "lock.json"), "utf8")).rejects.toThrow();
  expect(await other.lock()).toBeUndefined();
  await other.release(lock);
 });
});

test("a lock held for another generation cannot be used to act on this one", async()=>{
 await withJournal(async(root)=>{
  const journal = await Journal.open(root);
  const lock = await journal.acquire(runKey("18.8.9", "7", 1));
  await expectJournalError(() => journal.save(initial(runKey("18.8.9", "8", 1)), 0, lock), "lock-ownership");
  await expectJournalError(() => journal.effect(initial(runKey("18.8.9", "8", 1)), lock, "merge-pr", { number: 41 }, async()=>({ kind: "absent" as const }), async()=>({ number: 41 })), "lock-ownership");
  expect(await runDirs(root)).toHaveLength(0);
 });
});

test("an unreadable lock is reported and never treated as free or removed", async()=>{
 await withJournal(async(root)=>{
  await writeFile(join(root, "lock.json"), "{not-json", "utf8");
  const journal = await Journal.open(root);
  await expectJournalError(() => journal.lock(), "lock-corrupt");
  await expectJournalError(() => journal.acquire(runKey("18.8.9", "1", 1)), "lock-held");
  await expectJournalError(() => journal.release({ schemaVersion: 1, key: runKey("18.8.9", "1", 1), nonce: "n", pid: 1, processStartedAt: 0, acquiredAt: 0 }), "lock-corrupt");
  expect(await readFile(join(root, "lock.json"), "utf8")).toBe("{not-json");
 });
});

test("a lock left by a dead run blocks the next run and is never removed automatically", async()=>{
 await withJournal(async(root)=>{
  const key = runKey("18.8.9", "1", 1);
  const dead = await Journal.open(root);
  const abandoned = await dead.acquire(key);
  // The owner process is gone; the lock file remains and no recovery is invented for it.
  const next = await Journal.open(root);
  await expectJournalError(() => next.acquire(key), "lock-held");
  expect((await next.lock())?.nonce).toBe(abandoned.nonce);
  const persisted = JSON.parse(await readFile(join(root, "lock.json"), "utf8")) as LockRecord;
  expect(persisted.pid).toBe(abandoned.pid);
  expect(persisted.processStartedAt).toBe(abandoned.processStartedAt);
  expect(await readFile(join(root, "lock.json"), "utf8")).toBe(JSON.stringify(abandoned));
 });
});

test("a stale revision is rejected and state is written atomically", async()=>{
 await withJournal(async(root)=>{
  const key = runKey("18.8.9", "1", 1);
  const journal = await Journal.open(root);
  const lock = await journal.acquire(key);
  await journal.save({ ...initial(key), stage: "working" }, 0, lock);
  const directory = join(root, "runs", (await runDirs(root))[0]!);
  expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).revision).toBe(1);
  await expectJournalError(() => journal.save({ ...initial(key), stage: "prepared" }, 5, lock), "revision-conflict");
  const persisted = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as MaintenanceState;
  expect(persisted.revision).toBe(1);
  expect(persisted.stage).toBe("working");
  const loaded = await journal.load(key);
  expect(loaded?.revision).toBe(1);
  expect(loaded?.stage).toBe("working");
  await journal.save({ ...loaded!, stage: "prepared" }, loaded!.revision, lock);
  expect((await journal.load(key))?.revision).toBe(2);
  expect((await journal.load(key))?.stage).toBe("prepared");
  expect((await readdir(directory)).sort()).toEqual(["journal.jsonl", "state.json"]);
  expect(await readdir(root)).toEqual(expect.arrayContaining(["lock.json", "runs"]));
 });
});

test("state is keyed per generation and an absent state is not confused with an empty one", async()=>{
 await withJournal(async(root)=>{
  const journal = await Journal.open(root);
  const key = runKey("18.8.9", "1", 1);
  const lock = await journal.acquire(key);
  expect(await journal.load(key)).toBeUndefined();
  await journal.save(initial(key), 0, lock);
  expect(await journal.load(runKey("18.8.9", "2", 1))).toBeUndefined();
  expect((await journal.load(key))?.revision).toBe(1);
 });
});

test("a new generation never overwrites an unfinished one and is unaffected by it", async()=>{
 await withJournal(async(root)=>{
  const effectFile = join(root, "effect.log");
  const journal = await Journal.open(root);
  const older = runKey("18.8.9", "1", 1);
  const newer = runKey("18.8.9", "1", 2);
  const firstLock = await journal.acquire(older);
  await journal.save({ ...initial(older), stage: "working" }, 0, firstLock);
  const first = await journal.effect({ ...initial(older), stage: "working", revision: 1 }, firstLock, "merge-pr", { number: 41 }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "merged 41\n");
   return { number: 41, mergeSha: sha("a") };
  });
  expect(first.revision).toBe(2);
  await journal.release(firstLock);

  const secondLock = await journal.acquire(newer);
  const second = await journal.effect(initial(newer), secondLock, "merge-pr", { number: 42 }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "merged 42\n");
   return { number: 42, mergeSha: sha("b") };
  });
  expect(second.effects[0]?.receipt).toEqual({ number: 42, mergeSha: sha("b") });
  expect(await countLines(effectFile)).toBe(2);
  expect((await journal.load(older))?.stage).toBe("working");
  expect((await journal.load(older))?.effects[0]?.receipt).toEqual({ number: 41, mergeSha: sha("a") });
  expect((await journal.load(newer))?.effects[0]?.receipt).toEqual({ number: 42, mergeSha: sha("b") });
  expect(await runDirs(root)).toHaveLength(2);
 });
});

test("a head move within one attempt keeps the journal identity and its receipt", async()=>{
 await withJournal(async(root)=>{
  const effectFile = join(root, "effect.log");
  const journal = await Journal.open(root);
  const key = runKey("18.8.9", "1", 1);
  const lock = await journal.acquire(key);
  const applied = await journal.effect(initial(key), lock, "create-pr", { number: 41 }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "pr created\n");
   return { number: 41, headSha: sha("a") };
  });
  const moved: MaintenanceState = { ...applied, pr: { ...applied.pr, headSha: sha("f") } };
  const rerun = await journal.effect(moved, lock, "create-pr", { number: 41 }, async()=>{ throw new Error("observe must not run"); }, async()=>{ throw new Error("apply must not rerun"); });
  expect(rerun.effects[0]?.receipt).toEqual({ number: 41, headSha: sha("a") });
  expect(await countLines(effectFile)).toBe(1);
  expect(await runDirs(root)).toHaveLength(1);
 });
});

test("a reused effect key with a different intent is refused instead of silently skipped", async()=>{
 await withJournal(async(root)=>{
  const effectFile = join(root, "effect.log");
  const journal = await Journal.open(root);
  const key = runKey("18.8.9", "3", 1);
  const lock = await journal.acquire(key);
  const done = await journal.effect(initial(key), lock, "merge-pr", { number: 41, headSha: sha("a") }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "merged 41\n");
   return { number: 41, mergeSha: sha("a") };
  });
  expect(done.revision).toBe(1);
  await expectJournalError(() => journal.effect(done, lock, "merge-pr", { number: 42, headSha: sha("b") }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "merged 42\n");
   return { number: 42, mergeSha: sha("b") };
  }), "effect-conflict");
  expect(await countLines(effectFile)).toBe(1);
 });
});

test("resume treats an effect as done only when the recorded intent matches", async()=>{
 await withJournal(async(root)=>{
  const effectFile = join(root, "effect.log");
  const journal = await Journal.open(root);
  const key = runKey("18.8.9", "4", 1);
  const lock = await journal.acquire(key);
  await journal.effect(initial(key), lock, "tag-release", { tag: "v18.8.9", sha: sha("c") }, async()=>({ kind: "absent" as const }), async()=>{
   await appendFile(effectFile, "tagged\n");
   return { tag: "v18.8.9", sha: sha("c") };
  });
  const resumed = await Journal.open(root);
  const loaded = await resumed.load(key);
  expect(loaded?.revision).toBe(1);
  const rerun = await resumed.effect(loaded!, lock, "tag-release", { tag: "v18.8.9", sha: sha("c") }, async()=>{ throw new Error("observe must not run when a matching receipt exists"); }, async()=>{ throw new Error("apply must not rerun when a matching receipt exists"); });
  expect(rerun.effects[0]?.receipt).toEqual({ tag: "v18.8.9", sha: sha("c") });
  expect(await countLines(effectFile)).toBe(1);
  await expectJournalError(() => resumed.effect(rerun, lock, "tag-release", { tag: "v18.8.9", sha: sha("d") }, async()=>({ kind: "absent" as const }), async()=>{ throw new Error("apply must not rerun on an intent conflict"); }), "effect-conflict");
  expect(await countLines(effectFile)).toBe(1);
 });
});

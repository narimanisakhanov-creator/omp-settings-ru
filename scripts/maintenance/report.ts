import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { asRecord, readString } from "./json";
import type { ReviewRow } from "./semantic";

export interface ReportRequest {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly reportPath: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly role: "reviewer";
}
export interface ReportBinding { readonly runId: string; readonly taskId: string; readonly dispatchId: string }
export interface ReviewerVerdict {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly role: "reviewer";
  readonly verdict: "approved" | "rejected";
  readonly headSha: string;
  readonly baseSha: string;
  readonly evidenceHashes: readonly string[];
  readonly reviewRows: readonly ReviewRow[];
}
export interface ReportProof {
  readonly request: ReportRequest;
  readonly binding: ReportBinding;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly reportSha256: string;
  readonly bytes: string;
  readonly verdict: ReviewerVerdict;
}
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** JSON.parse accepts duplicate keys; proof objects must have one unambiguous meaning. */
export function parseStrictReportJSON(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const frames: (Set<string> | undefined)[] = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === "{") frames.push(new Set());
    else if (value === "[") frames.push(undefined);
    else if (value === "}" || value === "]") frames.pop();
    else if (/^\s*:/.test(text.slice(token.index! + value.length))) {
      const keys = frames[frames.length - 1];
      const key: string = JSON.parse(value);
      if (!keys || keys.has(key)) throw new Error("worker-report-json-ambiguous");
      keys.add(key);
    }
  }
  return parsed;
}

export function parseReportRequest(value: unknown): ReportRequest | undefined {
  const row = asRecord(value);
  if (!row || Object.keys(row).sort().join(",") !== "baseSha,headSha,nonce,reportPath,role,schemaVersion"
    || row.schemaVersion !== 1 || row.role !== "reviewer" || typeof row.nonce !== "string" || !NONCE.test(row.nonce)
    || typeof row.headSha !== "string" || typeof row.baseSha !== "string" || !SHA40.test(row.headSha) || !SHA40.test(row.baseSha)
    || typeof row.reportPath !== "string" || !isAbsolute(row.reportPath) || resolve(row.reportPath) !== row.reportPath) return undefined;
  return row as unknown as ReportRequest;
}

/** Allocate only the immutable request; reviewer alone writes and hashes verdict bytes. */
export async function createReportRequest(stateDirectory: string, checkout: string, headSha: string, baseSha: string): Promise<ReportRequest> {
  const reports = resolve(stateDirectory, "reports");
  const inside = relative(resolve(checkout), reports);
  if (inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))) throw new Error("worker-report-path-inside-worktree");
  await mkdir(reports, { recursive: true, mode: 0o700 });
  if ((await lstat(reports)).isSymbolicLink() || resolve(await realpath(reports)) !== reports) throw new Error("worker-report-directory-unverifiable");
  const nonce = randomUUID();
  const request = parseReportRequest({ schemaVersion: 1, nonce, reportPath: join(reports, `${nonce}.verdict.json`), headSha, baseSha, role: "reviewer" });
  if (!request) throw new Error("worker-report-request-invalid");
  await writeFile(join(reports, `${nonce}.request.json`), JSON.stringify(request), { flag: "wx", mode: 0o600 });
  return request;
}

export async function loadReportRequest(requestPath: string, stateDirectory: string): Promise<ReportRequest> {
  const reports = resolve(stateDirectory, "reports");
  if (!isAbsolute(requestPath) || dirname(requestPath) !== reports || resolve(await realpath(reports)) !== reports
    || (await lstat(reports)).isSymbolicLink()) throw new Error("worker-report-request-untrusted");
  const bytes = await boundedFile(requestPath);
  const request = parseReportRequest(parseStrictReportJSON(bytes.toString("utf8")));
  if (!request || requestPath !== join(reports, `${request.nonce}.request.json`)
    || request.reportPath !== join(reports, `${request.nonce}.verdict.json`)) throw new Error("worker-report-request-untrusted");
  return request;
}

export async function bindReportRequest(requestPath: string, stateDirectory: string, binding: ReportBinding): Promise<void> {
  await loadReportRequest(requestPath, stateDirectory);
  if (!binding.runId || !binding.taskId || !binding.dispatchId) throw new Error("worker-report-binding-missing");
  await writeFile(`${requestPath}.binding.json`, JSON.stringify(binding), { flag: "wx", mode: 0o600 });
}

export async function loadReportBinding(requestPath: string, stateDirectory: string): Promise<ReportBinding> {
  await loadReportRequest(requestPath, stateDirectory);
  const row = asRecord(parseStrictReportJSON((await boundedFile(`${requestPath}.binding.json`)).toString("utf8")));
  const runId = readString(row, "runId"); const taskId = readString(row, "taskId"); const dispatchId = readString(row, "dispatchId");
  if (!row || Object.keys(row).sort().join(",") !== "dispatchId,runId,taskId" || !runId || !taskId || !dispatchId) throw new Error("worker-report-binding-missing");
  return { runId, taskId, dispatchId };
}

export function parseReviewerVerdict(text: string): ReviewerVerdict | undefined {
  let row: Record<string, unknown> | undefined;
  try { row = asRecord(parseStrictReportJSON(text)); } catch { return undefined; }
  if (!row || Object.keys(row).sort().join(",") !== "baseSha,evidenceHashes,headSha,nonce,reviewRows,role,schemaVersion,verdict"
    || row.schemaVersion !== 1 || row.role !== "reviewer" || typeof row.nonce !== "string" || !NONCE.test(row.nonce)
    || typeof row.verdict !== "string" || !["approved", "rejected"].includes(row.verdict)
    || typeof row.headSha !== "string" || typeof row.baseSha !== "string" || !SHA40.test(row.headSha) || !SHA40.test(row.baseSha)
    || !Array.isArray(row.evidenceHashes) || !row.evidenceHashes.length
    || !row.evidenceHashes.every(hash => typeof hash === "string" && SHA64.test(hash))
    || new Set(row.evidenceHashes).size !== row.evidenceHashes.length || !Array.isArray(row.reviewRows)) return undefined;
  const reviewRows: ReviewRow[] = [];
  for (const raw of row.reviewRows) {
    const entry = asRecord(raw);
    if (!entry || Object.keys(entry).sort().join(",") !== "path,platforms,reviewedAtVersion,sourceHash,translationHash") return undefined;
    const path = readString(entry, "path"); const sourceHash = readString(entry, "sourceHash");
    const translationHash = readString(entry, "translationHash"); const reviewedAtVersion = readString(entry, "reviewedAtVersion");
    const platforms = entry.platforms;
    if (!path || !sourceHash || !translationHash || !reviewedAtVersion || !SHA64.test(sourceHash) || !SHA64.test(translationHash)
      || !Array.isArray(platforms) || !platforms.length || !platforms.every(platform => ["win32", "linux", "darwin"].includes(platform))
      || new Set(platforms).size !== platforms.length) return undefined;
    reviewRows.push({ path, sourceHash, translationHash, reviewedAtVersion, platforms });
  }
  return { schemaVersion: 1, nonce: String(row.nonce), role: "reviewer", verdict: row.verdict as "approved" | "rejected",
    headSha: String(row.headSha), baseSha: String(row.baseSha), evidenceHashes: row.evidenceHashes as string[], reviewRows };
}

async function boundedFile(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_REPORT_BYTES
    || resolve(await realpath(path)) !== path) throw new Error("worker-report-file-unverifiable");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) throw new Error("worker-report-file-unverifiable");
    const buffer = Buffer.alloc(metadata.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== metadata.size || total > MAX_REPORT_BYTES) throw new Error("worker-report-file-unverifiable");
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== total || resolve(await realpath(dirname(path))) !== dirname(path)) throw new Error("worker-report-file-unverifiable");
    return buffer.subarray(0, total);
  } finally { await file.close(); }
}

export async function verifyReportFile(request: ReportRequest, reportSha256: string): Promise<{ bytes: string; verdict: ReviewerVerdict }> {
  if (!parseReportRequest(request) || !SHA64.test(reportSha256)) throw new Error("worker-report-metadata-unverifiable");
  const reports = dirname(request.reportPath);
  if ((await lstat(reports)).isSymbolicLink() || resolve(await realpath(reports)) !== reports) throw new Error("worker-report-directory-unverifiable");
  const bytes = await boundedFile(request.reportPath);
  if (createHash("sha256").update(bytes).digest("hex") !== reportSha256) throw new Error("worker-report-hash-mismatch");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const verdict = parseReviewerVerdict(text);
  if (!verdict || verdict.nonce !== request.nonce || verdict.role !== request.role || verdict.headSha !== request.headSha || verdict.baseSha !== request.baseSha) throw new Error("worker-report-verdict-unverifiable");
  return { bytes: text, verdict };
}

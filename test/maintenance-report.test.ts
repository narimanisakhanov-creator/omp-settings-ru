import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orca, type WorkerDelivery, type WorkerStatus } from "../scripts/maintenance/orca";
import { createReportRequest, type ReportBinding, type ReportRequest } from "../scripts/maintenance/report";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";

const policy = validatePolicy(rawPolicy);
const binding: ReportBinding = { runId: "run-review", taskId: "task-review", dispatchId: "dispatch-review" };
class FileOrca extends Orca {
  batch!: WorkerDelivery;
  status: WorkerStatus = { ...binding, outcome: "succeeded", completedAt: "2026-10-11T00:00:00Z", resource: { ownerDispatchId: binding.dispatchId, state: "owned", releaseState: "not_requested" } };
  override async delivery() { return this.batch; }
  override async observe() { return this.status; }
}
describe("exact capability-bound reviewer artifacts", () => {
  let root: string;
  let request: ReportRequest;
  let orca: FileOrca;
  let payload: Record<string, unknown>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "review-artifact-"));
    const checkout = join(root, "worktree");
    await mkdir(checkout);
    request = await createReportRequest(join(root, "state"), checkout, "a".repeat(40), "b".repeat(40));
    const bytes = JSON.stringify({ schemaVersion: 1, nonce: request.nonce, role: "reviewer", verdict: "approved", headSha: request.headSha, baseSha: request.baseSha, evidenceHashes: ["c".repeat(64)], reviewRows: [] });
    await writeFile(request.reportPath, bytes);
    payload = { ...binding, outcome: "succeeded", nonce: request.nonce, role: request.role, headSha: request.headSha, baseSha: request.baseSha, reportPath: request.reportPath, reportSha256: createHash("sha256").update(bytes).digest("hex") };
    orca = new FileOrca(policy, checkout);
    orca.batch = { runId: binding.runId, deliveryId: "delivery-review", messages: [{ id: "completion", run_id: binding.runId, type: "worker_done", body: "[clipped]", payload: JSON.stringify(payload) }] };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const deliver = () => { orca.batch.messages[0]!.payload = JSON.stringify(payload); };
  test("verifies actual bytes despite clipped or absent transcript body", async () => {
    const proof = await orca.readReport(request, binding);
    expect(proof.reportSha256).toBe(String(payload.reportSha256));
    expect(proof.verdict.nonce).toBe(request.nonce);
    expect(proof.deliveryId).toBe("delivery-review");
  });
  test("denies byte tampering before any remote mutation", async () => {
    await writeFile(request.reportPath, "{}");
    await expect(orca.readReport(request, binding)).rejects.toThrow("worker-report-hash-mismatch");
  });
  test("denies path nonce role head base and capability mismatch", async () => {
    for (const key of ["reportPath", "nonce", "role", "headSha", "baseSha", "dispatchId", "taskId"]) {
      const prior = payload[key]; payload[key] = "foreign"; deliver();
      await expect(orca.readReport(request, binding)).rejects.toThrow();
      payload[key] = prior; deliver();
    }
  });
  test("denies malformed clipped metadata and invalid hashes", async () => {
    orca.batch.messages[0]!.payload = '{"reportSha256":"';
    await expect(orca.readReport(request, binding)).rejects.toThrow();
    payload.reportSha256 = "c".repeat(63); deliver();
    await expect(orca.readReport(request, binding)).rejects.toThrow();
  });
  test("denies wrong settled ownership", async () => {
    orca.status = { ...orca.status, resource: { ownerDispatchId: "foreign", state: "owned", releaseState: "not_requested" } };
    await expect(orca.readReport(request, binding)).rejects.toThrow("worker-settlement-unproven");
  });
  test("denies symlink reports", async () => {
    await rm(request.reportPath);
    const target = join(root, "target.json"); await writeFile(target, "{}");
    await symlink(target, request.reportPath);
    await expect(orca.readReport(request, binding)).rejects.toThrow("worker-report-file-unverifiable");
  });
  test("denies foreign Run source and duplicate JSON metadata", async () => {
    orca.batch = { ...orca.batch, runId: "foreign" };
    await expect(orca.readReport(request, binding)).rejects.toThrow();
    orca.batch = { ...orca.batch, runId: binding.runId };
    orca.batch.messages[0]!.payload = JSON.stringify(payload).replace('{', '{"nonce":"foreign",');
    await expect(orca.readReport(request, binding)).rejects.toThrow("worker-report-metadata-unverifiable");
  });
  test("denies oversized regular files even with matching byte hash", async () => {
    const bytes = " ".repeat(4 * 1024 * 1024 + 1);
    await writeFile(request.reportPath, bytes);
    payload.reportSha256 = createHash("sha256").update(bytes).digest("hex"); deliver();
    await expect(orca.readReport(request, binding)).rejects.toThrow("worker-report-file-unverifiable");
  });
  test("denies hashed malformed schema and duplicate verdict fields", async () => {
    for (const bytes of ['{}', '{"nonce":"first","nonce":"second"}']) {
      await writeFile(request.reportPath, bytes);
      payload.reportSha256 = createHash("sha256").update(bytes).digest("hex"); deliver();
      await expect(orca.readReport(request, binding)).rejects.toThrow("worker-report-verdict-unverifiable");
    }
  });
});

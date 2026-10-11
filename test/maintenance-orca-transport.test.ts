import { describe, expect, test } from "bun:test";
import { Orca, type WorkerDelivery } from "../scripts/maintenance/orca";
import { validatePolicy } from "../scripts/maintenance/policy";
import rawPolicy from "../maintenance.config.json";
const policy = validatePolicy(rawPolicy);
const dispatch = "ctx_review";
class ReplayOrca extends Orca {
  readonly calls: string[][] = [];
  constructor(private readonly replies: Record<string, unknown>[]) { super(policy); }
  protected override async invoke(args: readonly string[]): Promise<Record<string, unknown>> {
    this.calls.push([...args]);
    const response = this.replies.shift();
    if (!response) throw new Error("unexpected-transport-call");
    return response;
  }
}
describe("version-matched Orca durable delivery transport", () => {
  test("decodes entire delivery batch and preserves next batch returned by acknowledgement", async () => {
    const batch = await Bun.file("test/fixtures/maintenance-orca-delivery.json").json();
    const orca = new ReplayOrca([batch, { ...batch, acknowledged: batch.deliveryId }]);
    const delivery = await orca.delivery(batch.runId);
    expect(delivery?.messages).toHaveLength(batch.messages.length);
    const next: WorkerDelivery | undefined = await orca.acknowledge(batch.runId, batch.deliveryId);
    expect(next?.messages[0]?.id).toBe(batch.messages[0].id);
    expect(orca.calls[0]).toContain(batch.runId);
  });
  test("release proves exact settled ownership and post-release projection", async () => {
    const show = (state: string, releaseState: string) => ({ dispatch: { id: dispatch, runId: "run-review", taskId: "task-review", completedAt: "2026-10-11T00:00:00Z" },
      worker: { state: "succeeded", worktreeId: "repo::evidence-tree" }, projection: { resource: { ownerDispatchId: dispatch, state, releaseState } } });
    const orca = new ReplayOrca([show("owned", "not_requested"), { state: "released" }, show("released", "released")]);
    await orca.release(dispatch);
    expect(orca.calls[1]).toEqual(["orchestration", "worker-release", "--dispatch", dispatch, "--json"]);
    const live = new ReplayOrca([{ dispatch: { id: dispatch, runId: "run-review", taskId: "task-review" }, worker: { state: "ready" } }]);
    await expect(live.release(dispatch)).rejects.toThrow("worker-release-unproven");
    expect(live.calls).toHaveLength(1);
  });
});

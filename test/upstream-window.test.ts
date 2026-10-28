import { expect, test } from "bun:test";
import { pendingWindowVersions, publishedStableVersions, selectUpstreamWindow } from "../scripts/maintenance/upstream-window";

test("selects three highest stable versions even when latest tag is stale", () => {
  expect(selectUpstreamWindow({
    "dist-tags": { latest: "18.13.3" },
    versions: { "18.13.1": {}, "18.13.2": {}, "18.13.3": {}, "18.13.4": {}, "18.13.5-rc.1": {} },
  })).toEqual(["18.13.2", "18.13.3", "18.13.4"]);
});

test("requires latest to be an exact stable published version", () => {
  expect(() => selectUpstreamWindow({ versions: { "18.13.1": {} }, "dist-tags": {} })).toThrow("registry-window-invalid");
  expect(() => selectUpstreamWindow({ versions: { "18.13.1": {} }, "dist-tags": { latest: "18.13.2" } })).toThrow("registry-window-invalid");
  expect(() => selectUpstreamWindow({ versions: { "18.13.1": {} }, "dist-tags": { latest: "18.13.1-rc.1" } })).toThrow("registry-window-invalid");
});

test("rejects malformed version entries and orders numerically", () => {
  expect(publishedStableVersions({ versions: { "18.9.0": {}, "18.10.0": {}, "18.10.0-rc.1": {} } })).toEqual(["18.9.0", "18.10.0"]);
  expect(() => publishedStableVersions({ versions: { "18.10.0": null } })).toThrow("registry-window-invalid");
});

test("queues only versions above the accepted pin", () => {
  expect(pendingWindowVersions(["18.13.5", "18.13.4", "18.13.3"], "18.13.3")).toEqual(["18.13.4", "18.13.5"]);
});

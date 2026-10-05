import { describe, expect, test } from "bun:test";
import { computeSourceHash, normalizeSource } from "../src/source";
import type { HostUiMetadata } from "../src/host-types";

const ui: HostUiMetadata = { tab: "general", label: "Completion", description: "Accept with Tab; move with Right", options: [{ value: "off", label: "Off" }] };

describe("source identity", () => {
  test("keybinding changes preserve identity only inside a reviewed template", () => {
    const template = "Accept with {accept}; move with {right}";
    expect(computeSourceHash(normalizeSource(ui, template))).toBe(computeSourceHash(normalizeSource({ ...ui, description: "Accept with Ctrl+A; move with Ctrl+R" }, template)));
    expect(computeSourceHash(normalizeSource({ ...ui, description: "Different behavior" }, template))).not.toBe(computeSourceHash(normalizeSource(ui, template)));
  });
  test("changed option values and warnings invalidate translation identity", () => {
    expect(computeSourceHash(normalizeSource({ ...ui, options: [{ value: "on", label: "Off" }] }))).not.toBe(computeSourceHash(normalizeSource(ui)));
    expect(computeSourceHash(normalizeSource({ ...ui, warning: "Danger" }))).not.toBe(computeSourceHash(normalizeSource(ui)));
  });
});

import { describe, expect, test } from "bun:test";
import { computeSourceHash, normalizeSource } from "../src/source";
import { descriptionTemplates } from "../src/source-templates";
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
  test("each accepted edition matches its own wording and an unmatched text stays raw", () => {
    const editions = descriptionTemplates["tui.mouse"]!;
    const oldEdition = editions[0]!;
    const newEdition = editions[1]!;
    const oldText = oldEdition.replaceAll("{shift}", "Shift");
    const newText = newEdition.replaceAll("{shift}", "Shift");

    expect(normalizeSource({ ...ui, description: oldText }, editions).description).toBe(oldEdition);
    expect(normalizeSource({ ...ui, description: newText }, editions).description).toBe(newEdition);
    expect(normalizeSource({ ...ui, description: "Different behavior" }, editions).description).toBe("Different behavior");
    // Editions are distinct identities: the older snapshot keeps its hash after a newer edition lands.
    expect(computeSourceHash(normalizeSource({ ...ui, description: oldText }, editions)))
      .not.toBe(computeSourceHash(normalizeSource({ ...ui, description: newText }, editions)));
  });
  test("a single template string behaves exactly like a one-edition list", () => {
    const template = "Accept with {accept}; move with {right}";
    for (const description of [ui.description, "Different behavior"]) {
      const single = normalizeSource({ ...ui, description }, template);
      expect(JSON.stringify(single)).toBe(JSON.stringify(normalizeSource({ ...ui, description }, [template])));
      expect(single.description).toBe(description === ui.description ? template : description);
    }
  });
});

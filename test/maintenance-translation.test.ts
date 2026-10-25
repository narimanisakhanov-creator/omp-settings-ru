import { describe, expect, test } from "bun:test";
import type { BaselineSnapshot } from "../src/report";
import type { LocalePack } from "../src/translations/types";
import { computeSourceHash } from "../src/source";
import { translateCandidate } from "../scripts/maintenance/translate";
import type { ModelJSONResponse, ModelMessage } from "../scripts/maintenance/model";

const source = { tab: "general", group: null, label: "Mode", description: "Choose {value}", warning: "Use {value} carefully", options: [{ value: "on", label: "On", description: "Enable {value}" }, { value: "off", label: "Off", description: null }] };
const hash = computeSourceHash(source);
const snapshot: BaselineSnapshot = { version: "18.9.0", platform: "linux", settings: { "test.mode": { ...source, sourceHash: hash } } };
const empty: LocalePack = { locale: "ru", settings: {} };
function response(value: unknown, bytes = JSON.stringify(value)): ModelJSONResponse { return { value, bytes, sha256: "a".repeat(64) }; }

describe("candidate translation", () => {
  test("translates one source identity and assigns trusted provenance without a reviewer", async () => {
    const calls: ModelMessage[][] = [];
    const request = async (messages: readonly ModelMessage[]) => {
      calls.push([...messages]);
      return response({ label: "Режим", description: "Выберите {value}", warning: "Используйте {value} осторожно", options: { on: { label: "Вкл", description: "Включить {value}" }, off: { label: "Выкл" } } });
    };
    const result = await translateCandidate({ candidateVersion: "18.9.0", snapshots: [snapshot], catalog: empty, request });
    const variant = result.catalog.settings["test.mode"]!.variants[0]!;
    expect(variant).toMatchObject({ sourceHash: hash, label: "Режим", description: "Выберите {value}", platforms: ["linux"], observedIn: ["18.9.0"] });
    expect(calls).toHaveLength(1);
    const glossary = await Bun.file(new URL("../docs/glossary.md", import.meta.url)).text();
    expect(JSON.parse(calls[0]![1]!.content).glossary).toBe(glossary);
  });

  test("rejects missing markers and changed option values without a second request", async () => {
    let calls = 0;
    const request = async (_messages: readonly ModelMessage[]) => { calls++; return response({ label: "Режим", description: "Выберите значение", warning: "Используйте {value}", options: { on: { label: "Вкл", description: "Включить {value}" }, changed: { label: "Нет" } } }); };
    await expect(translateCandidate({ candidateVersion: "18.9.0", snapshots: [snapshot], catalog: empty, request })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test("reuses existing translation and extends platforms without any model calls", async () => {
    const existing: LocalePack = { locale: "ru", settings: { "test.mode": { variants: [{ sourceHash: hash, label: "Режим", description: "Выберите {value}", warning: "Используйте {value} осторожно", options: { on: { label: "Вкл", description: "Включить {value}" }, off: { label: "Выкл" } }, platforms: ["win32"], observedIn: ["18.8.7"] }] } } };
    const calls: ModelMessage[][] = [];
    const request = async (messages: readonly ModelMessage[]) => { calls.push([...messages]); throw new Error("unexpected-model-request"); };
    const result = await translateCandidate({ candidateVersion: "18.9.0", snapshots: [{ ...snapshot, platform: "win32" }, snapshot], catalog: existing, request });
    expect(calls).toHaveLength(0);
    expect(result.catalog.settings["test.mode"]!.variants[0]!.platforms).toEqual(["linux", "win32"]);
    expect(result.catalog.settings["test.mode"]!.variants[0]!.observedIn).toEqual(["18.8.7", "18.9.0"]);
  });
  test("retains historical platform coverage and merges split same-source variants without model calls", async () => {
    const translated = { sourceHash: hash, label: "Режим", description: "Выберите {value}" };
    const catalog: LocalePack = { locale: "ru", settings: { "test.mode": { variants: [
      { ...translated, platforms: ["win32"], observedIn: ["18.8.0"] },
      { ...translated, platforms: ["linux"], observedIn: ["18.8.7"] },
    ] } } };
    const request = async (_messages: readonly ModelMessage[]) => { throw new Error("unexpected-model-request"); };
    const result = await translateCandidate({ candidateVersion: "18.9.0", snapshots: [snapshot], catalog, request });
    expect(result.catalog.settings["test.mode"]!.variants).toEqual([{ ...translated, platforms: ["linux", "win32"], observedIn: ["18.8.0", "18.8.7", "18.9.0"] }]);
  });

  test("passes prior same-path translation only to translator and preserves old identity", async () => {
    const prior = { sourceHash: "c".repeat(64), label: "Старый режим", description: "Старое описание", platforms: ["linux" as const], observedIn: ["18.8.7"] };
    const catalog: LocalePack = { locale: "ru", settings: { "test.mode": { variants: [prior] } } };
    const payloads: Record<string, unknown>[] = [];
    const request = async (messages: readonly ModelMessage[]) => {
      payloads.push(JSON.parse(messages[1]!.content));
      return response({ label: "Режим", description: "Выберите {value}", warning: "Используйте {value} осторожно", options: { off: { label: "Выкл" }, on: { description: "Включить {value}", label: "Вкл" } } });
    };
    const result = await translateCandidate({ candidateVersion: "18.9.0", snapshots: [snapshot], catalog, request });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.previous).toEqual({ label: prior.label, description: prior.description });
    expect(result.catalog.settings["test.mode"]!.variants[0]).toEqual(prior);
    expect(Object.keys(result.catalog.settings["test.mode"]!.variants[1]!.options!)).toEqual(["on", "off"]);
  });
});

import { expect, test } from "bun:test";
import type { HostMetadata } from "../src/host-types";
import type { LocalePack } from "../src/translations/types";
import { computeSourceHash, normalizeSource } from "../src/source";
import { LanguageController } from "../src/language-controller";

function fixture() {
  const ui = { tab: "interaction", label: "Mode", description: "Choose mode" };
  const host: HostMetadata = { version: "18.6.1", platform: "win32", schema: { mode: { type: "boolean", default: false, ui } } };
  const pack: LocalePack = { locale: "ru", sourceOmpVersion: "18.6.1", settings: { mode: { sourceHash: computeSourceHash(normalizeSource(ui)), label: "Режим", description: "Выберите режим" } } };
  return { ui, controller: new LanguageController(async () => host, pack) };
}

test("child transitions and shutdown cannot undo main-session language", async () => {
  const { ui, controller } = fixture();
  await controller.setLanguage("ru", "main");
  expect(ui.label).toBe("Режим");
  await controller.setLanguage("en", "task");
  await controller.shutdown("task");
  expect(ui.label).toBe("Режим");
  await controller.shutdown("main");
  expect(ui.label).toBe("Mode");
});

test("queued language choices finish in user order, then restore on shutdown", async () => {
  const { ui, controller } = fixture();
  await Promise.all([controller.setLanguage("ru", "main"), controller.setLanguage("en", "main"), controller.setLanguage("ru", "main")]);
  expect(ui.label).toBe("Режим");
  await controller.setLanguage("ru", "main");
  await controller.setLanguage("en", "main");
  expect(ui.label).toBe("Mode");
});

test("incompatible hosts warn in Russian without exposing source exception details", async () => {
  const host: HostMetadata = { version: "99.0.0", platform: "win32", schema: {} };
  const pack: LocalePack = { locale: "ru", sourceOmpVersion: "18.6.1", settings: {} };
  const controller = new LanguageController(async () => host, pack);
  expect(await controller.setLanguage("ru", "main")).toMatch(/[а-я]/i);
  expect(controller.language).toBe("en");
  const unavailable = new LanguageController(async () => { throw new Error("private-machine-path"); }, pack);
  expect(await unavailable.setLanguage("ru", "main")).not.toContain("private-machine-path");
});

test("unfinished rollback remains pending until English or shutdown restores it", async () => {
  for (const viaShutdown of [false, true]) {
    const ui = { tab: "interaction", label: "Mode", description: "Choose mode" };
    let rejecting = true;
    const proxy = new Proxy(ui, { defineProperty(target, key, descriptor) {
      if (rejecting && (key === "description" || key === "label" && descriptor.value === "Mode")) return false;
      return Reflect.defineProperty(target, key, descriptor);
    } });
    const host: HostMetadata = { version: "18.6.1", platform: "win32", schema: { mode: { type: "boolean", default: false, ui: proxy } } };
    const pack: LocalePack = { locale: "ru", sourceOmpVersion: "18.6.1", settings: { mode: { sourceHash: computeSourceHash(normalizeSource(ui)), label: "Режим", description: "Выберите режим" } } };
    const controller = new LanguageController(async () => host, pack);
    expect(await controller.setLanguage("ru", "main")).toBeDefined();
    expect(ui.label).toBe("Режим");
    expect(controller.restorationPending).toBe(true);
    expect(await controller.setLanguage("en", "main")).toBeDefined();
    rejecting = false;
    expect(await (viaShutdown ? controller.shutdown("main") : controller.setLanguage("en", "main"))).toBeUndefined();
    expect(ui.label).toBe("Mode");
    expect(ui.description).toBe("Choose mode");
    expect(controller.restorationPending).toBe(false);
  }
});

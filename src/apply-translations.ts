// Adapted from omp-settings-zh, MIT License, Copyright (c) 2026 Elazer.
// Descriptor ownership, source matching, and atomic rollback hardened for this plugin.
import type { HostMetadata, HostUiMetadata, HostOption } from "./host-types";
import type { LocalePack, SettingTranslationFields, OptionTranslation } from "./translations/types";
import { checkHostCompatibility } from "./compatibility";
import { captureHints, computeSourceHash, normalizeSource } from "./source";

export type ApplyTranslationsResult =
  | { status: "applied"; mutationCount: number; restore: () => readonly string[] }
  | { status: "skipped"; reason: string }
  | { status: "rolled-back"; reason: string; rollbackErrors: readonly string[]; restore: () => readonly string[] };

interface Mutation {
  target: object;
  key: string;
  before: PropertyDescriptor | undefined;
  after: PropertyDescriptor;
  restoreCheck?: () => boolean;
  done: boolean;
}
interface ActiveApplication {
  pack: LocalePack;
  result: Extract<ApplyTranslationsResult, { status: "applied" | "rolled-back" }>;
}
const active = new WeakMap<object, ActiveApplication>();

/** Full descriptor identity, not value identity, defines ownership. */
function sameDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): boolean {
  if (!left || !right) return left === right;
  return left.configurable === right.configurable && left.enumerable === right.enumerable
    && left.writable === right.writable && Object.is(left.value, right.value)
    && left.get === right.get && left.set === right.set;
}

function sameDescriptors(target: object, expected: PropertyDescriptorMap): boolean {
  const keys = Reflect.ownKeys(target);
  return keys.length === Reflect.ownKeys(expected).length
    && keys.every(key => sameDescriptor(Object.getOwnPropertyDescriptor(target, key), Reflect.get(expected, key)));
}

function queueField(mutations: Mutation[], target: object, key: string, value: string | HostOption[], source?: string): void {
  const before = Object.getOwnPropertyDescriptor(target, key);
  if (!before && key in target) throw new Error("unsafe-property");
  if (!before && !Object.isExtensible(target)) throw new Error("unsafe-property");
  let after: PropertyDescriptor;
  if (before && !("value" in before)) {
    // Setters can mutate untracked state; only reviewed live description getters are safe.
    if (key !== "description" || !source || !before.get || before.set || !before.configurable || typeof value !== "string") {
      throw new Error("unsafe-property");
    }
    const originalGetter = before.get;
    const localizedTemplate = value;
    const getter = function (this: object): string {
      const english: unknown = originalGetter.call(this);
      if (typeof english !== "string") return english as string;
      const hints = captureHints(english, source);
      return hints ? localizedTemplate.replace(/\{([a-zA-Z]+)\}/g, (token, name: string) => hints[name] ?? token) : english;
    };
    after = { ...before, get: getter };
  } else {
    if (before && Object.is(before.value, value)) return;
    if (before && !before.writable) throw new Error("unsafe-property");
    after = before ? { ...before, value } : { value, writable: true, configurable: true, enumerable: true };
  }
  mutations.push({ target, key, before, after, done: false });
}

function queueText(mutations: Mutation[], target: object, fields: SettingTranslationFields | OptionTranslation): void {
  if (fields.label !== undefined) queueField(mutations, target, "label", fields.label);
  if (fields.description !== undefined) {
    queueField(mutations, target, "description", fields.description, "descriptionSource" in fields ? fields.descriptionSource : undefined);
  }
  if ("warning" in fields && fields.warning !== undefined) queueField(mutations, target, "warning", fields.warning);
}

function buildPlan(host: HostMetadata, pack: LocalePack): Mutation[] {
  const targets = new Map<HostUiMetadata, SettingTranslationFields>();
  for (const [path, base] of Object.entries(pack.settings)) {
    const entry = base.byPlatform?.[host.platform] ?? base;
    const ui = host.schema[path]?.ui;
    if (!ui || computeSourceHash(normalizeSource(ui, entry.descriptionSource)) !== entry.sourceHash) continue;
    const existing = targets.get(ui);
    if (!existing) {
      targets.set(ui, { ...entry, options: entry.options ? { ...entry.options } : undefined });
      continue;
    }
    const merged = { ...existing };
    for (const key of ["label", "description", "descriptionSource", "warning"] as const) {
      const incoming = entry[key];
      if (incoming === undefined) continue;
      if (merged[key] !== undefined && merged[key] !== incoming) throw new Error("conflicting-translations");
      merged[key] = incoming;
    }
    const options: Record<string, OptionTranslation> = { ...existing.options };
    for (const [value, incoming] of Object.entries(entry.options ?? {})) {
      const prior = options[value];
      for (const key of ["label", "description"] as const) {
        if (prior?.[key] !== undefined && incoming[key] !== undefined && prior[key] !== incoming[key]) {
          throw new Error("conflicting-translations");
        }
      }
      options[value] = { ...prior, ...incoming };
    }
    merged.options = options;
    targets.set(ui, merged);
  }
  const mutations: Mutation[] = [];
  for (const [ui, entry] of targets) {
    queueText(mutations, ui, entry);
    const options = ui.options;
    if (!Array.isArray(options) || !entry.options) continue;
    const fields: Mutation[] = [];
    // Clone every display option, retaining prototypes and non-display metadata.
    const copies = options.map(option => Object.create(Object.getPrototypeOf(option), Object.getOwnPropertyDescriptors(option)) as HostOption);
    const originalCopies = copies.map(option => Object.getOwnPropertyDescriptors(option));
    for (const copy of copies) {
      const translation = entry.options[copy.value];
      if (translation) queueText(fields, copy, translation);
    }
    if (!fields.length) continue;
    const arrayDescriptors = Object.getOwnPropertyDescriptors(copies as object);
    queueField(mutations, ui, "options", copies);
    const replacement = mutations[mutations.length - 1]!;
    // Fields restore first. Discard copies only if no foreign array/option edit remains.
    replacement.restoreCheck = () => sameDescriptors(copies, arrayDescriptors)
      && copies.every((copy, index) => sameDescriptors(copy, originalCopies[index]!));
    mutations.push(...fields);
  }
  return mutations;
}

function restoreMutations(mutations: readonly Mutation[], lastIndex: number, ownedOnly: boolean): string[] {
  const errors: string[] = [];
  for (let index = lastIndex; index >= 0; index--) {
    const mutation = mutations[index]!;
    if (mutation.done) continue;
    try {
      const current = Object.getOwnPropertyDescriptor(mutation.target, mutation.key);
      if (sameDescriptor(current, mutation.before)) {
        mutation.done = true;
        continue;
      }
      if (ownedOnly && !sameDescriptor(current, mutation.after)) {
        mutation.done = true;
        continue;
      }
      if (ownedOnly && mutation.restoreCheck && !mutation.restoreCheck()) {
        // A failed child restoration must be retried before judging the display copy foreign.
        if (errors.length) continue;
        mutation.done = true;
        continue;
      }
      const restored = mutation.before
        ? Reflect.defineProperty(mutation.target, mutation.key, mutation.before)
        : Reflect.deleteProperty(mutation.target, mutation.key);
      if (!restored || !sameDescriptor(Object.getOwnPropertyDescriptor(mutation.target, mutation.key), mutation.before)) {
        if (errors.length < 8) errors.push("restore-failed");
      } else mutation.done = true;
    } catch {
      if (errors.length < 8) errors.push("restore-failed");
    }
  }
  return errors;
}

export function applyTranslations(host: HostMetadata, pack: LocalePack): ApplyTranslationsResult {
  const compatibility = checkHostCompatibility(host);
  if (!compatibility.compatible) return { status: "skipped", reason: compatibility.reason };
  if (pack.locale !== "ru" || pack.sourceOmpVersion !== "18.6.1") return { status: "skipped", reason: "unsupported-locale-pack" };
  const previous = active.get(host.schema);
  if (previous) return previous.pack === pack ? previous.result : { status: "skipped", reason: "translation-already-active" };
  let mutations: Mutation[];
  try {
    mutations = buildPlan(host, pack);
  } catch (error) {
    const code = error instanceof Error && (error.message === "unsafe-property" || error.message === "conflicting-translations")
      ? error.message : "plan-failed";
    return { status: "skipped", reason: code };
  }
  let attempted = -1;
  try {
    for (let index = 0; index < mutations.length; index++) {
      const mutation = mutations[index]!;
      if (!sameDescriptor(Object.getOwnPropertyDescriptor(mutation.target, mutation.key), mutation.before)) throw new Error("write-failed");
      attempted = index;
      if (!Reflect.defineProperty(mutation.target, mutation.key, mutation.after)) throw new Error("write-failed");
    }
    for (const mutation of mutations) {
      if (!sameDescriptor(Object.getOwnPropertyDescriptor(mutation.target, mutation.key), mutation.after)) throw new Error("write-failed");
    }
    const result: Extract<ApplyTranslationsResult, { status: "applied" }> = {
      status: "applied", mutationCount: mutations.length,
      restore: () => {
        const errors = restoreMutations(mutations, mutations.length - 1, true);
        if (!errors.length && active.get(host.schema)?.result === result) active.delete(host.schema);
        return errors;
      },
    };
    active.set(host.schema, { pack, result });
    return result;
  } catch {
    const rollbackErrors = restoreMutations(mutations, attempted, false);
    const result: Extract<ApplyTranslationsResult, { status: "rolled-back" }> = {
      status: "rolled-back", reason: "write-failed", rollbackErrors,
      restore: () => {
        const errors = restoreMutations(mutations, attempted, true);
        if (!errors.length && active.get(host.schema)?.result === result) active.delete(host.schema);
        return errors;
      },
    };
    if (rollbackErrors.length) active.set(host.schema, { pack, result });
    return result;
  }
}

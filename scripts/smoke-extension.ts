// Smoke: drives the real host registry through three ru/en cycles and proves every descriptor, object
// identity, option source and non-display field survives unchanged. Reads only host metadata through the
// host adapter; no configuration files, sessions, credentials or environment values are touched.
import { applyTranslations } from "../src/apply-translations";
import { getHostMetadata } from "../src/host-adapter";
import type { HostMetadata } from "../src/host-types";
import { ru } from "../src/translations/ru";

interface Watched {
  path: string;
  definition: object;
  ui: object;
  options: object | null;
  optionObjects: readonly object[];
}

interface Observation {
  schemaMap: PropertyDescriptorMap;
  maps: Map<object, PropertyDescriptorMap>;
  displaySurfaces: Set<object>;
  watched: readonly Watched[];
  fields: Map<object, { type: unknown; default: unknown; values: unknown }>;
  schemaKeys: readonly PropertyKey[];
}

/** Independent verifier: lists keys whose descriptor no longer matches the recorded one. */
function descriptorDiff(target: object, expected: PropertyDescriptorMap): string[] {
  const keys = Reflect.ownKeys(target);
  const expectedKeys = Reflect.ownKeys(expected);
  if (keys.length !== expectedKeys.length) return ["key-count"];
  const differing: string[] = [];
  for (const key of keys) {
    const left = Object.getOwnPropertyDescriptor(target, key);
    const right = Reflect.get(expected, key) as PropertyDescriptor | undefined;
    if (!left || !right) {
      if (left !== right) differing.push(String(key));
      continue;
    }
    if (
      left.configurable !== right.configurable ||
      left.enumerable !== right.enumerable ||
      left.writable !== right.writable ||
      !Object.is(left.value, right.value) ||
      left.get !== right.get ||
      left.set !== right.set
    ) {
      differing.push(String(key));
    }
  }
  return differing;
}

function descriptorMap(target: object): PropertyDescriptorMap {
  const map: PropertyDescriptorMap = {};
  for (const key of Reflect.ownKeys(target)) map[key as string] = Object.getOwnPropertyDescriptor(target, key)!;
  return map;
}

function observe(host: HostMetadata): Observation {
  const maps = new Map<object, PropertyDescriptorMap>();
  const displaySurfaces = new Set<object>();
  const watched: Watched[] = [];
  const fields = new Map<object, { type: unknown; default: unknown; values: unknown }>();
  const seen = new Set<object>();

  const watch = (target: object): void => {
    if (seen.has(target)) return;
    seen.add(target);
    maps.set(target, descriptorMap(target));
  };

  for (const path of Object.keys(host.schema)) {
    const definition = host.schema[path];
    if (!definition) continue;
    const ui = definition.ui;
    if (!ui) continue;
    watch(definition);
    watch(ui);
    displaySurfaces.add(ui);
    const options = Array.isArray(ui.options) ? ui.options : null;
    if (options) {
      watch(options);
      displaySurfaces.add(options);
    }
    for (const option of options ?? []) {
      watch(option);
      displaySurfaces.add(option);
    }
    fields.set(definition, { type: definition.type, default: definition.default, values: definition.values });
    watched.push({ path, definition, ui, options, optionObjects: options ?? [] });
  }

  watch(host.schema);
  return { schemaMap: descriptorMap(host.schema), maps, displaySurfaces, watched, fields, schemaKeys: Reflect.ownKeys(host.schema) };
}

/**
 * Verifies one stage. Non-display objects (schema and definitions) and the ui/option identities must be
 * untouched in every stage; display surfaces only need to be fully restored, so their descriptor drift is
 * counted while translated and asserted equal after restore.
 */
function verify(host: HostMetadata, before: Observation, stage: string, failures: string[]): number {
  let translatedFields = 0;
  for (const key of before.schemaKeys) {
    if (!Object.is(host.schema[key as string], before.schemaMap[key as string]?.value)) {
      failures.push(`${stage}:schema-key`);
      return translatedFields;
    }
  }
  for (const watched of before.watched) {
    const live = host.schema[watched.path];
    if (!live || !Object.is(live, watched.definition)) {
      failures.push(`${stage}:definition-identity`);
      continue;
    }
    if (!live.ui || !Object.is(live.ui, watched.ui)) {
      failures.push(`${stage}:ui-identity`);
      continue;
    }
    const expectedFields = before.fields.get(watched.definition);
    if (
      expectedFields &&
      (live.type !== expectedFields.type ||
        !Bun.deepEquals(live.default, expectedFields.default) ||
        !Bun.deepEquals(live.values, expectedFields.values))
    ) {
      failures.push(`${stage}:non-display-fields`);
    }

    const uiMap = before.maps.get(watched.ui);
    if (uiMap) {
      const differing = descriptorDiff(watched.ui, uiMap);
      translatedFields += differing.length;
      if (stage === "restored" && differing.length > 0) failures.push(`${stage}:ui-descriptor:${watched.path}:${differing.join(",")}`);
    }

    if (stage !== "restored") continue;
    if (watched.options && !Object.is(live.ui.options, watched.options)) failures.push(`${stage}:options-identity`);
    if (watched.options && Array.isArray(live.ui.options)) {
      if (live.ui.options.length !== watched.optionObjects.length) failures.push(`${stage}:options-length`);
      else if (!live.ui.options.every((option, index) => Object.is(option, watched.optionObjects[index]))) {
        failures.push(`${stage}:option-identity`);
      }
    }
    for (const option of watched.optionObjects) {
      const optionMap = before.maps.get(option);
      if (optionMap && descriptorDiff(option, optionMap).length > 0) failures.push(`${stage}:option-descriptor:${watched.path}`);
    }
  }
  for (const [target, expected] of before.maps) {
    if (before.displaySurfaces.has(target)) continue;
    if (descriptorDiff(target, expected).length > 0) failures.push(`${stage}:descriptor`);
  }
  return translatedFields;
}

const host = await getHostMetadata();
const failures: string[] = [];
const before = observe(host);
const catalogPaths = Object.keys(ru.settings).length;
let totalMutations = 0;
let translatedFields = 0;

for (let cycle = 1; cycle <= 3; cycle++) {
  const applied = applyTranslations(host, ru);
  if (applied.status !== "applied") {
    failures.push(`cycle-${cycle}:${applied.status}:${applied.reason}`);
    break;
  }
  totalMutations += applied.mutationCount;
  const changed = verify(host, before, "applied", failures);
  if (changed === 0) failures.push(`cycle-${cycle}:no-visible-change`);
  translatedFields += changed;

  const restoreErrors = applied.restore();
  if (restoreErrors.length > 0) failures.push(`cycle-${cycle}:restore:${restoreErrors.join(",")}`);
  if (verify(host, before, "restored", failures) !== 0) failures.push(`cycle-${cycle}:restore-incomplete`);
  if (applied.restore().length > 0) failures.push(`cycle-${cycle}:restore-not-idempotent`);
}

console.log(
  JSON.stringify(
    {
      hostVersion: host.version,
      platform: host.platform,
      catalogPaths,
      uiSettings: before.watched.length,
      cycles: 3,
      totalMutations,
      translatedFields,
      failureCount: failures.length,
      failures: failures.slice(0, 32),
      ok: failures.length === 0,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exit(1);

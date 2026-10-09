import type { HostUiMetadata } from "../host-types";
import { computeSourceHash, normalizeSource } from "../source";
import type { SettingTranslation, SourceVariant } from "./types";

/** One cache per application/report; never hashes in the rendering getter. */
export type SourceHashCache = WeakMap<HostUiMetadata, Map<string | undefined, string>>;
export function resolveVariant(entry: SettingTranslation, ui: HostUiMetadata, platform: string, cache: SourceHashCache): SourceVariant | undefined {
  let hashes = cache.get(ui);
  if (!hashes) { hashes = new Map(); cache.set(ui, hashes); }
  let selected: SourceVariant | undefined;
  for (const variant of entry.variants) {
    if (!variant.platforms.some(candidate => candidate === platform)) continue;
    let hash = hashes.get(variant.descriptionSource);
    if (hash === undefined) {
      hash = computeSourceHash(normalizeSource(ui, variant.descriptionSource));
      hashes.set(variant.descriptionSource, hash);
    }
    if (hash !== variant.sourceHash) continue;
    if (selected && selected !== variant && !sameTranslation(selected, variant)) throw new Error("ambiguous-source-variant");
    selected = variant;
  }
  return selected;
}
function sameTranslation(left: SourceVariant, right: SourceVariant): boolean {
  for (const key of ["label", "description", "descriptionSource", "warning"] as const) if (left[key] !== right[key]) return false;
  const a = left.options;
  const b = right.options;
  if (a === b) return true;
  if (!a || !b || Object.keys(a).length !== Object.keys(b).length) return false;
  for (const value in a) if (a[value]!.label !== b[value]?.label || a[value]!.description !== b[value]?.description) return false;
  return true;
}

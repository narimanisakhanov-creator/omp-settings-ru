// Builds source-aware reports for translation changes.
import type { HostMetadata } from "./host-types";
import { computeSourceHash, normalizeSource, type SourceMetadata } from "./source";
import { descriptionTemplates } from "./source-templates";
import type { LocalePack, OptionTranslation } from "./translations/types";
import { resolveVariant, type SourceHashCache } from "./translations/resolve";

export interface OptionMismatch {
  readonly path: string;
  readonly missingValues: readonly string[];
  readonly staleValues: readonly string[];
}

export interface CoverageReport {
  readonly totalUiSettings: number;
  readonly translatedSettings: number;
  readonly completeSettings: number;
  readonly partialSettings: number;
  readonly untranslatedPaths: readonly string[];
  readonly partialPaths: readonly string[];
  readonly stalePaths: readonly string[];
  readonly optionMismatches: readonly OptionMismatch[];
  readonly sourceHashMismatches: readonly string[];
}


/** Baseline shape written by scripts/export-source.ts for a fixed host version and platform. */
export interface BaselineSnapshot {
  readonly version: string;
  readonly platform: string;
  readonly settings: Readonly<Record<string, SourceMetadata & { readonly sourceHash: string }>>;
}

export interface DriftReport {
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly changedPaths: readonly string[];
}

/**
 * Captures the reviewed display identity of every setting that has a ui block. Platform-independent:
 * platform differences live in the catalog, not in the host schema.
 */
export function buildSourceSnapshot(host: HostMetadata): BaselineSnapshot {
  const settings: Record<string, SourceMetadata & { readonly sourceHash: string }> = {};
  for (const path of Object.keys(host.schema).sort()) {
    const ui = host.schema[path]?.ui;
    if (!ui) continue;
    const source = normalizeSource(ui, descriptionTemplates[path]);
    settings[path] = { sourceHash: computeSourceHash(source), ...source };
  }
  return { version: host.version, platform: host.platform, settings };
}

/** Compares the current host registry against a reviewed baseline; any difference is reported explicitly. */
export function buildDriftReport(host: HostMetadata, baseline: BaselineSnapshot): DriftReport {
  const current = buildSourceSnapshot(host).settings;
  const addedPaths: string[] = [];
  const changedPaths: string[] = [];
  for (const path of Object.keys(current)) {
    const before = baseline.settings[path];
    if (!before) {
      addedPaths.push(path);
      continue;
    }
    // sourceHash covers every normalized field, so a hash difference is exactly a source difference.
    if (before.sourceHash !== current[path]!.sourceHash) changedPaths.push(path);
  }
  const removedPaths = Object.keys(baseline.settings).filter((path) => !current[path]).sort();
  return { addedPaths, removedPaths, changedPaths };
}

function optionMismatch(
  path: string,
  sourceOptions: SourceMetadata["options"],
  translations: Readonly<Record<string, OptionTranslation>> | undefined,
): OptionMismatch | undefined {
  const translated = translations ?? {};
  const missingValues: string[] = [];
  if (Array.isArray(sourceOptions)) {
    for (const option of sourceOptions) {
      const candidate = translated[option.value];
      if (!candidate?.label || (option.description !== null && !candidate.description)) missingValues.push(option.value);
    }
  }
  const sourceValues = new Set(Array.isArray(sourceOptions) ? sourceOptions.map((option) => option.value) : []);
  const staleValues = Object.keys(translated).filter((value) => !sourceValues.has(value));
  if (missingValues.length === 0 && staleValues.length === 0) return undefined;
  return { path, missingValues, staleValues };
}

export function buildCoverageReport(host: HostMetadata, locale: LocalePack): CoverageReport {
  const untranslatedPaths: string[] = [];
  const partialPaths: string[] = [];
  const optionMismatches: OptionMismatch[] = [];
  const sourceHashMismatches: string[] = [];
  let totalUiSettings = 0;
  let translatedSettings = 0;
  let completeSettings = 0;

  const hashes: SourceHashCache = new WeakMap();
  for (const path of Object.keys(host.schema).sort()) {
    const ui = host.schema[path]?.ui;
    if (!ui) continue;
    totalUiSettings += 1;

    const entry = locale.settings[path];
    const translation = entry ? resolveVariant(entry, ui, host.platform, hashes) : undefined;
    if (!translation) {
      untranslatedPaths.push(path);
      if (entry?.variants.some(variant => variant.platforms.some(platform => platform === host.platform))) sourceHashMismatches.push(path);
      continue;
    }
    translatedSettings += 1;

    const reviewedTemplate = descriptionTemplates[path];
    const source = normalizeSource(ui, translation.descriptionSource);
    let complete = true;

    if (translation.sourceHash !== computeSourceHash(source)) {
      sourceHashMismatches.push(path);
      complete = false;
    }
    // The warning translation is required exactly when the reviewed source carries a warning, and a
    // catalog entry may claim a reviewed template only for a path that has one.
    if (
      !translation.label ||
      !translation.description ||
      (source.warning === null ? translation.warning !== undefined : !translation.warning) ||
      translation.descriptionSource !== reviewedTemplate
    ) {
      complete = false;
    }

    const mismatch = optionMismatch(path, source.options, translation.options);
    if (mismatch) {
      optionMismatches.push(mismatch);
      complete = false;
    }

    if (complete) completeSettings += 1;
    else partialPaths.push(path);
  }

  const stalePaths = Object.keys(locale.settings)
    .filter((path) => !host.schema[path]?.ui)
    .sort();
  return {
    totalUiSettings,
    translatedSettings,
    completeSettings,
    partialSettings: partialPaths.length,
    untranslatedPaths,
    partialPaths,
    stalePaths,
    optionMismatches,
    sourceHashMismatches,
  };
}

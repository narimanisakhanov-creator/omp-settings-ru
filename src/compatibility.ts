// Adapted from omp-settings-zh, MIT License, Copyright (c) 2026 Elazer.
import type { HostMetadata } from "./host-types";

export type CompatibilityResult = { compatible: true } | { compatible: false; reason: string };

/** Structure validation is not a claim of support beyond the reviewed baseline. */
export function checkHostCompatibility(host: HostMetadata): CompatibilityResult {
  try {
    if (host.version !== "18.6.1") return { compatible: false, reason: "unsupported-host-version" };
    if (typeof host.platform !== "string" || !host.platform) return { compatible: false, reason: "invalid-host-platform" };
    if (typeof host.schema !== "object" || host.schema === null || Array.isArray(host.schema)) {
      return { compatible: false, reason: "invalid-host-schema" };
    }
    for (const definition of Object.values(host.schema)) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)
        || typeof definition.type !== "string" || !("default" in definition)) {
        return { compatible: false, reason: "invalid-setting-definition" };
      }
      const ui = definition.ui;
      if (ui === undefined) continue;
      if (!ui || typeof ui !== "object" || Array.isArray(ui) || typeof ui.tab !== "string"
        || typeof ui.label !== "string" || typeof ui.description !== "string"
        || (ui.group !== undefined && typeof ui.group !== "string")
        || (ui.warning !== undefined && typeof ui.warning !== "string")) {
        return { compatible: false, reason: "invalid-ui-metadata" };
      }
      if (ui.options !== undefined && ui.options !== "runtime") {
        if (!Array.isArray(ui.options)) return { compatible: false, reason: "invalid-ui-options" };
        const values = new Set<string>();
        for (const option of ui.options) {
          if (!option || typeof option !== "object" || Array.isArray(option)
            || typeof option.value !== "string" || typeof option.label !== "string"
            || (option.description !== undefined && typeof option.description !== "string")
            || values.has(option.value)) return { compatible: false, reason: "invalid-ui-options" };
          values.add(option.value);
        }
      }
    }
    return { compatible: true };
  } catch {
    return { compatible: false, reason: "host-read-failed" };
  }
}

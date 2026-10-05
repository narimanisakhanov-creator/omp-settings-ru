import { createHash } from "node:crypto";
import type { HostUiMetadata } from "./host-types";

export interface SourceMetadata {
  tab: string;
  group: string | null;
  label: string;
  description: string;
  warning: string | null;
  options: Array<{ value: string; label: string; description: string | null }> | "runtime" | null;
}

/** Exact literal matching: a changed sentence must not reuse stale translations. */
export function captureHints(english: string, template: string): Record<string, string> | undefined {
  const names = [...template.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]!);
  const literals = template.split(/\{[a-zA-Z]+\}/g);
  if (!english.startsWith(literals[0]!)) return;
  let offset = literals[0]!.length;
  const hints: Record<string, string> = Object.create(null);
  for (let index = 0; index < names.length; index++) {
    const suffix = literals[index + 1]!;
    const end = suffix ? english.indexOf(suffix, offset) : english.length;
    if (end < offset) return;
    hints[names[index]!] = english.slice(offset, end);
    offset = end + suffix.length;
  }
  return offset === english.length ? hints : undefined;
}

export function normalizeSource(ui: HostUiMetadata, template?: string): SourceMetadata {
  return {
    tab: ui.tab, group: ui.group ?? null, label: ui.label,
    description: template && captureHints(ui.description, template) ? template : ui.description,
    warning: ui.warning ?? null,
    options: Array.isArray(ui.options) ? ui.options.map(option => ({ value: option.value, label: option.label, description: option.description ?? null })) : ui.options ?? null,
  };
}

export function computeSourceHash(source: SourceMetadata): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

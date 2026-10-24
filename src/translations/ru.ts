import catalog from "./ru-catalog.json";
import type { LocalePack } from "./types";

/** Effective reviewed variants are data, not version-specific assembly. */
export const ru: LocalePack = catalog as LocalePack;

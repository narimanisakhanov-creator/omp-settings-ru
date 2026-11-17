import catalog from "./ru-catalog.json";
import type { LocalePack } from "./types";

/** Catalog/schema gates validate this JSON; heterogeneous option maps infer absent keys as undefined. */
export const ru: LocalePack = catalog as unknown as LocalePack;

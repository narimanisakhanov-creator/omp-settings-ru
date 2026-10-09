import { createHash } from "node:crypto";
import ts from "typescript";
import { ru } from "../src/translations/ru";
import manifest from "../src/translations/variant-review.json";
import type { LocalePack, SourceVariant } from "../src/translations/types";

// Fixed prior objects, not candidate-controlled tag names or candidate catalog bytes.
const historicalCommits = ["78fe0ef2360c2265e33bdbbe123a00309d866c46", "98986767a2caea9eb9b1725a0b3f4f2137caaae1"] as const;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fieldsHash(variant: SourceVariant): string {
  const {platforms: _platforms, observedIn: _observed, sourceHash: _source, ...fields} = variant;
  return digest(JSON.stringify(fields));
}
// Historical files contain literals only. Parse, never execute immutable or candidate TypeScript.
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error("nonliteral-historical-catalog");
      result[property.name.text] = literal(property.initializer);
    }
    return result;
  }
  throw new Error("nonliteral-historical-catalog");
}
interface HistoricalCatalogIdentity {
  hash: string;
  identities: Map<string, string>;
  firstPaths: Set<string>;
}
function historicalIdentity() {
  const hasher = createHash("sha256");
  const identities = new Map<string, string>();
  const firstPaths = new Set<string>();
  for (const commit of historicalCommits) for (let index = 1; index <= 3; index++) {
    const path = `src/translations/ru-part-${index}.ts`;
    const result = Bun.spawnSync(["git", "show", `${commit}:${path}`], {stdout: "pipe", stderr: "pipe"});
    if (result.exitCode !== 0) throw new Error("historical-catalog-unavailable");
    hasher.update(commit + "\0" + path + "\0" + result.stdout.length + "\0");
    hasher.update(result.stdout);
    const source = ts.createSourceFile(path, result.stdout.toString(), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(ts.isVariableStatement)?.declarationList.declarations[0];
    if (!declaration?.initializer) throw new Error("historical-catalog-invalid");
    const settings = literal(declaration.initializer);
    if (!settings || typeof settings !== "object") throw new Error("historical-catalog-invalid");
    for (const [settingPath, value] of Object.entries(settings)) {
      if (!value || typeof value !== "object" || !("sourceHash" in value) || typeof value.sourceHash !== "string") throw new Error("historical-catalog-invalid");
      const {sourceHash, ...fields} = value;
      firstPaths.add(settingPath);
      for (const platform of settingPath === "spelling.autocomplete" ? ["win32", "linux"] : ["win32", "darwin", "linux"]) {
        identities.set(`${settingPath}:${sourceHash}:${platform}`, digest(JSON.stringify(fields)));
      }
    }
  }
  return {hash: hasher.digest("hex"), identities, firstPaths};
}

/** Every shipped source/platform/Russian identity needs verified history or exact explicit review. */
export function verifyVariantReviews(pack: LocalePack = ru, review: typeof manifest = manifest): string[] {
  const failures: string[] = [];
  let history: HistoricalCatalogIdentity;
  try { history = historicalIdentity(); } catch { return ["historical-catalog-unavailable"]; }
  if (history.hash !== review.historicalCatalogHash) failures.push("historical-catalog-hash-mismatch");
  const approvals = new Map<string, string>();
  for (const row of review.variants) {
    const variant = pack.settings[row.path]?.variants.find(variant => variant.sourceHash === row.sourceHash && variant.platforms.length === row.platforms.length && variant.platforms.every(platform => row.platforms.includes(platform)));
    if (!variant) { failures.push("source-review-mismatch:" + row.path); continue; }
    const hash = fieldsHash(variant);
    if (hash !== row.translationHash) { failures.push("translation-review-mismatch:" + row.path); continue; }
    if (!row.comparison.trim() || !row.review.trim()) { failures.push("semantic-review-missing:" + row.path); continue; }
    if (row.path === "title.icons" && !history.identities.has(`${row.path}:${row.sourceHash}:${row.platforms[0]}`) && (row.review !== "independently-confirmed" || !row.reviewTask || !row.evidence)) {
      failures.push("independent-review-missing:title.icons"); continue;
    }
    for (const platform of row.platforms) approvals.set(`${row.path}:${row.sourceHash}:${platform}`, hash);
  }
  const seen = new Set<string>();
  for (const [path, setting] of Object.entries(pack.settings)) for (const variant of setting.variants) for (const platform of variant.platforms) {
    const key = `${path}:${variant.sourceHash}:${platform}`;
    if (seen.has(key)) failures.push(`duplicate-source-variant:${path}:${platform}`);
    seen.add(key);
    const hash = fieldsHash(variant);
    if (approvals.get(key) === hash) continue;
    if (history.hash === review.historicalCatalogHash && history.identities.get(key) === hash && !(path === "title.icons" && !history.identities.has(key))) continue;
    const classification = history.identities.has(key) ? "translation-edit" : history.firstPaths.has(path) ? "source-variant" : "addition";
    failures.push(`unreviewed-${classification}:${path}:${platform}`);
  }
  return failures;
}

import {
  catalogIdentity,
  decideMarketplaceIndexPublish,
  draftCatalogEvidence,
  loadVerifiedCatalog,
  readField,
  runGh,
  servedChannelIdentity,
  tagCommit,
  validatePrepublicationCatalog,
  waitForCheckRun,
  type MarketplaceCatalog,
} from "./marketplace-catalog";

/**
 * Promote a release that already carries its marketplace catalog.
 *
 * The order is deliberate and is the whole point of this script:
 *
 * 1. `release.yml` creates a DRAFT release with archive, `SHA256SUMS` and `marketplace.json`.
 *    A draft is not `latest`, so no user can observe a release without its catalog.
 * 2. The exact tag-commit `check.yml` run is *waited for*, not queried once. A tag push starts
 *    its own run and the release job finishes long before it; a single completed-only query is
 *    the observed v0.4.0 race.
 * 3. Every draft asset is re-downloaded through the authenticated asset API and re-hashed here,
 *    so the receipt describes the bytes that were uploaded rather than the release metadata.
 *    The catalog used for the decision is those downloaded bytes; no local file can be
 *    substituted for them.
 * 4. The served channel is read and the monotonic rule decides. A legacy release without a
 *    catalog asset still has a well-defined identity (its tag commit), so the comparison stays
 *    honest instead of silently accepting an unknown channel.
 * 5. Only then is the draft promoted, and only then is the published release re-proved.
 *
 * A rerun after a successful promotion is idempotent: the already-published release is verified
 * against its own live evidence and returns `identical` rather than being refused as "not draft".
 *
 * There is no branch here: the catalog is a release asset, and no ref is ever written.
 */

export interface PublishOptions {
  readonly tag: string;
  readonly repository: string;
  readonly checkRunTimeoutMs: number;
}

export interface PublishResult {
  readonly decision: "publish" | "identical";
  readonly checkRun?: string;
  readonly catalog?: MarketplaceCatalog;
}

interface ReleaseState { readonly id: number; readonly draft: boolean }

/** Read the release id and draft state. A draft is invisible to the public download path. */
export function readReleaseState(tag: string, repository: string): ReleaseState {
  const raw = JSON.parse(runGh([`repos/${repository}/releases/tags/${tag}`])) as unknown;
  const id = readField(raw, "id");
  if (!Number.isSafeInteger(id)) throw new Error("marketplace-release-id-invalid");
  return {id: id as number, draft: readField(raw, "draft") === true};
}

/**
 * Promote a draft release. The update endpoint is `/releases/{id}`, not the tag route,
 * and `draft` is a boolean field: a `-f` string would send the literal text "false".
 */
export function promoteRelease(tag: string, repository: string): void {
  const state = readReleaseState(tag, repository);
  if (!state.draft) throw new Error("marketplace-release-already-published");
  runGh(["--method", "PATCH", `repos/${repository}/releases/${state.id}`, "-F", "draft=false"]);
}

export async function publishMarketplaceIndex(options: PublishOptions): Promise<PublishResult> {
  const {tag, repository} = options;
  const targetCommitSha = tagCommit(repository, tag);
  const runId = await waitForCheckRun(repository, targetCommitSha, options.checkRunTimeoutMs);
  const state = readReleaseState(tag, repository);
  if (!state.draft) {
    // Rerun after a successful promotion: prove the live release and the served channel again.
    const published = await loadVerifiedCatalog(tag, runId, undefined, repository);
    const identity = catalogIdentity(published.catalog, "marketplace-published");
    if (identity.sha !== targetCommitSha) throw new Error("marketplace-published-sha-mismatch");
    const served = await servedChannelIdentity(repository);
    if (served === null || served.version !== identity.version || served.sha !== identity.sha) throw new Error("marketplace-served-identity-mismatch");
    return {decision: "identical", checkRun: runId, catalog: published.catalog};
  }
  const {evidence, catalogBytes} = await draftCatalogEvidence(tag, runId, repository);
  const catalog = JSON.parse(new TextDecoder().decode(catalogBytes)) as unknown;
  const errors = validatePrepublicationCatalog(catalog, evidence, repository);
  if (errors.length > 0) throw new Error(`marketplace-prepublication-rejected:${errors.join(",")}`);
  const next = catalog as MarketplaceCatalog;
  const served = await servedChannelIdentity(repository);
  if (decideMarketplaceIndexPublish(served, next) === "identical") return {decision: "identical", checkRun: runId, catalog: next};
  promoteRelease(tag, repository);
  const verified = await loadVerifiedCatalog(tag, runId, undefined, repository);
  const identity = catalogIdentity(verified.catalog, "marketplace-published");
  if (identity.sha !== targetCommitSha) throw new Error("marketplace-published-sha-mismatch");
  if (identity.version !== catalogIdentity(next, "marketplace-promoted").version) throw new Error("marketplace-published-version-mismatch");
  return {decision: "publish", checkRun: runId, catalog: verified.catalog};
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string => {
    const index = args.indexOf(name);
    const found = index >= 0 ? args[index + 1] : undefined;
    if (!found || found.startsWith("--")) throw new Error(`required:${name}`);
    return found;
  };
  const repository = args.includes("--repo-name") ? value("--repo-name") : "narimanisakhanov-creator/omp-settings-ru";
  const result = await publishMarketplaceIndex({
    tag: value("--tag"),
    repository,
    checkRunTimeoutMs: args.includes("--timeout-ms") ? Number(value("--timeout-ms")) : 1_800_000,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) await main();

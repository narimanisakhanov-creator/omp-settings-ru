import { expect, test } from "bun:test";
import { ru } from "../src/translations/ru";
import manifest from "../src/translations/variant-review.json";
import { verifyVariantReviews } from "../scripts/verify-variant-reviews";

test("rejects appended source variant retaining stale translation bytes", () => {
  const setting = ru.settings["title.icons"]!;
  const pack = {...ru, settings: {...ru.settings, "title.icons": {variants: [...setting.variants,
    {...setting.variants[0]!, sourceHash: "f".repeat(64), observedIn: ["99.0.0"]}]}}};
  expect(verifyVariantReviews(pack)).toContain("unreviewed-source-variant:title.icons:win32");
});
test("rejects hidden translation edit under unchanged historical source identity", () => {
  const variant = ru.settings.autoResume!.variants[0]!;
  const pack = {...ru, settings: {...ru.settings, autoResume: {variants: [{...variant, description: variant.description + "!"}]}}};
  expect(verifyVariantReviews(pack)).toContain("unreviewed-translation-edit:autoResume:win32");
});

test("accepts shipped historical identities and independently reviewed title delta", () => {
  expect(verifyVariantReviews()).toEqual([]);
});

test("rejects exact source review with tampered translation hash", () => {
  const review = structuredClone(manifest);
  review.variants.find(row => row.path === "title.icons" && row.observedIn.includes("18.8.4"))!.translationHash = "0".repeat(64);
  expect(verifyVariantReviews(ru, review)).toContain("translation-review-mismatch:title.icons");
});

test("verifies historical catalog digest against immutable prior bytes", () => {
  const review = structuredClone(manifest);
  review.historicalCatalogHash = "0".repeat(64);
  expect(verifyVariantReviews(ru, review)).toContain("historical-catalog-hash-mismatch");
});

test("requires independent title delta approval even when hash matches", () => {
  const review = structuredClone(manifest);
  review.variants.find(row => row.path === "title.icons" && row.observedIn.includes("18.8.4"))!.review = "implementation-semantic-review";
  expect(verifyVariantReviews(ru, review)).toContain("independent-review-missing:title.icons");
});

test("requires independent title review even if candidate removes observed host versions", () => {
  const review = structuredClone(manifest);
  const row = review.variants.find(row => row.path === "title.icons" && row.observedIn.includes("18.8.4"))!;
  row.observedIn = [];
  row.review = "implementation-semantic-review";
  const setting = ru.settings["title.icons"]!;
  const pack = {...ru, settings: {...ru.settings, "title.icons": {variants: setting.variants.map(variant =>
    variant.sourceHash === row.sourceHash ? {...variant, observedIn: []} : variant)}}};
  expect(verifyVariantReviews(pack, review)).toContain("independent-review-missing:title.icons");
});

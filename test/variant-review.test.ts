import { expect, test } from "bun:test";
import { ru } from "../src/translations/ru";
import manifest from "../src/translations/variant-review.json";
import { verifyVariantReviews } from "../scripts/verify-variant-reviews";
import { translationFieldsHash } from "../scripts/maintenance/catalog";

// The checked-in manifest may carry the candidate's disabled marker after merge.
// Explicit required mode keeps legacy gate tests independent of that repository state.
const requiredReview = () => ({ ...structuredClone(manifest), semanticReview: "required" });

test("rejects appended source variant retaining stale translation bytes", () => {
  const setting = ru.settings["title.icons"]!;
  const pack = {...ru, settings: {...ru.settings, "title.icons": {variants: [...setting.variants,
    {...setting.variants[0]!, sourceHash: "f".repeat(64), observedIn: ["99.0.0"]}]}}};
  expect(verifyVariantReviews(pack, requiredReview())).toContain("unreviewed-source-variant:title.icons:win32");
});
test("rejects hidden translation edit under unchanged historical source identity", () => {
  const variant = ru.settings.autoResume!.variants[0]!;
  const pack = {...ru, settings: {...ru.settings, autoResume: {variants: [{...variant, description: variant.description + "!"}]}}};
  expect(verifyVariantReviews(pack, requiredReview())).toContain("unreviewed-translation-edit:autoResume:win32");
});

test("accepts shipped historical identities and independently reviewed title delta", () => {
  expect(verifyVariantReviews()).toEqual([]);
});

test("rejects exact source review with tampered translation hash", () => {
  const review = requiredReview();
  review.variants.find(row => row.path === "title.icons" && row.observedIn.includes("18.8.4"))!.translationHash = "0".repeat(64);
  expect(verifyVariantReviews(ru, review)).toContain("translation-review-mismatch:title.icons");
});

test("verifies historical catalog digest against immutable prior bytes", () => {
  const review = requiredReview();
  review.historicalCatalogHash = "0".repeat(64);
  expect(verifyVariantReviews(ru, review)).toContain("historical-catalog-hash-mismatch");
});

test("requires independent title delta approval even when hash matches", () => {
  const review = requiredReview();
  review.variants.find(row => row.path === "title.icons" && row.observedIn.includes("18.8.4"))!.review = "implementation-semantic-review";
  expect(verifyVariantReviews(ru, review)).toContain("independent-review-missing:title.icons");
});

test("requires independent title review even if candidate removes observed host versions", () => {
  const review = requiredReview();
  const row = review.variants.find(row => row.path === "title.icons" && row.observedIn.includes("18.8.4"))!;
  row.observedIn = [];
  row.review = "implementation-semantic-review";
  const setting = ru.settings["title.icons"]!;
  const pack = {...ru, settings: {...ru.settings, "title.icons": {variants: setting.variants.map(variant =>
    variant.sourceHash === row.sourceHash ? {...variant, observedIn: []} : variant)}}};
  expect(verifyVariantReviews(pack, review)).toContain("catalog-invalid");
});

test("new source identities require exact run proof rather than historical review labels",()=>{
  const original=ru.settings.autoResume!.variants[0]!;
  const variant={...original,sourceHash:"e".repeat(64),observedIn:["99.0.0"]};
  const pack={...ru,settings:{...ru.settings,autoResume:{variants:[original,variant]}}};
  const historical=manifest.variants.find(row=>row.path==="composer.tokenRate")!;
  const row={...historical,path:"autoResume",sourceHash:variant.sourceHash,translationHash:translationFieldsHash(variant),platforms:[...variant.platforms],observedIn:["99.0.0"],review:"independently-confirmed",comparison:"Exact source and translation compared",reviewTask:"123:2",evidence:"a".repeat(64),reviewedAtVersion:"99.0.0"};
  expect(verifyVariantReviews(pack,{...requiredReview(),variants:[...manifest.variants,row]})).toEqual([]);
  expect(verifyVariantReviews(pack,{...requiredReview(),variants:[...manifest.variants,{...row,evidence:"path/to/file"}]})).toContain("independent-review-missing:autoResume");
  expect(verifyVariantReviews(pack,{...requiredReview(),variants:[...manifest.variants,{...row,reviewTask:"old-task"}]})).toContain("independent-review-missing:autoResume");
});

test("disabled semantic review skips only new identities and keeps historical translation edits blocking", () => {
  const original = ru.settings.autoResume!.variants[0]!;
  const addition = { ...original, sourceHash: "e".repeat(64), observedIn: ["99.0.0"] };
  const addedPack = { ...ru, settings: { ...ru.settings, autoResume: { variants: [original, addition] } } };
  const disabled = { ...structuredClone(manifest), semanticReview: "disabled" };
  expect(verifyVariantReviews(addedPack, disabled)).toEqual([]);
  const editedPack = { ...ru, settings: { ...ru.settings, autoResume: { variants: [{ ...original, description: original.description + "!" }] } } };
  expect(verifyVariantReviews(editedPack, disabled)).toContain("unreviewed-translation-edit:autoResume:win32");
});

test("disabled semantic review rejects fabricated review rows", () => {
  const original = ru.settings.autoResume!.variants[0]!;
  const variant = { ...original, sourceHash: "e".repeat(64), observedIn: ["99.0.0"] };
  const pack = { ...ru, settings: { ...ru.settings, autoResume: { variants: [original, variant] } } };
  const row = { path: "autoResume", sourceHash: variant.sourceHash, translationHash: translationFieldsHash(variant), platforms: [...variant.platforms], observedIn: ["99.0.0"], review: "independently-confirmed", comparison: "fabricated", reviewTask: "123:2", evidence: "a".repeat(64), reviewedAtVersion: "99.0.0" };
  const disabled = { ...structuredClone(manifest), semanticReview: "disabled", variants: [...manifest.variants, row] };
  expect(verifyVariantReviews(pack, disabled)).toContain("unexpected-review-row:autoResume");
});

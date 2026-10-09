import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fixedHostAssetName, selectFixedHostAsset, verifyFixedHostBytes, updaterTestExecutable } from "../scripts/ci/prepare-host.ts";

const bytes = Buffer.from("downloaded release bytes");
const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
const asset = { id: 7, name: "omp-windows-x64.exe", size: bytes.length, digest, browser_download_url: "https://github.com/can1357/oh-my-pi/releases/download/v18.6.1/omp-windows-x64.exe" };
const release = { tag_name: "v18.6.1", draft: false, prerelease: false, assets: [asset] };

test("fixed releases map native OS and architecture to exact binary names", () => {
  expect(fixedHostAssetName("18.6.1", "win32", "x64")).toBe("omp-windows-x64.exe");
  expect(fixedHostAssetName("18.8.0", "linux", "x64")).toBe("omp-linux-x64");
  expect(fixedHostAssetName("18.8.4", "darwin", "arm64")).toBe("omp-darwin-arm64");
  for (const version of ["latest", "^18.8.4", ">=18.6.1", "v18.8.4", "18.8.4-beta.1", "018.8.4", "18.8.4\n"]) expect(() => fixedHostAssetName(version, "win32", "x64")).toThrow("exact-host-version-required");
  expect(() => fixedHostAssetName("18.8.4", "freebsd", "x64")).toThrow("native-host-pair-invalid");
  expect(() => fixedHostAssetName("18.8.4", "linux", "ia32")).toThrow("native-host-pair-invalid");
});

test("release authority refuses foreign tags, duplicate assets and missing SHA256", () => {
  expect(selectFixedHostAsset(release, "18.6.1", "win32", "x64")).toEqual(asset);
  for (const changed of [{ ...release, tag_name: "v18.8.4" }, { ...release, draft: true }, { ...release, prerelease: true }]) expect(() => selectFixedHostAsset(changed, "18.6.1", "win32", "x64")).toThrow("fixed-host-release-invalid");
  for (const assets of [[], [asset, asset], [{ ...asset, digest: null }], [{ ...asset, digest: "sha512:" + "a".repeat(128) }], [{ ...asset, id: 0 }], [{ ...asset, size: -1 }], [{ ...asset, browser_download_url: asset.browser_download_url.replace("v18.6.1", "v18.8.4") }]]) expect(() => selectFixedHostAsset({ ...release, assets }, "18.6.1", "win32", "x64")).toThrow();
});

test("binary integrity refuses changed bytes and truncated downloads before execution", () => {
  expect(verifyFixedHostBytes(bytes, asset)).toBe(digest.slice(7));
  const changed = Buffer.from(bytes);
  changed[0] = 0;
  expect(() => verifyFixedHostBytes(changed, asset)).toThrow("fixed-host-integrity-failed");
  expect(() => verifyFixedHostBytes(bytes.subarray(1), asset)).toThrow("fixed-host-size-mismatch");
});

test("CI refuses ambient omp and explicit executable wins without PATH lookup", () => {
  const explicit = process.platform === "win32" ? "C:/runner/temp/pinned.exe" : "/runner/temp/pinned";
  expect(updaterTestExecutable({ CI: "true", OMP_UPDATER_EXECUTABLE: explicit }, () => { throw new Error("ambient lookup forbidden"); })).toBe(explicit);
  expect(() => updaterTestExecutable({ CI: "true", OMP_UPDATER_EXECUTABLE: "./omp" }, () => null)).toThrow("updater-executable-must-be-absolute");
  expect(() => updaterTestExecutable({ CI: "true" }, () => "C:/global/omp.exe")).toThrow("ci-updater-executable-required");
  expect(() => updaterTestExecutable({}, () => null)).toThrow("updater-executable-required");
  expect(updaterTestExecutable({}, () => "/developer/omp")).toBe("/developer/omp");
});

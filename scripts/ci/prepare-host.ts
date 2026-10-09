import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const repository = "can1357/oh-my-pi";
interface FixedHostAsset { id: number; name: string; size: number; digest: string; browser_download_url: string }

export function fixedHostAssetName(version: string, platform: string, arch: string): string {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) || version.includes("\n")) throw new Error("exact-host-version-required");
  if (!["win32", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("native-host-pair-invalid");
  return platform === "win32" ? `omp-windows-${arch}.exe` : `omp-${platform}-${arch}`;
}

export function selectFixedHostAsset(payload: unknown, version: string, platform: string, arch: string): FixedHostAsset {
  const name = fixedHostAssetName(version, platform, arch);
  const release = payload as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;
  if (!release || release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error("fixed-host-release-invalid");
  const matches = release.assets.filter(entry => entry?.name === name);
  if (matches.length !== 1) throw new Error("fixed-host-asset-unavailable-or-ambiguous");
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0 || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || asset.digest.includes("\n")) throw new Error("fixed-host-asset-digest-unavailable");
  if (asset.browser_download_url !== `https://github.com/${repository}/releases/download/v${version}/${name}`) throw new Error("fixed-host-asset-url-invalid");
  return asset;
}

export function verifyFixedHostBytes(bytes: Uint8Array, asset: FixedHostAsset): string {
  if (bytes.byteLength !== asset.size) throw new Error("fixed-host-size-mismatch");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (`sha256:${sha256}` !== asset.digest) throw new Error("fixed-host-integrity-failed");
  return sha256;
}

/** CI must use the verified job-owned host, never a runner's ambient installation. */
export function updaterTestExecutable(environment: Record<string, string | undefined>, localLookup: () => string | null): string {
  if (environment.OMP_UPDATER_EXECUTABLE) {
    if (!isAbsolute(environment.OMP_UPDATER_EXECUTABLE)) throw new Error("updater-executable-must-be-absolute");
    return environment.OMP_UPDATER_EXECUTABLE;
  }
  if (environment.CI || environment.GITHUB_ACTIONS) throw new Error("ci-updater-executable-required");
  const local = localLookup();
  if (!local) throw new Error("updater-executable-required");
  return local;
}

async function main(): Promise<void> {
  const version = process.argv[2] ?? "";
  const platform = process.argv[3] ?? "";
  fixedHostAssetName(version, platform, process.arch);
  if (platform !== process.platform) throw new Error("native-runner-platform-mismatch");
  if (!process.env.GH_TOKEN) throw new Error("authenticated-github-token-required");
  const runnerTemp = process.env.RUNNER_TEMP;
  const output = process.env.GITHUB_OUTPUT;
  if (!runnerTemp || !isAbsolute(runnerTemp) || !output) throw new Error("job-temporary-output-required");
  // GET-only metadata lookup. Never forward authentication to an asset redirect.
  const release = Bun.spawnSync(["gh", "api", `repos/${repository}/releases/tags/v${version}`], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  if (release.exitCode !== 0) throw new Error("fixed-host-release-unavailable");
  const asset = selectFixedHostAsset(JSON.parse(release.stdout.toString()), version, platform, process.arch);
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error("fixed-host-download-failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = verifyFixedHostBytes(bytes, asset);
  const directory = await mkdtemp(join(runnerTemp, "omp-updater-host-"));
  // The updater's native Windows process liveness contract identifies omp.exe.
  // Release provenance still names the exact asset; only verified bytes get this job-local name.
  const executable = join(directory, process.platform === "win32" ? "omp.exe" : "omp");
  await writeFile(executable, bytes, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") await chmod(executable, 0o700);
  // Only a private step output carries the job path; logs contain public provenance only.
  if (/[\r\n]/.test(executable)) throw new Error("job-temporary-path-invalid");
  await appendFile(output, `executable=${executable}\n`);
  console.log(JSON.stringify({ releaseTag: `v${version}`, platform, arch: process.arch, assetName: asset.name, assetId: asset.id, sha256 }));
}

if (import.meta.main) await main();

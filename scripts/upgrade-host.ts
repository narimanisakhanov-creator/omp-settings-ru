import { buildCoverageReport, buildDriftReport, buildSourceSnapshot, type BaselineSnapshot } from "../src/report";
import { getHostMetadata } from "../src/host-adapter";
import { ru } from "../src/translations/ru";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

type RegistryMetadata = { "dist-tags"?: { latest?: string }; versions?: Record<string, unknown> };
const usage = "Usage: bun scripts/upgrade-host.ts <version|latest> [--dry-run]";
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log(usage); process.exit(0); }
if (args.length === 0) { console.error(usage); process.exit(1); }
const requested = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!requested) { console.error(usage); process.exit(1); }

async function fetchJson(url: string): Promise<RegistryMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as RegistryMetadata;
  } catch (error) {
    throw new Error(`Unable to reach npm registry (${url}): ${error instanceof Error ? error.message : String(error)}`);
  } finally { clearTimeout(timer); }
}

const packageText = readFileSync("package.json", "utf8");
const packageJson = JSON.parse(packageText) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> };
const pinned = Object.keys({ ...packageJson.peerDependencies, ...packageJson.devDependencies }).filter((name) => name.startsWith("@oh-my-pi/"));
let version: string;
if (requested === "latest") {
  const latest = (await fetchJson("https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent"))["dist-tags"]?.latest;
  if (!latest) throw new Error("npm registry returned no dist-tags.latest");
  version = latest;
} else version = requested;
if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) throw new Error(`Invalid version: ${version}`);
const current = packageJson.peerDependencies["@oh-my-pi/pi-coding-agent"];
for (const name of pinned) {
  const metadata = await fetchJson(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (!metadata.versions?.[version]) throw new Error(`${name}@${version} does not exist`);
}
console.log(`Upgrade plan: ${current} -> ${version}`);
console.log(`Packages: ${pinned.join(", ")}`);
console.log(`Pins to rewrite: ${pinned.map((name) => `${name}: ${current} -> ${version}`).join(", ")}`);
const hostPlatform = process.platform;
console.log(`Baseline file: baseline/${version}-${hostPlatform}.json`);
if (dryRun) { console.log("Dry run: no files changed."); process.exit(0); }

let updated = packageText;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const name of pinned) {
  const key = escapeRegExp(JSON.stringify(name));
  updated = updated.replace(new RegExp(`(${key}\\s*:\\s*")[^"]+(" )`.replace('" )', '")'), "g"), `$1${version}$2`);
}
await writeFile("package.json", updated);
try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["install", "--ignore-scripts"], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`bun install failed (${code ?? "unknown"})`)));
  });
} catch (error) {
  await writeFile("package.json", packageText);
  throw error;
}
const host = await getHostMetadata();
const snapshot = buildSourceSnapshot(host);
const output = `baseline/${version}-${host.platform}.json`;
await mkdir("baseline", { recursive: true });
await writeFile(output, JSON.stringify(snapshot, null, 2) + "\n");
const oldPath = `baseline/${current}-${host.platform}.json`;
let old: BaselineSnapshot | undefined;
try { old = JSON.parse(readFileSync(oldPath, "utf8")); } catch { }
let report = `# OMP ${current} → ${version}\n\n`;
if (old) {
  const drift = buildDriftReport(host, old);
  const entry = (path: string) => { const s = snapshot.settings[path]; return `- \`${path}\`: ${s?.label ?? ""} — ${s?.description ?? ""}`; };
  report += `## Drift (added ${drift.addedPaths.length}, removed ${drift.removedPaths.length}, changed ${drift.changedPaths.length})\n### Added\n${drift.addedPaths.map(entry).join("\n") || "- None"}\n### Removed\n${drift.removedPaths.map((p) => `- \`${p}\``).join("\n") || "- None"}\n### Changed\n${drift.changedPaths.map((p) => `- \`${p}\`: ${old!.settings[p]?.label ?? ""} → ${snapshot.settings[p]?.label ?? ""}`).join("\n") || "- None"}\n\n`;
}
const coverage = buildCoverageReport(host, ru);
report += `## Translation coverage\n- totalUiSettings: ${coverage.totalUiSettings}\n- translatedSettings: ${coverage.translatedSettings}\n- completeSettings: ${coverage.completeSettings}\n- partialSettings: ${coverage.partialSettings}\n- untranslatedPaths: ${coverage.untranslatedPaths.length}\n- partialPaths: ${coverage.partialPaths.length}\n- stalePaths: ${coverage.stalePaths.length}\n- optionMismatches: ${coverage.optionMismatches.length}\n- sourceHashMismatches: ${coverage.sourceHashMismatches.length}\n\n`;
report += "## Next steps\n- Translate new strings\n- Update source hashes after review\n- Manually exercise the installed panel\n- Bump compatibility.ts\n- Bump plugin version\n";
await writeFile("upgrade-report.md", report);
console.log(report);

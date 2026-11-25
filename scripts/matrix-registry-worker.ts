import { buildSourceSnapshot } from "../src/report";
import type { HostMetadata, HostSettingDefinition } from "../src/host-types";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

function sanitizedDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";
  return detail
    .replace(/(?:[A-Za-z]:\\|\/)[^\s:]+/g, "<path>")
    .replace(/\b(?:https?|file):\/\/[^\s]+/gi, "<url>")
    .replace(/\b(token|secret|password|authorization|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .slice(0, 500);
}

const [alias, version, platform, output] = process.argv.slice(2);
if (!alias || !/^omp-host-[0-9]+$/.test(alias) || !version || !platform || !["win32", "darwin", "linux"].includes(platform) || !output || !isAbsolute(output)) throw new Error("invalid-registry-input");
const nativePlatform = process.platform;
const registryPath = import.meta.resolve(`${alias}/config/all-settings`);
const registryDir = dirname(registryPath.startsWith("file:") ? fileURLToPath(registryPath) : registryPath);
const warmedUtils = new Set([
  Bun.resolveSync("@oh-my-pi/pi-utils", registryDir),
  Bun.resolveSync("@oh-my-pi/pi-utils", import.meta.dirname),
]);
// Bun can materialize separate pi-utils copies below several transitive packages. Initialize
// their project directories under the real OS before the derived Windows import can invoke
// the Windows native path helper. Only the worker's own dependency tree is in scope.
if (platform === "win32" && nativePlatform !== "win32") {
  const copies = new Bun.Glob("**/node_modules/@oh-my-pi/pi-utils/package.json");
  for (const manifest of copies.scanSync({ cwd: `${import.meta.dirname}/../node_modules`, absolute: true, dot: true })) {
    warmedUtils.add(Bun.resolveSync("@oh-my-pi/pi-utils", dirname(manifest)));
  }
}
await Promise.all([...warmedUtils].map(path => import(path)));
// Source-derived export deliberately evaluates the package's platform source branch; never native-panel evidence.
// Registry resolution selects a version at runtime; its module graph must initialize under the requested source platform.
Object.defineProperty(process, "platform", {configurable: true, value: platform});
try {
  try {
    const { orderedSettings } = await import(`${alias}/config/all-settings`);
    const schema: HostMetadata["schema"] = Object.create(null);
    for (const setting of orderedSettings()) schema[setting.id] = setting.definition as HostSettingDefinition;
    await writeFile(output, JSON.stringify(buildSourceSnapshot({version, platform, schema})), { encoding: "utf8", flag: "wx" });
  } finally {
    Object.defineProperty(process, "platform", {configurable: true, value: nativePlatform});
  }
} catch (error) {
  console.error(`source-registry-export: ${sanitizedDiagnostic(error)}`);
  process.exitCode = 1;
}

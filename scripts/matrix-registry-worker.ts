import { buildSourceSnapshot } from "../src/report";
import type { HostMetadata, HostSettingDefinition } from "../src/host-types";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [alias, version, platform] = process.argv.slice(2);
if (!alias || !/^omp-host-[0-9]+$/.test(alias) || !version || !platform || !["win32", "darwin", "linux"].includes(platform)) throw new Error("invalid-registry-input");
const nativePlatform = process.platform;
// Load the real native module while its actual OS identity still applies; source branches only are derived below.
const registryPath = import.meta.resolve(`${alias}/config/all-settings`);
const nativePath = Bun.resolveSync("@oh-my-pi/pi-natives", dirname(registryPath.startsWith("file:") ? fileURLToPath(registryPath) : registryPath));
await import(nativePath);
// Source-derived export deliberately evaluates the package's platform source branch; never native-panel evidence.
// Registry resolution selects a version at runtime; its module graph must initialize under the requested source platform.
Object.defineProperty(process, "platform", {configurable: true, value: platform});
try {
  const { orderedSettings } = await import(`${alias}/config/all-settings`);
  const schema: HostMetadata["schema"] = Object.create(null);
  for (const setting of orderedSettings()) schema[setting.id] = setting.definition as HostSettingDefinition;
  console.log(JSON.stringify(buildSourceSnapshot({version, platform, schema})));
} finally {
  Object.defineProperty(process, "platform", {configurable: true, value: nativePlatform});
}

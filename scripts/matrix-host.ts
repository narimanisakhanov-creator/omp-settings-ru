import type { HostMetadata, HostSettingDefinition, HostUiMetadata } from "../src/host-types";
import type { BaselineSnapshot } from "../src/report";
import manifest from "../baseline/supported-hosts.json";

export function requestedPairs(args: readonly string[]) {
  const version = args.find(arg => /^\d+\.\d+\.\d+$/.test(arg));
  const platform = args.find(arg => arg === "win32" || arg === "darwin" || arg === "linux");
  return manifest.versions.filter(record => !version || record.version === version).flatMap(record => record.platforms.filter(value => !platform || platform === value).map(platform => ({...record, platform})));
}
export async function loadMatrixHost(version: string, platform: string): Promise<{host: HostMetadata; evidence: "native-package-registry" | "source-derived"}> {
  const record = manifest.versions.find(record => record.version === version);
  if (!record || !record.platforms.includes(platform)) throw new Error("unsupported-matrix-pair");
  if (platform === process.platform) {
    // Registry bundle is runtime-selected by a validated finite manifest; separate packages preserve actual version identities.
    const { orderedSettings } = await import(`${record.package}/config/all-settings`);
    const schema: HostMetadata["schema"] = Object.create(null);
    for (const setting of orderedSettings()) {
      if (Object.hasOwn(schema, setting.id)) throw new Error("duplicate-setting-id");
      schema[setting.id] = setting.definition as HostSettingDefinition;
    }
    return {host: {version, platform, schema}, evidence: "native-package-registry"};
  }
  // Export package source branches in a fresh process, independently of the committed baseline.
  const exported = Bun.spawnSync(["bun", "scripts/matrix-registry-worker.ts", record.package, version, platform], {stdout: "pipe", stderr: "pipe", timeout: 30000});
  if (exported.exitCode !== 0) throw new Error("source-registry-export-failed");
  const baseline = JSON.parse(exported.stdout.toString()) as BaselineSnapshot;
  const schema: HostMetadata["schema"] = Object.create(null);
  for (const [path, source] of Object.entries(baseline.settings)) {
    const ui: HostUiMetadata = {tab: source.tab, label: source.label, description: source.description};
    if (source.group !== null) ui.group = source.group;
    if (source.warning !== null) ui.warning = source.warning;
    if (source.options === "runtime") ui.options = "runtime";
    else if (source.options !== null) ui.options = source.options.map(option => option.description === null ? {value: option.value, label: option.label} : {...option, description: option.description});
    schema[path] = {type: "string", default: "", ui};
  }
  return {host: {version, platform, schema}, evidence: "source-derived"};
}

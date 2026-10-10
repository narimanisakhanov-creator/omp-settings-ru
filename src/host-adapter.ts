// Imports only host metadata surfaces; never reads current settings or credentials.
import type { HostMetadata, HostSettingDefinition } from "./host-types";

/** Imports only host metadata surfaces; never reads current settings or credentials. */
export async function getHostMetadata(): Promise<HostMetadata> {
  // Compiled OMP exposes these through its runtime module registry; static loading would bypass the safe refusal boundary.
  const [{ VERSION }, { orderedSettings }] = await Promise.all([
    import("@oh-my-pi/pi-utils"),
    import("@oh-my-pi/pi-coding-agent/config/all-settings"),
  ]);
  const schema: HostMetadata["schema"] = Object.create(null);
  for (const setting of orderedSettings()) {
    if (Object.hasOwn(schema, setting.id)) throw new Error("duplicate-setting-id");
    schema[setting.id] = setting.definition as unknown as HostSettingDefinition;
  }
  return { version: VERSION, platform: process.platform, schema };
}

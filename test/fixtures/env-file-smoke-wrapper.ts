import { runInstalledSmoke } from "../../scripts/installed-smoke";

/**
 * Child-process wrapper for the cwd .env regression. The test launches this
 * file by absolute path from a disposable cwd with `bun --no-env-file`, so the
 * only way the sentinel can reach the worker is Bun's own .env loading.
 */
const [executable, pluginPath, ownedProfile, isolatedCwd] = process.argv.slice(2);
if (!executable || !pluginPath || !ownedProfile || !isolatedCwd) throw new Error("env-file-smoke-arguments-required");
try {
  const receipt = await runInstalledSmoke({ executable, pluginPath, ownedProfile, isolatedCwd, mode: "post-activation", startupOnly: true });
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

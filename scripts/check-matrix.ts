import policy from "../maintenance.config.json";
import { readSupportedHosts, supportWindow } from "./maintenance/paths";

const manifest = readSupportedHosts();
const args = process.argv.slice(2);
const candidateFlag = args.indexOf("--candidate");
const candidate = candidateFlag >= 0 ? args[candidateFlag + 1] : undefined;
if (candidate && !/^\d+\.\d+\.\d+$/.test(candidate)) throw new Error("invalid-candidate-version");
const activeVersions = candidate
  ? supportWindow([...manifest.versions.map(record => record.version), candidate])
  : manifest.versions.map(record => record.version);
const include = activeVersions.flatMap(version => policy.requiredCheckPlatforms.map(pair => ({version, ...pair})));
if (args.includes("--ci-matrix")) console.log(JSON.stringify({include}));
else {
  for (const script of ["scripts/check-coverage.ts", "scripts/diff-upstream.ts"]) {
    const result = Bun.spawnSync(["bun", script, ...args], {stdout: "inherit", stderr: "inherit"});
    if (result.exitCode !== 0) process.exit(result.exitCode);
  }
}

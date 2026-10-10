import manifest from "../baseline/supported-hosts.json";
import policy from "../maintenance.config.json";

const args = process.argv.slice(2);
const candidateFlag = args.indexOf("--candidate");
const candidate = candidateFlag >= 0 ? args[candidateFlag + 1] : undefined;
if (candidate && !/^\d+\.\d+\.\d+$/.test(candidate)) throw new Error("invalid-candidate-version");
const versions = new Set(manifest.versions.map(record => record.version));
if (candidate) versions.add(candidate);
const include = Array.from(versions).flatMap(version => policy.requiredCheckPlatforms.map(pair => ({version, ...pair})));
if (args.includes("--ci-matrix")) console.log(JSON.stringify({include}));
else {
  for (const script of ["scripts/check-coverage.ts", "scripts/diff-upstream.ts"]) {
    const result = Bun.spawnSync(["bun", script, ...args], {stdout: "inherit", stderr: "inherit"});
    if (result.exitCode !== 0) process.exit(result.exitCode);
  }
}

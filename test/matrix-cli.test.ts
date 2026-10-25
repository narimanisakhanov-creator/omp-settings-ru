import { expect, test } from "bun:test";
import supported from "./fixtures/host-snapshots/supported-hosts.json";

const expectedPairs = supported.versions.flatMap(row => row.platforms.map(platform => `${row.version}-${platform}`)).sort();

for (const command of ["scripts/check-coverage.ts", "scripts/diff-upstream.ts"]) {
  test(`${command} reports all retained version platform pairs without conflating native evidence`, () => {
    const result = Bun.spawnSync(["bun", command, "--all"], {stdout: "pipe", stderr: "pipe", timeout: 60000});
    if(result.exitCode!==0)throw new Error(`${command} failed (${result.exitCode}): ${result.stderr.toString()}`);
    const output = JSON.parse(result.stdout.toString());
    expect(output.pairs).toBeArray();
    expect(output.pairs.map((pair: {hostVersion: string; platform: string}) => `${pair.hostVersion}-${pair.platform}`).sort()).toEqual(expectedPairs);
    for (const pair of output.pairs) expect(pair.evidence).toBe(pair.platform === process.platform ? "native-package-registry" : "source-derived");
  }, 60000);
}

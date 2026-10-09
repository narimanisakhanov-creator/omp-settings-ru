import { expect, test } from "bun:test";

for (const command of ["scripts/check-coverage.ts", "scripts/diff-upstream.ts"]) {
  test(`${command} reports all retained version platform pairs without conflating native evidence`, () => {
    const result = Bun.spawnSync(["bun", command, "--all"], {stdout: "pipe", stderr: "pipe", timeout: 60000});
    if(result.exitCode!==0)throw new Error(`${command} failed (${result.exitCode}): ${result.stderr.toString()}`);
    const output = JSON.parse(result.stdout.toString());
    expect(output.pairs).toBeArray();
    expect(output.pairs.map((pair: {hostVersion: string; platform: string}) => `${pair.hostVersion}-${pair.platform}`).sort()).toEqual([
      "18.6.1-darwin", "18.6.1-linux", "18.6.1-win32", "18.8.0-darwin", "18.8.0-linux", "18.8.0-win32", "18.8.4-darwin", "18.8.4-linux", "18.8.4-win32",
      "18.8.7-darwin", "18.8.7-linux", "18.8.7-win32",
    ]);
    for (const pair of output.pairs) expect(pair.evidence).toBe(pair.platform === process.platform ? "native-package-registry" : "source-derived");
  }, 60000);
}

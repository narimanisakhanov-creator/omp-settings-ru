import { expect, test } from "bun:test";

test("CI candidate support rotates the active window", () => {
  const result = Bun.spawnSync(["bun", "scripts/check-matrix.ts", "--ci-matrix", "--candidate", "18.13.4"], {stdout: "pipe", stderr: "pipe"});
  expect(result.exitCode).toBe(0);
  const matrix = JSON.parse(result.stdout.toString());
  expect(matrix.include.map((pair: {version: string}) => pair.version)).toEqual([
    "18.13.2", "18.13.2", "18.13.2", "18.13.3", "18.13.3", "18.13.3", "18.13.4", "18.13.4", "18.13.4",
  ]);
});

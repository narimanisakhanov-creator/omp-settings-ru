import { expect, test } from "bun:test";

 test("CI candidate support is derived without a workflow version-list edit", () => {
  const result = Bun.spawnSync(["bun", "scripts/check-matrix.ts", "--ci-matrix", "--candidate", "18.9.0"], {stdout: "pipe", stderr: "pipe"});
  expect(result.exitCode).toBe(0);
  const matrix = JSON.parse(result.stdout.toString());
  expect(matrix.include.filter((pair: {version: string}) => pair.version === "18.9.0").map((pair: {platform: string}) => pair.platform).sort()).toEqual(["darwin", "linux", "win32"]);
  expect(matrix.include.filter((pair: {version: string}) => pair.version === "18.8.0").map((pair: {platform: string}) => pair.platform).sort()).toEqual(["darwin", "linux", "win32"]);
 });

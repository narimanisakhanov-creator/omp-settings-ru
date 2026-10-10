import { resolve } from "node:path";
import { verifyVariantReviews } from "./verify-variant-reviews";

// Inspect npm's actual allowlisted package, without creating an archive or publishing.
const command = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", "npm.cmd pack --dry-run --json --ignore-scripts"] : ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"];
const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
const out = await new Response(child.stdout).text();
const err = await new Response(child.stderr).text();
if (await child.exited !== 0) throw new Error("package-list-failed: " + err);
const report = JSON.parse(out) as Array<{ files: Array<{ path: string }> }> | Record<string, { files: Array<{ path: string }> }>;
const packages = Array.isArray(report) ? report : Object.values(report);
const files = packages[0]!.files.map(file => file.path).sort();
const allowedRoot: Readonly<Record<string, true>> = { "package.json": true, "README.md": true, "CONTRIBUTING.md": true, "CHANGELOG.md": true, "LICENSE": true, "SECURITY.md": true, "CODE_OF_CONDUCT.md": true };
const failures: string[] = verifyVariantReviews();
for (const path of files) {
  if (!path.startsWith("src/") && !Object.hasOwn(allowedRoot, path)) failures.push("unexpected-file:" + path);
  const text = await Bun.file(resolve(path)).text();
  if (/C:[\\/]Users[\\/]|\/home\/[^\s/]+\/|\/Users\/[^\s/]+\/|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{24,}/.test(text)) failures.push("private-data-pattern:" + path);
}
for (const required of Object.keys(allowedRoot)) if (!files.includes(required)) failures.push("missing-file:" + required);
if (!files.includes("src/index.ts")) failures.push("missing-extension-entry");
const license = await Bun.file("LICENSE").text();
if (!license.includes("Copyright (c) 2026 narimanisakhanov-creator")) failures.push("missing-project-authorship");
console.log(JSON.stringify({ fileCount: files.length, files, failures, ok: failures.length === 0 }, null, 2));
if (failures.length) process.exit(1);

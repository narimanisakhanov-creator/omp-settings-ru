import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run native UI code with no inherited credentials/config paths, in a disposable filesystem.
const root = await mkdtemp(join(tmpdir(), "omp-settings-ru-"));
try {
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home);
  await mkdir(cwd);
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PI_CODING_AGENT_DIR: join(home, ".omp", "agent"), TERM: "xterm-256color" });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "smoke-panel-worker.ts")], { cwd, env, stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally {
  await rm(root, { recursive: true, force: true });
}

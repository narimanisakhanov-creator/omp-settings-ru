import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "omp-measurement-install.lock");

/** Serialize Bun installs across parallel test files; Bun's shared package manager is not concurrent-safe. */
export async function withInstallLock<T>(action: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  let owned = false;
  while (!owned && Date.now() < deadline) {
    try {
      await writeFile(LOCK, String(process.pid), { flag: "wx" });
      owned = true;
    } catch {
      await Bun.sleep(50);
    }
  }
  if (!owned) throw new Error("measurement-install-lock-timeout");
  try {
    return await action();
  } finally {
    await rm(LOCK, { force: true });
  }
}

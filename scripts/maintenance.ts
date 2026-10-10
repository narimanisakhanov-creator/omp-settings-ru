import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hasCompletedActivation, prepareActivation, runUpdate, type UpdateOptions } from "./maintenance/updater";
import type { ReleasePin, UpdateReceipt } from "./maintenance/contracts";

/**
 * Manual pinned updater.
 *
 * The release channel is a tag on `main` plus the assets of its GitHub Release; the package
 * is never published to a registry, and nothing here creates a branch, opens a pull request
 * or writes to any ref. Activation is deliberately manual: it captures the current install
 * as the rollback target before `runUpdate` touches the isolated profile, and the returned
 * receipt is the only claim about what happened.
 */

export interface ManualUpdateOptions extends UpdateOptions {}

/** Capture the previous install once, then run the pinned update. */
export async function runManualUpdate(options: ManualUpdateOptions): Promise<UpdateReceipt> {
  if (options.activate && options.accepted && !await hasCompletedActivation(options)) await prepareActivation(options);
  return runUpdate(options);
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function usage(): never {
  throw new Error("usage: bun scripts/maintenance.ts --pin <release-pin.json> --package <archive.tgz> --state-dir <dir> --executable <omp> [--activate --accepted --profile <name>]");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pinPath = option(args, "--pin");
  const packagePath = option(args, "--package");
  const stateDirectory = option(args, "--state-dir");
  const executable = option(args, "--executable");
  if (!pinPath || !packagePath || !stateDirectory || !executable) usage();
  const activate = args.includes("--activate");
  const accepted = args.includes("--accepted");
  const targetProfile = option(args, "--profile");
  if (activate && !accepted) throw new Error("activation-requires-explicit-acceptance");
  if (activate && !targetProfile) throw new Error("activation-requires-named-profile");
  const pin = JSON.parse(await readFile(resolve(pinPath), "utf8")) as ReleasePin;
  const receipt = await runManualUpdate({
    pin,
    packagePath: resolve(packagePath),
    stateDirectory: resolve(stateDirectory),
    executable,
    activate,
    accepted,
    targetProfile,
  });
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.phase === "blocked") process.exit(1);
}

if (import.meta.main) await main();

import { expect, test } from "bun:test";
import { migrateLegacyInstall, parseRuntimeLock, type ChannelBackup, type MigrationPort } from "../scripts/switch-channel";

for (const failure of ["none", "uninstall", "install", "cleanup"] as const) {
  test(`migration preserves state across ${failure} native transition`, async () => {
    let npm = true;
    let marketplace = false;
    let failed = false;
    let document: Record<string, unknown> = { plugins: { "omp-settings-ru": { version: "0.5.0", enabled: false, enabledFeatures: null, custom: 9 }, foreign: { version: "1.0.0", enabled: true, enabledFeatures: [] } }, settings: { "omp-settings-ru": { count: 7 }, foreign: { retain: true } }, opaque: { retain: [null, 4] } };
    const backup: ChannelBackup = { source: "npm", profile: "proof", state: { version: "0.5.0", enabled: false, enabledFeatures: null }, settings: { count: 7 }, rootFields: { opaque: { retain: [null, 4] } }, pluginFields: { custom: 9 } };
    const port: MigrationPort = {
      readLock: async () => parseRuntimeLock(document),
      writeLock: async value => { document = value; },
      observe: async () => ({ npm: npm ? ["0.5.0"] : [], marketplace }),
      native: async command => {
        const plugins = { ...(document.plugins as Record<string, unknown>) };
        const settings = { ...(document.settings as Record<string, unknown>) };
        document = { plugins, settings };
        if (command[1] === "uninstall") {
          if (command[2] === "omp-settings-ru") { npm = false; delete plugins["omp-settings-ru"]; delete settings["omp-settings-ru"]; if (failure === "uninstall" && !failed) { failed = true; throw Error("partial-uninstall"); } }
          else { if (failure === "cleanup") throw Error("cleanup-denied"); marketplace = false; delete plugins["omp-settings-ru"]; }
        } else if (command[1] === "install") {
          if (command[2]!.startsWith("github:")) npm = true;
          else { marketplace = true; if ((failure === "install" || failure === "cleanup") && !failed) { failed = true; throw Error("partial-install"); } }
          plugins["omp-settings-ru"] = { version: "0.5.0", enabled: true, enabledFeatures: [] };
        }
      },
    };
    if (failure === "none") await migrateLegacyInstall(port, backup, "private-backup.json");
    else await expect(migrateLegacyInstall(port, backup, "private-backup.json")).rejects.toThrow(failure === "cleanup" ? "private-backup.json" : "channel-switch-rolled-back");
    if (failure === "cleanup") { expect(marketplace).toBe(true); expect(npm).toBe(false); return; }
    expect(npm).toBe(failure !== "none"); expect(marketplace).toBe(failure === "none");
    expect(document.opaque).toEqual({ retain: [null, 4] });
    expect((document.plugins as Record<string, unknown>)["omp-settings-ru"]).toEqual({ version: "0.5.0", enabled: false, enabledFeatures: null, custom: 9 });
    expect((document.settings as Record<string, unknown>)["omp-settings-ru"]).toEqual({ count: 7 });
    expect((document.settings as Record<string, unknown>).foreign).toEqual({ retain: true });
  });
}

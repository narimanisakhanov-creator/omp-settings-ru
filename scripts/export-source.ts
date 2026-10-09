import { buildSourceSnapshot } from "../src/report";
import { loadMatrixHost, requestedPairs } from "./matrix-host";
import { getHostMetadata } from "../src/host-adapter";

const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
const output = outputFlag >= 0 ? args[outputFlag + 1] : undefined;
const snapshots = [];
if (args.includes("--native")) {
  const host = await getHostMetadata();
  const version = args.find(value => /^\d+\.\d+\.\d+$/.test(value));
  const platform = args.find(value => value === "win32" || value === "darwin" || value === "linux");
  if (version !== host.version || platform !== host.platform) throw new Error("native-host-identity-mismatch");
  snapshots.push({evidence: "native-package-registry", installedPanel: false, ...buildSourceSnapshot(host)});
} else for (const pair of requestedPairs(args)) {
  const {host, evidence} = await loadMatrixHost(pair.version, pair.platform);
  snapshots.push({evidence, installedPanel: false, ...buildSourceSnapshot(host)});
}
if (output) {
  if (snapshots.length !== 1) throw new Error("--output requires one exact version and platform");
  const {evidence: _evidence, installedPanel: _installedPanel, ...snapshot} = snapshots[0]!;
  await Bun.write(output, JSON.stringify(snapshot, null, 2) + "\n");
} else console.log(JSON.stringify({snapshots}, null, 2));

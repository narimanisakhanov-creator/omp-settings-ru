import { getHostMetadata } from "../src/host-adapter";
import { computeSourceHash, normalizeSource } from "../src/source";
import { descriptionTemplates } from "../src/source-templates";

const host = await getHostMetadata();
const settings = Object.fromEntries(Object.entries(host.schema).filter(([, definition]) => definition?.ui).map(([path, definition]) => {
  const source = normalizeSource(definition!.ui!, descriptionTemplates[path]);
  return [path, { sourceHash: computeSourceHash(source), ...source }];
}));
const result = { version: host.version, platform: host.platform, settings };
const output = process.argv[2];
if (output) await Bun.write(output, JSON.stringify(result, null, 2) + "\n");
else console.log(JSON.stringify(result, null, 2));

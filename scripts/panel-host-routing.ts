export function panelHostRoute(version: string): "legacy" | "modern" {
  if (version === "19.0.1" || version === "19.1.0" || version === "19.1.1") return "legacy";
  if (/^19\.2\.(0|[1-9]\d*)(?![\s\S])/.test(version)) return "modern";
  throw new Error(`unsupported-panel-host-version:${version}`);
}

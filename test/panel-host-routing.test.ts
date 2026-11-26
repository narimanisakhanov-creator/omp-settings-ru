import { expect, test } from "bun:test";
import { panelHostRoute } from "../scripts/panel-host-routing";

test("routes only supported panel host versions", () => {
  for (const version of ["19.2.0", "19.2.1", "19.2.12"]) expect(panelHostRoute(version)).toBe("modern");
  for (const version of ["19.0.1", "19.1.0", "19.1.1"]) expect(panelHostRoute(version)).toBe("legacy");
  for (const version of ["19.3.0", "19.2.01", "19.2.1-rc.1", "19.2.1\n", "19.2", "", "20.2.1"]) {
    expect(() => panelHostRoute(version)).toThrow(`unsupported-panel-host-version:${version}`);
  }
});

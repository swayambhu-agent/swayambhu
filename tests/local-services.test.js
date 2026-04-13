import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  getDefaultServiceUrls,
  resolveLocalServiceConfig,
} from "../lib/local-services.js";

describe("local service helpers", () => {
  it("returns default localhost ports in default mode", () => {
    const config = resolveLocalServiceConfig({ serviceMode: "default" });
    expect(config).toMatchObject({
      mode: "default",
      branch: null,
      kernelPort: 8787,
      dashboardPort: 8790,
    });
  });

  it("builds URLs from the resolved local config", () => {
    const urls = getDefaultServiceUrls({ serviceMode: "default" });
    expect(urls).toEqual({
      kernelUrl: "http://localhost:8787",
      dashboardUrl: "http://localhost:8790",
    });
  });

  it("coerces active state-lab JSON port values to numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-services-"));
    const activeUiPath = join(dir, "active-ui.json");
    try {
      await writeFile(activeUiPath, JSON.stringify({
        branch: "demo",
        kernel_port: "8887",
        dashboard_port: "8890",
      }), "utf8");

      const config = resolveLocalServiceConfig({
        serviceMode: "state_lab_active",
        activeUiPath,
      });

      expect(config).toEqual({
        mode: "state_lab_active",
        branch: "demo",
        kernelPort: 8887,
        dashboardPort: 8890,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

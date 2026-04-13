import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const DEFAULT_STATE_LAB_DIR = process.env.SWAYAMBHU_STATE_LAB_DIR || "/home/swami/swayambhu/state-lab";
export const ACTIVE_UI_PATH = join(DEFAULT_STATE_LAB_DIR, "active-ui.json");

export function readActiveStateLabBranch(activeUiPath = ACTIVE_UI_PATH) {
  if (!existsSync(activeUiPath)) {
    throw new Error(`No active state-lab branch found at ${activeUiPath}`);
  }
  return JSON.parse(readFileSync(activeUiPath, "utf8"));
}

export function resolveLocalServiceConfig({
  serviceMode = process.env.SWAYAMBHU_DEV_LOOP_SERVICE_MODE || (existsSync(ACTIVE_UI_PATH) ? "state_lab_active" : "default"),
  activeUiPath = ACTIVE_UI_PATH,
} = {}) {
  if (serviceMode === "state_lab_active") {
    const active = readActiveStateLabBranch(activeUiPath);
    return {
      mode: "state_lab_active",
      branch: active.branch,
      kernelPort: Number(active.kernel_port),
      dashboardPort: Number(active.dashboard_port),
    };
  }

  return {
    mode: "default",
    branch: null,
    kernelPort: Number(process.env.SWAYAMBHU_KERNEL_PORT || 8787),
    dashboardPort: Number(process.env.SWAYAMBHU_DASHBOARD_PORT || 8790),
  };
}

export function getDefaultServiceUrls(options = {}) {
  const config = resolveLocalServiceConfig(options);
  return {
    kernelUrl: `http://localhost:${config.kernelPort}`,
    dashboardUrl: `http://localhost:${config.dashboardPort}`,
  };
}

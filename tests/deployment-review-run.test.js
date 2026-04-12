import { afterEach, describe, expect, it } from "vitest";

import {
  buildDeploymentReviewDefaults,
  loadRepoDeploymentReviewDefaults,
} from "../scripts/deployment-review-run.mjs";

const ENV_KEYS = [
  "SWAYAMBHU_DEPLOYMENT_REVIEW_RUNNER",
  "SWAYAMBHU_DEPLOYMENT_REVIEW_ADVERSARIAL_RUNNER",
  "SWAYAMBHU_DEPLOYMENT_REVIEW_TIMEOUT_MS",
  "SWAYAMBHU_DEPLOYMENT_REVIEW_ADVERSARIAL_TIMEOUT_MS",
  "SWAYAMBHU_DEPLOYMENT_REVIEW_ADVERSARIAL_MAX_ROUNDS",
  "SWAYAMBHU_DEPLOYMENT_REVIEW_OBSERVATION_MODE",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("deployment-review defaults", () => {
  it("reads deployment_review defaults from config/defaults.json", () => {
    const repoDefaults = loadRepoDeploymentReviewDefaults();
    expect(repoDefaults.review_runner).toBe("codex");
    expect(repoDefaults.adversarial_runner).toBe("claude");
    expect(repoDefaults.review_timeout_ms).toBe(600000);
    expect(repoDefaults.observation_mode).toBe("devloop_30");
  });

  it("lets env override repo deployment_review defaults", () => {
    process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_RUNNER = "claude";
    process.env.SWAYAMBHU_DEPLOYMENT_REVIEW_OBSERVATION_MODE = "live_window";

    const defaults = buildDeploymentReviewDefaults();
    expect(defaults.reviewRunner).toBe("claude");
    expect(defaults.observationMode).toBe("live_window");
    expect(defaults.adversarialMaxRounds).toBe(3);
  });

  it("enables deployment review by default", () => {
    const defaults = buildDeploymentReviewDefaults();
    expect(loadRepoDeploymentReviewDefaults().enabled).toBe(true);
    expect(defaults.reviewRunner).toBeTruthy();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { buildDr3Defaults, loadRepoDr3Defaults, parseArgs } from "../scripts/dr3-lab-run.mjs";

const DR3_ENV_KEYS = [
  "SWAYAMBHU_DR3_REVIEW_RUNNER",
  "SWAYAMBHU_DR3_ADVERSARIAL_RUNNER",
  "SWAYAMBHU_DR3_AUTHOR_RUNNER",
  "SWAYAMBHU_DR3_REVIEW_TIMEOUT_MS",
  "SWAYAMBHU_DR3_ADVERSARIAL_TIMEOUT_MS",
  "SWAYAMBHU_DR3_AUTHOR_TIMEOUT_MS",
  "SWAYAMBHU_DR3_ADVERSARIAL_MAX_ROUNDS",
  "SWAYAMBHU_DR3_SOURCE_REF",
  "SWAYAMBHU_DR3_ALLOW_AUTHORITY_WIDENING",
];

afterEach(() => {
  for (const key of DR3_ENV_KEYS) {
    delete process.env[key];
  }
});

describe("dr3-lab-run defaults", () => {
  it("reads dr3 defaults from config/defaults.json", () => {
    const repoDefaults = loadRepoDr3Defaults();
    expect(repoDefaults.review_runner).toBe("codex");
    expect(repoDefaults.adversarial_runner).toBe("claude");
    expect(repoDefaults.lab_timeout_ms).toBe(600000);
    expect(repoDefaults.allow_authority_widening).toBe(false);
  });

  it("lets env override repo dr3 defaults after dotenv/env load", () => {
    process.env.SWAYAMBHU_DR3_REVIEW_RUNNER = "claude";
    process.env.SWAYAMBHU_DR3_ALLOW_AUTHORITY_WIDENING = "true";

    const defaults = buildDr3Defaults();
    expect(defaults.reviewRunner).toBe("claude");
    expect(defaults.allowAuthorityWidening).toBe(true);
    expect(defaults.labTimeoutMs).toBe(600000);
  });

  it("rejects missing flag values explicitly", () => {
    const defaults = buildDr3Defaults();
    expect(() => parseArgs(["--spec"], defaults)).toThrow("Missing value for --spec");
    expect(() => parseArgs(["--review-note-key"], defaults)).toThrow("Missing value for --review-note-key");
  });
});

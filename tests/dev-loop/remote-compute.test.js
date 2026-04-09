import { describe, it, expect } from "vitest";

import {
  parseDotEnv,
  buildRemoteCleanupCommand,
} from "../../scripts/dev-loop/remote-compute.mjs";

describe("parseDotEnv", () => {
  it("parses simple dotenv content and strips surrounding quotes", () => {
    const parsed = parseDotEnv(`
      # comment
      CF_ACCESS_CLIENT_ID=test-id
      COMPUTER_API_KEY="abc123"
      EMPTY=
    `);

    expect(parsed).toEqual({
      CF_ACCESS_CLIENT_ID: "test-id",
      COMPUTER_API_KEY: "abc123",
      EMPTY: "",
    });
  });
});

describe("buildRemoteCleanupCommand", () => {
  it("cleans the compute-side workspace, reasoning, and jobs surfaces", () => {
    const command = buildRemoteCleanupCommand();
    expect(command).toContain("/home/swayambhu/workspace");
    expect(command).toContain("/home/swayambhu/reasoning");
    expect(command).toContain("/home/swayambhu/jobs");
    expect(command).toContain("find \"$target\" -mindepth 1 -maxdepth 1 -exec rm -rf {} +");
    expect(command).toContain("cat > /home/swayambhu/reasoning/INDEX.md <<'EOF'");
    expect(command).toContain("No local reasoning artifacts are available in this fresh environment yet.");
    expect(command).toContain("find /home/swayambhu -maxdepth 1 -name '.kv_store_pending*'");
    expect(command).toContain("echo READY");
  });
});

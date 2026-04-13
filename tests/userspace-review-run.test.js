import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  createInputReader,
  parseArgs,
  readBundleValue,
  sourceKeyToFilename,
} from "../lib/userspace-review/review-run.js";

describe("userspace review run module", () => {
  it("parses review-run CLI args", () => {
    const args = parseArgs([
      "--review-note-key", "review_note:test",
      "--runner", "claude",
      "--timeout-ms", "1234",
      "--bundle-dir", "/tmp/bundle",
    ]);

    expect(args.reviewNoteKey).toBe("review_note:test");
    expect(args.runner).toBe("claude");
    expect(args.timeoutMs).toBe(1234);
    expect(args.bundleDir).toBe("/tmp/bundle");
  });

  it("maps source keys to stable filenames", () => {
    expect(sourceKeyToFilename("hook:session:code")).toBe("live/userspace.js");
    expect(sourceKeyToFilename("custom:key/with spaces")).toBe("live/custom-key-with-spaces.txt");
  });

  it("reads bundle values from a bundle dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "userspace-review-bundle-"));
    try {
      const bundlePath = join(dir, "review_note", "foo.json");
      await mkdir(join(dir, "review_note"), { recursive: true });
      await writeFile(bundlePath, JSON.stringify({ summary: "ok" }), "utf8");

      await expect(readBundleValue(dir, "review_note:foo")).resolves.toEqual({ summary: "ok" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a bundle dir for bundle input mode", async () => {
    await expect(createInputReader({
      inputSource: "bundle",
      dashboardUrl: "http://localhost:8790",
      patronKey: "test",
      bundleDir: null,
    })).rejects.toThrow("bundle input source requires --bundle-dir");
  });
});

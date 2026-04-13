import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";

const RUNTIME_PATHS = [
  "kernel.js",
  "userspace.js",
  "eval.js",
  "reflect.js",
  "lib/dr2-lab-run.js",
  "lib/dr3-lab-run.js",
  "lib/state-lab/runtime.js",
  "lib/state-lab/lab-run-entry.js",
];

describe("runtime/operator boundaries", () => {
  it("keeps the runtime hot path free of scripts/operator imports", async () => {
    for (const relativePath of RUNTIME_PATHS) {
      const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
      expect(source, `${relativePath} should not depend on scripts/operator`).not.toContain("scripts/operator/");
    }
  });
});

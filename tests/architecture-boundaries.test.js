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

  it("routes model-produced KV operations through the shared boundary helpers", async () => {
    const reflectSource = await readFile(new URL("../reflect.js", import.meta.url), "utf8");
    const userspaceSource = await readFile(new URL("../userspace.js", import.meta.url), "utf8");

    expect(reflectSource).toContain('import { applyModelKvOperations } from "./lib/kv-operation-boundary.js";');
    expect(reflectSource).toContain("await applyModelKvOperations(K, output.kv_operations");
    expect(reflectSource).not.toContain('K.kvWriteGated(op, "reflect")');
    expect(reflectSource).not.toContain('K.kvWriteGated(op, "deep-reflect")');

    expect(userspaceSource).toContain('import { applyModelKvOperations } from "./lib/kv-operation-boundary.js";');
    expect(userspaceSource).toContain("const kvResult = await applyModelKvOperations(K, kvOps");
    expect(userspaceSource).toContain("const kvResult = await applyModelKvOperations(K, ops");
    expect(userspaceSource).not.toContain("function toPrivilegedOp(op)");
    expect(userspaceSource).not.toContain('K.kvWriteGated(toPrivilegedOp(op), "userspace-review")');
    expect(userspaceSource).not.toContain('K.kvWriteGated(toPrivilegedOp(op), "deep-reflect")');
  });
});

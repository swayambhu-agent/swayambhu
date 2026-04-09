import { describe, expect, it } from "vitest";

import {
  buildOverview,
  extractJsonFromString,
  normalizeSpec,
  targetRelativePathForSource,
} from "../../scripts/state-lab-userspace-review.mjs";

describe("normalizeSpec", () => {
  it("accepts mixed string/object file entries and normalizes notes", () => {
    const spec = normalizeSpec({
      question: "What root constraint is causing smuggling?",
      notes: ["trace-first", 123],
      files: [
        "userspace.js",
        { path: "prompts/deep_reflect.md", kind: "prompt" },
      ],
    }, "/tmp/spec.json");

    expect(spec.question).toContain("smuggling");
    expect(spec.notes).toEqual(["trace-first", "123"]);
    expect(spec.files).toEqual([
      { path: "userspace.js", kind: "artifact" },
      { path: "prompts/deep_reflect.md", kind: "prompt" },
    ]);
  });
});

describe("targetRelativePathForSource", () => {
  it("maps repo-local files under repo/", () => {
    const rel = targetRelativePathForSource("/home/swami/swayambhu/repo/userspace.js", 0);
    expect(rel).toBe("repo/userspace.js");
  });

  it("maps external files under external/ with a stable prefix", () => {
    const rel = targetRelativePathForSource("/tmp/outside.json", 3);
    expect(rel).toBe("external/03-outside.json");
  });
});

describe("buildOverview", () => {
  it("renders the question, notes, and manifest entries", () => {
    const overview = buildOverview(
      { question: "Why is smuggling happening?", notes: ["Read traces first."] },
      [{ kind: "analysis", relative_path: "context/files/repo/audit.md", source_path: "/tmp/audit.md" }],
    );
    expect(overview).toContain("Why is smuggling happening?");
    expect(overview).toContain("Read traces first.");
    expect(overview).toContain("context/files/repo/audit.md");
  });
});

describe("extractJsonFromString", () => {
  it("parses direct JSON strings", () => {
    expect(extractJsonFromString("{\"ok\":true}")).toEqual({ ok: true });
  });

  it("parses fenced JSON blocks", () => {
    expect(extractJsonFromString("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
  });
});

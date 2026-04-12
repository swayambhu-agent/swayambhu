import { describe, expect, it } from "vitest";

import {
  buildOverview,
  buildLiveReviewSpec,
  collectDirectSourceKeys,
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

describe("collectDirectSourceKeys", () => {
  it("keeps only direct source-map entries and skips globs", () => {
    const keys = collectDirectSourceKeys({
      userspace: "hook:session:code",
      kernel: "kernel:source:kernel.js",
      reflection: "hook:reflect:code",
      tools: "tool:*:code",
      providers: "provider:*:code",
    });

    expect(keys).toEqual([
      "hook:session:code",
      "kernel:source:kernel.js",
      "hook:reflect:code",
    ]);
  });
});

describe("buildLiveReviewSpec", () => {
  it("builds a compact live bundle from a review note and current surfaces", () => {
    const spec = buildLiveReviewSpec({
      reviewNoteKey: "review_note:userspace_review:x_dr:d1:000:waiting-state-derived-too-narrowly",
      reviewNote: {
        summary: "Established breadth policy was bypassed even though the only live thread was externally blocked.",
        source_reflect_key: "reflect:1:x_dr",
      },
      sourceReflectKey: "reflect:1:x_dr",
      sourceReflect: { reflection: "A divergence was observed." },
      lastReflect: { carry_forward: [{ id: "cf1", item: "Wait for patron auth change." }] },
      defaults: { schedule: { interval_seconds: 1800 } },
      prompts: {
        plan: "Breadth maintenance prompt",
        reflect: "Carry-forward schema prompt",
      },
      sourceMap: {
        userspace: "hook:session:code",
        tools: "tool:*:code",
      },
      sourceTexts: {
        "hook:session:code": "export function runTurn() {}",
      },
    });

    expect(spec.question).toContain("Established breadth policy was bypassed");
    expect(spec.notes[0]).toContain("live review_note");
    expect(spec.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: "live/review-note.json", kind: "analysis" }),
        expect.objectContaining({ filename: "live/source-reflect.json", kind: "trace" }),
        expect.objectContaining({ filename: "live/last-reflect.json", kind: "state" }),
        expect.objectContaining({ filename: "live/config-defaults.json", kind: "doc" }),
        expect.objectContaining({ filename: "live/prompt-plan.md", kind: "prompt" }),
        expect.objectContaining({ filename: "live/prompt-reflect.md", kind: "prompt" }),
        expect.objectContaining({ filename: "live/userspace.js", kind: "code" }),
      ]),
    );
    expect(spec.files.some((entry) => entry.filename.includes("*"))).toBe(false);
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

import { join, resolve } from "path";

import { keyToFilePath as defaultKeyToFilePath } from "../../governor/builder.js";

const ROOT = join(import.meta.dirname, "../..");

export function normalizeSpec(raw, specPath) {
  const files = Array.isArray(raw?.files) ? raw.files : [];
  if (!raw?.question || typeof raw.question !== "string") {
    throw new Error(`Review spec ${specPath} missing string question`);
  }
  if (files.length === 0) {
    throw new Error(`Review spec ${specPath} must include at least one file`);
  }
  return {
    question: raw.question,
    notes: Array.isArray(raw?.notes) ? raw.notes.map(String) : [],
    files: files.map((entry) => {
      if (typeof entry === "string") return { path: entry, kind: "artifact" };
      if (!entry?.path) throw new Error(`Invalid file entry in ${specPath}`);
      return {
        path: String(entry.path),
        kind: entry.kind ? String(entry.kind) : "artifact",
      };
    }),
  };
}

export function targetRelativePathForSource(sourcePath, index) {
  const repoRoot = resolve(ROOT);
  const resolved = resolve(sourcePath);
  if (resolved.startsWith(`${repoRoot}/`)) {
    return join("repo", resolved.slice(repoRoot.length + 1));
  }
  return join("external", `${String(index).padStart(2, "0")}-${resolved.split("/").pop()}`);
}

export function collectDirectSourceKeys(sourceMap = {}) {
  const directKeys = [];
  const seen = new Set();
  for (const value of Object.values(sourceMap || {})) {
    if (typeof value !== "string") continue;
    if (value.includes("*")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    directKeys.push(value);
  }
  return directKeys;
}

function sourceKeyToFilename(sourceKey, keyToFilePath) {
  const repoPath = keyToFilePath(sourceKey);
  if (repoPath) return join("live", repoPath);
  return join("live", `${String(sourceKey).replace(/[^A-Za-z0-9._-]+/g, "-")}.txt`);
}

export function buildLiveReviewSpec({
  reviewNoteKey,
  reviewNote,
  sourceReflectKey = null,
  sourceReflect = null,
  lastReflect = null,
  defaults = null,
  prompts = {},
  sourceMap = null,
  sourceTexts = {},
  keyToFilePath = defaultKeyToFilePath,
}) {
  const summary = String(reviewNote?.summary || "").trim();
  const question = summary
    ? `${summary} What is the smallest userspace-level fix?`
    : `Review ${reviewNoteKey}: identify the smallest userspace-level fix.`;

  const notes = [
    "Generated from a live review_note:* divergence signal.",
    "Use the review note as the primary divergence statement, then inspect the included state, prompt, and source surfaces only as needed.",
    "This bundle is intentionally compact: it includes current live state and direct userspace sources, not full observation snapshots.",
  ];

  const files = [
    {
      filename: join("live", "review-note.json"),
      kind: "analysis",
      content: JSON.stringify({ key: reviewNoteKey, value: reviewNote }, null, 2),
    },
  ];

  if (sourceReflectKey && sourceReflect) {
    files.push({
      filename: join("live", "source-reflect.json"),
      kind: "trace",
      content: JSON.stringify({ key: sourceReflectKey, value: sourceReflect }, null, 2),
    });
  }
  if (lastReflect) {
    files.push({
      filename: join("live", "last-reflect.json"),
      kind: "state",
      content: JSON.stringify({ key: "last_reflect", value: lastReflect }, null, 2),
    });
  }
  if (defaults) {
    files.push({
      filename: join("live", "config-defaults.json"),
      kind: "doc",
      content: JSON.stringify({ key: "config:defaults", value: defaults }, null, 2),
    });
  }
  if (sourceMap) {
    files.push({
      filename: join("live", "kernel-source-map.json"),
      kind: "doc",
      content: JSON.stringify({ key: "kernel:source_map", value: sourceMap }, null, 2),
    });
  }

  for (const [name, content] of Object.entries(prompts || {})) {
    if (!content) continue;
    files.push({
      filename: join("live", `prompt-${name}.md`),
      kind: "prompt",
      content: String(content),
    });
  }

  for (const [sourceKey, sourceText] of Object.entries(sourceTexts || {})) {
    if (!sourceText) continue;
    files.push({
      filename: sourceKeyToFilename(sourceKey, keyToFilePath),
      kind: "code",
      content: String(sourceText),
    });
  }

  return { question, notes, files };
}

export function buildOverview(spec, manifest) {
  return [
    "# Userspace Review Overview",
    "",
    "## Question",
    spec.question,
    "",
    ...(spec.notes.length
      ? ["## Notes", ...spec.notes.map((note) => `- ${note}`), ""]
      : []),
    "## Included Evidence",
    ...manifest.map((entry) => `- ${entry.kind}: ${entry.relative_path} (from ${entry.source_path})`),
    "",
    "Read the behaviorally direct evidence first, then inspect code and prompt surfaces as needed.",
  ].join("\n");
}

export function buildReviewPrompt(basePrompt) {
  return [
    "You are running inside the Swayambhu proto-DR-2 userspace review harness.",
    "The current working directory is an isolated review bundle.",
    `Start with ${join("context", "overview.md")} and ${join("context", "manifest.json")}.`,
    "All evidence files are copied under context/files/.",
    "Do not modify files. Do not browse the web. Respond with JSON only.",
    "",
    basePrompt,
  ].join("\n\n");
}

export function extractJsonFromString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }
  return null;
}

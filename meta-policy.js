function sanitizeKeyPart(value, fallback = "note") {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || fallback;
}

export function normalizeMetaPolicyNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((note) => note && typeof note === "object")
    .map((note) => ({
      slug: note.slug || null,
      summary: note.summary || "",
      subsystem: note.subsystem || null,
      observation: note.observation || "",
      proposed_experiment: note.proposed_experiment || "",
      rationale: note.rationale || "",
      target_review: note.target_review || "userspace_review",
      non_live: note.non_live !== false,
      confidence: typeof note.confidence === "number" ? note.confidence : null,
    }));
}

export function buildMetaPolicyNoteKey(note, { sessionId, depth, index }) {
  const review = sanitizeKeyPart(note?.target_review || "userspace_review", "userspace_review");
  const slug = sanitizeKeyPart(note?.slug || index, "note");
  const ordinal = String(index).padStart(3, "0");
  return `review_note:${review}:${sessionId}:d${depth}:${ordinal}:${slug}`;
}

export async function persistMetaPolicyNotes(
  K,
  notes,
  { sessionId, depth, source, timestamp = new Date().toISOString() },
) {
  const keys = [];
  for (const [index, note] of notes.entries()) {
    const key = buildMetaPolicyNoteKey(note, { sessionId, depth, index });
    keys.push(key);
    const result = await K.kvWriteGated({
      key,
      op: "put",
      value: {
        ...note,
        created_at: timestamp,
        source: source || null,
        source_session_id: sessionId,
        source_depth: depth,
        source_reflect_key: `reflect:${depth}:${sessionId}`,
      },
    }, "deep-reflect");
    if (!result?.ok) {
      throw new Error(`Failed to persist ${key}: ${result?.error || "unknown error"}`);
    }
  }
  return keys;
}

// Swayambhu — Memory utilities
// Pure functions for μ updates, experience selection, and vector math.
// Used by session.js (μ writes, experience selection) and eval.js (embeddings).

// ── Vector math ─────────────────────────────────────────

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function l1Norm(vec) {
  if (!vec || typeof vec !== "object") return 0;
  return Object.values(vec).reduce((sum, v) => sum + Math.abs(v), 0);
}

// ── Pattern strength update ─────────────────────────────

// EMA strength update for patterns. Confirmation (low surprise) moves
// strength toward 1. Violation (high surprise) moves strength toward 0.
// Same α as surprise tracking — they measure the same signal.
const EMA_ALPHA = 0.3;

export function updatePatternStrength(currentStrength, surprise, alpha = EMA_ALPHA) {
  const updated = currentStrength * (1 - alpha) + (1 - surprise) * alpha;
  return Math.max(0, Math.min(1, updated));
}

// ── Experience selection ─────────────────────────────────

export function selectExperiences(experiences, desireEmbeddings, options = {}) {
  const {
    maxEpisodes = 20,
    salienceWeight = 0.7,
    similarityWeight = 0.3,
    lastReflectTimestamp,
  } = options;

  // 1. Recency filter
  let candidates = experiences;
  if (lastReflectTimestamp) {
    const cutoff = new Date(lastReflectTimestamp).getTime();
    const recent = experiences.filter(e => new Date(e.timestamp).getTime() > cutoff);
    candidates = recent.length >= maxEpisodes ? recent : experiences;
  }

  // 2. Score each experience
  // Skip non-canonical entries (e.g. bootstrap_state written directly by act code without
  // going through the eval/review pipeline). Without salience + surprise_score + timestamp,
  // scoring produces NaN which contaminates ranking order.
  const scored = candidates
    .filter(exp => typeof exp.salience === 'number' && typeof exp.surprise_score === 'number' && typeof exp.timestamp === 'string')
    .map(exp => {
    const baseSalience = exp.salience || (exp.surprise_score + l1Norm(exp.affinity_vector));

    // 3. Embedding similarity boost
    let similarityBoost = 0;
    if (exp.embedding && desireEmbeddings.length > 0) {
      similarityBoost = Math.max(
        ...desireEmbeddings.map(de => cosineSimilarity(exp.embedding, de))
      );
    }

    const score = desireEmbeddings.length > 0
      ? salienceWeight * baseSalience + similarityWeight * similarityBoost
      : baseSalience;

    return { experience: exp, score };
  });

  // 4. Sort and limit
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxEpisodes).map(s => s.experience);
}

// ── Inference client ────────────────────────────────────

export async function callInference(baseUrl, secret, path, body, signal = AbortSignal.timeout(20_000)) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "Authorization": `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Inference ${path} failed: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

// ── Embedding cache ─────────────────────────────────────

export function embeddingCacheKey(text, model) {
  const hash = simpleHash(text);
  return `embedding:${hash}:${model}`;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

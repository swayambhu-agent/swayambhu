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

// ── μ update (R operator) ───────────────────────────────

const EMA_ALPHA = 0.3;

export function updateMu(existing, checkId, score, alpha = EMA_ALPHA) {
  const mu = existing ? { ...existing } : {
    check_id: checkId,
    confirmation_count: 0,
    violation_count: 0,
    last_checked: null,
    cumulative_surprise: 0,
  };

  const surprised = score.direction === "contradiction";
  const confirmed = score.direction === "entailment";
  const surpriseValue = score.surprise || 0;

  if (confirmed) mu.confirmation_count += 1;
  if (surprised) mu.violation_count += 1;
  mu.last_checked = new Date().toISOString();

  // EMA: seed on first real update, blend after
  const isFirst = mu.confirmation_count + mu.violation_count <= 1;
  mu.cumulative_surprise = isFirst
    ? surpriseValue
    : alpha * surpriseValue + (1 - alpha) * mu.cumulative_surprise;

  return mu;
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
  const scored = candidates.map(exp => {
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

export async function callInference(baseUrl, secret, path, body) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
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

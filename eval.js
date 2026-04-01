// Swayambhu — Evaluation: three-tier pipeline (Module 4)
// Tier 1: embedding similarity filter, Tier 2: NLI classification,
// Tier 3: LLM fallback for ambiguous pairs. Degrades gracefully.

import { callInference, cosineSimilarity, l1Norm } from './memory.js';

// ── Outcome text extraction ────────────────────────────

function extractOutcomeText(ledger) {
  const parts = [];
  if (ledger.plan?.action) parts.push(ledger.plan.action);
  for (const tc of (ledger.tool_calls || [])) {
    const status = tc.ok ? "succeeded" : "failed";
    const summary = tc.output
      ? (typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output))
      : "";
    parts.push(`${tc.tool} ${status}: ${summary}`.trim());
  }
  if (ledger.final_text) parts.push(ledger.final_text);
  return parts.join(". ");
}

// ── Metric computation ─────────────────────────────────

function computeMetrics(classified, extras) {
  let sigma = 0;
  const assumptionScores = {};
  const alpha = {};

  for (const c of classified) {
    if (c.type === "assumption") {
      const surprise = c.surprise || 0;
      assumptionScores[c.slug] = { direction: c.direction, surprise };
      if (surprise > sigma) sigma = surprise;
    }
    if (c.type === "desire") {
      if (c.direction === "entailment") alpha[c.slug] = c.confidence || 0;
      else if (c.direction === "contradiction") alpha[c.slug] = -(c.confidence || 0);
      else alpha[c.slug] = 0;
    }
  }

  return {
    sigma,
    alpha,
    salience: sigma + l1Norm(alpha),
    assumption_scores: assumptionScores,
    ...extras,
  };
}

// ── Tier 3: LLM classification ─────────────────────────

async function classifyWithLLM(K, pairs, outcomeText) {
  const prompt = `Evaluate the relationship between each statement and the outcome.
Outcome: "${outcomeText}"
Statements: [${pairs.map(p => `{"id":"${p.id}","text":"${p.text}"}`).join(",")}]
For each: classify as entailment/contradiction/neutral + confidence 0-1.
Respond with ONLY a JSON array: [{"id":"...","direction":"...","confidence":0.0-1.0}]`;

  const response = await K.callLLM({
    model: "deepseek",
    effort: "low",
    maxTokens: 1000,
    systemPrompt: "You are a precise classifier. Respond with only JSON.",
    messages: [{ role: "user", content: prompt }],
    step: "eval_tier3",
  });

  const parsed = JSON.parse(response.text);
  const pairMap = Object.fromEntries(pairs.map(p => [p.id, p]));

  return parsed.map(r => {
    const pair = pairMap[r.id];
    if (!pair) return null;
    return {
      ...pair,
      direction: r.direction,
      confidence: r.confidence,
      surprise: r.direction === "contradiction" ? r.confidence : 0,
    };
  }).filter(Boolean);
}

// ── Main pipeline ──────────────────────────────────────

export async function evaluateAction(K, ledger, desires, assumptions, config) {
  const toolOutcomes = (ledger.tool_calls || []).map(tc => ({
    tool: tc.tool,
    ok: tc.ok,
  }));

  const candidateCheckIds = Object.values(assumptions).map(a => a.slug);

  const baseResult = {
    eval_method: "pipeline",
    tool_outcomes: toolOutcomes,
    plan_success_criteria: ledger.plan.success,
    assumptions_relied_on: ledger.plan.relies_on || [],
    candidate_check_ids: candidateCheckIds,
  };

  const desireEntries = Object.entries(desires);
  const assumptionEntries = Object.entries(assumptions);

  // Empty assumptions → maximum surprise (σ = 1). Having no model of the
  // world means you cannot predict anything — that is maximum uncertainty,
  // not minimum surprise. This is what bootstraps the agent: the first
  // session records a high-salience experience, reflect picks it up, and
  // derives initial desires from principles.
  //
  // Empty desires → zero affinity (α = {}). An experience is memorable on
  // the desire axis when it is strongly aligned or misaligned with what you
  // want. With no desires there is no vector to measure against — affinity
  // is genuinely zero, not max. The surprise axis alone drives salience
  // during bootstrap.
  if (assumptionEntries.length === 0) {
    return {
      sigma: 1,
      alpha: {},
      salience: 1,
      assumption_scores: {},
      ...baseResult,
    };
  }

  // Build pairs
  const pairs = [];
  for (const [key, d] of desireEntries) {
    pairs.push({
      id: key,
      type: "desire",
      slug: d.slug,
      text: d.description,
      embedding: d._embedding || null,
    });
  }
  for (const [key, a] of assumptionEntries) {
    pairs.push({
      id: key,
      type: "assumption",
      slug: a.slug,
      text: a.check,
      embedding: a._embedding || null,
    });
  }

  const outcomeText = extractOutcomeText(ledger);

  try {
    // ── Tier 1: Embedding relevance filter ──
    const embedResp = await callInference(config.url, config.secret, "/embed", {
      texts: [outcomeText],
    });
    const outcomeEmb = embedResp.embeddings[0];

    const relevant = pairs.filter(p => {
      if (!p.embedding) return true;
      return cosineSimilarity(outcomeEmb, p.embedding) >= config.relevance_threshold;
    });

    // If nothing relevant after filtering, all pairs are classified as neutral
    if (relevant.length === 0) {
      const neutralClassified = pairs.map(p => ({
        ...p,
        direction: "neutral",
        confidence: 0,
        surprise: 0,
      }));
      return computeMetrics(neutralClassified, baseResult);
    }

    // ── Tier 2: NLI classification ──
    const nliResp = await callInference(config.url, config.secret, "/nli", {
      pairs: relevant.map(p => ({ id: p.id, premise: p.text, hypothesis: outcomeText })),
    });

    const pairMap = Object.fromEntries(relevant.map(p => [p.id, p]));
    const resolved = [];
    const ambiguous = [];

    for (const r of nliResp.results) {
      const pair = pairMap[r.id];
      if (!pair) continue;
      const maxScore = Math.max(r.scores.entailment, r.scores.contradiction, r.scores.neutral);
      if (maxScore >= config.ambiguity_threshold) {
        resolved.push({
          ...pair,
          direction: r.label,
          confidence: r.scores[r.label],
          surprise: r.scores.contradiction,
        });
      } else {
        ambiguous.push(pair);
      }
    }

    // ── Tier 3: LLM for ambiguous pairs ──
    let llmClassified = [];
    if (ambiguous.length > 0) {
      llmClassified = await classifyWithLLM(K, ambiguous, outcomeText);
    }

    // Include pairs filtered out by Tier 1 as neutral
    const filteredOut = pairs.filter(p => !relevant.includes(p)).map(p => ({
      ...p,
      direction: "neutral",
      confidence: 0,
      surprise: 0,
    }));

    const allClassified = [...resolved, ...llmClassified, ...filteredOut];
    return computeMetrics(allClassified, baseResult);

  } catch (_err) {
    // ── Full LLM fallback ──
    try {
      const llmClassified = await classifyWithLLM(K, pairs, outcomeText);
      return computeMetrics(llmClassified, { ...baseResult, eval_method: "llm_fallback" });
    } catch (_fallbackErr) {
      // Degraded: return zeros
      return {
        sigma: 0,
        alpha: {},
        salience: 0,
        assumption_scores: {},
        ...baseResult,
        eval_method: "degraded",
      };
    }
  }
}

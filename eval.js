// Swayambhu — Evaluation: three-tier pipeline (Module 4)
// Tier 1: embedding similarity filter, Tier 2: NLI classification,
// Tier 3: LLM fallback for ambiguous pairs. Degrades gracefully.

import { callInference, cosineSimilarity } from './memory.js';

// ── Outcome text extraction ────────────────────────────

// Cap per-tool summary and total outcome text to prevent context explosion in eval.
// Large tool outputs (grep /proc, broad find, big file reads) inflate the eval LLM call
// without adding classification signal — the relevant evidence is always near the start.
const MAX_TOOL_SUMMARY = 1000;
const MAX_OUTCOME_TEXT = 8000;

function extractOutcomeText(ledger) {
  const parts = [];
  if (ledger.plan?.action) parts.push(ledger.plan.action);
  for (const tc of (ledger.tool_calls || [])) {
    const status = tc.ok ? "succeeded" : "failed";
    const raw = tc.output
      ? (typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output))
      : "";
    const summary = raw.length > MAX_TOOL_SUMMARY ? raw.slice(0, MAX_TOOL_SUMMARY) + " [truncated]" : raw;
    parts.push(`${tc.tool} ${status}: ${summary}`.trim());
  }
  if (ledger.final_text) parts.push(ledger.final_text);
  const full = parts.join(". ");
  return full.length > MAX_OUTCOME_TEXT ? full.slice(0, MAX_OUTCOME_TEXT) + " [truncated]" : full;
}

// ── Metric computation ─────────────────────────────────

function getSourcePrinciples(desires, key) {
  const principles = desires?.[key]?.source_principles;
  return Array.isArray(principles) && principles.length > 0 ? principles : [];
}

function extractPlanGuidance(plan = {}) {
  const legacyReliesOn = Array.isArray(plan?.relies_on)
    ? plan.relies_on.filter(key => typeof key === "string")
    : [];

  const servedDesires = Array.isArray(plan?.serves_desires)
    ? plan.serves_desires.filter(key => typeof key === "string" && key.startsWith("desire:"))
    : legacyReliesOn.filter(key => key.startsWith("desire:"));

  const followedTactics = Array.isArray(plan?.follows_tactics)
    ? plan.follows_tactics.filter(key => typeof key === "string" && key.startsWith("tactic:"))
    : legacyReliesOn.filter(key => key.startsWith("tactic:"));

  const guidingPatterns = Array.isArray(plan?.uses_patterns)
    ? plan.uses_patterns.filter(key => typeof key === "string" && key.startsWith("pattern:"))
    : legacyReliesOn.filter(key => key.startsWith("pattern:"));

  return { servedDesires, followedTactics, guidingPatterns };
}

function computeDesireAxis(alpha, desires) {
  const active = Object.entries(alpha).filter(([, value]) => typeof value === "number" && value !== 0);
  if (active.length === 0) return 0;

  const weighted = active.map(([key, value]) => {
    const mine = getSourcePrinciples(desires, key);
    const overlap = active.filter(([otherKey]) => {
      if (otherKey === key || mine.length === 0) return false;
      const theirs = getSourcePrinciples(desires, otherKey);
      return theirs.some(principle => mine.includes(principle));
    }).length;

    const weight = 1 / Math.sqrt(Math.max(1, mine.length) * (1 + overlap));
    return { affinity: Math.abs(value), weight };
  });

  const denominator = weighted.reduce((sum, item) => sum + item.weight ** 2, 0);
  if (denominator === 0) return 0;

  const numerator = weighted.reduce((sum, item) => sum + (item.weight * item.affinity) ** 2, 0);
  return Math.sqrt(numerator / denominator);
}

function computeMetrics(classified, extras, desires, options = {}) {
  let sigma = typeof options.baseSigma === "number" ? options.baseSigma : 0;
  const patternScores = {};
  const alpha = { ...(options.desireAlpha || {}) };

  for (const c of classified) {
    if (c.type === "pattern") {
      const surprise = c.surprise || 0;
      patternScores[c.id] = { direction: c.direction, surprise };
      if (surprise > sigma) sigma = surprise;
    }
  }

  const desireAxis = computeDesireAxis(alpha, desires);
  const salience = 1 - (1 - sigma) * (1 - desireAxis);

  return {
    sigma,
    alpha,
    desire_axis: desireAxis,
    salience,
    pattern_scores: patternScores,
    ...extras,
  };
}

// ── Tier 3: LLM classification ─────────────────────────

async function classifyWithLLM(K, pairs, outcomeText, signal) {
  const prompt = `Evaluate the relationship between each statement and the outcome.
Outcome: "${outcomeText}"
Statements: [${pairs.map(p => `{"id":"${p.id}","text":"${p.text}"}`).join(",")}]
For each: classify as entailment/contradiction/neutral + confidence 0-1.
Important: many statements describe conditional patterns ("when X happens, Y occurs").
If the outcome does not mention the triggering condition at all, classify as NEUTRAL —
absence of the trigger is not a contradiction. Only classify as contradiction when the
trigger IS present but the expected outcome did NOT occur.
Respond with ONLY a JSON array: [{"id":"...","direction":"...","confidence":0.0-1.0}]`;

  const response = await K.callLLM({
    model: "deepseek",
    effort: "low",
    maxTokens: 1000,
    systemPrompt: "You are a precise classifier. Respond with only JSON.",
    messages: [{ role: "user", content: prompt }],
    step: "eval_tier3",
    signal,
  });

  const parsed = JSON.parse(response.content);
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

async function classifyPlanProgress(K, ledger, outcomeText, config, signal) {
  const successText = ledger?.plan?.success;
  if (!successText) {
    return { direction: "neutral", confidence: 0, source: "none" };
  }

  try {
    const nliResp = await callInference(config.url, config.secret, "/nli", {
      pairs: [{ id: "__plan_success__", premise: successText, hypothesis: outcomeText }],
    }, signal);
    const result = nliResp.results?.find(r => r.id === "__plan_success__") || nliResp.results?.[0];
    if (result) {
      const maxScore = Math.max(result.scores.entailment, result.scores.contradiction, result.scores.neutral);
      if (maxScore >= config.ambiguity_threshold) {
        return {
          direction: result.label,
          confidence: result.scores[result.label],
          source: "nli",
        };
      }
    }
  } catch {}

  try {
    const llmClassified = await classifyWithLLM(K, [{
      id: "__plan_success__",
      type: "plan_success",
      text: successText,
    }], outcomeText, signal);
    if (llmClassified[0]) {
      return {
        direction: llmClassified[0].direction,
        confidence: llmClassified[0].confidence || 0,
        source: "llm",
      };
    }
  } catch {}

  return { direction: "neutral", confidence: 0, source: "degraded" };
}

function computeDesireAlpha(servedDesires, progress) {
  if (!Array.isArray(servedDesires) || servedDesires.length === 0) return {};
  if (progress?.direction !== "entailment") return {};
  const confidence = progress?.confidence || 0;
  if (confidence <= 0) return {};
  return Object.fromEntries(servedDesires.map(key => [key, confidence]));
}

// ── Main pipeline ──────────────────────────────────────

export async function evaluateAction(K, ledger, desires, patterns, config, signal) {
  const toolOutcomes = (ledger.tool_calls || []).map(tc => ({
    tool: tc.tool,
    ok: tc.ok,
  }));
  const { servedDesires, followedTactics, guidingPatterns } = extractPlanGuidance(ledger.plan || {});

  const baseResult = {
    eval_method: "pipeline",
    tool_outcomes: toolOutcomes,
    plan_success_criteria: ledger.plan.success,
    served_desires: servedDesires,
    followed_tactics: followedTactics,
    patterns_relied_on: guidingPatterns,
  };

  const desireEntries = Object.entries(desires);
  const patternEntries = Object.entries(patterns);

  // Empty patterns → maximum surprise (σ = 1). Having no model of the
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
  if (patternEntries.length === 0 && desireEntries.length === 0) {
    return {
      sigma: 1,
      alpha: {},
      desire_axis: 0,
      salience: 1,
      pattern_scores: {},
      ...baseResult,
    };
  }

  // Build pairs
  const pairs = [];
  for (const [key, s] of patternEntries) {
    pairs.push({
      id: key,
      type: "pattern",
      slug: key,
      text: s.pattern,
      embedding: s._embedding || null,
    });
  }

  const outcomeText = extractOutcomeText(ledger);
  const progress = servedDesires.length > 0
    ? await classifyPlanProgress(K, ledger, outcomeText, config, signal)
    : { direction: "neutral", confidence: 0, source: "none" };
  const desireAlpha = computeDesireAlpha(servedDesires, progress);

  try {
    // ── Tier 1: Embedding relevance filter ──
    let relevant = pairs;
    if (pairs.length > 0) {
      const embedResp = await callInference(config.url, config.secret, "/embed", {
        texts: [outcomeText],
      }, signal);
      const outcomeEmb = embedResp.embeddings[0];

      relevant = pairs.filter(p => {
        if (!p.embedding) return true;
        return cosineSimilarity(outcomeEmb, p.embedding) >= config.relevance_threshold;
      });
    }

    // If nothing relevant after filtering, all pairs are classified as neutral
    if (relevant.length === 0) {
      const neutralClassified = pairs.map(p => ({
        ...p,
        direction: "neutral",
        confidence: 0,
        surprise: 0,
      }));
      return computeMetrics(
        neutralClassified,
        baseResult,
        desires,
        {
          baseSigma: patternEntries.length === 0 ? 1 : 0,
          desireAlpha,
        },
      );
    }

    // ── Tier 2: NLI classification ──
    const nliResp = await callInference(config.url, config.secret, "/nli", {
      pairs: relevant.map(p => ({ id: p.id, premise: p.text, hypothesis: outcomeText })),
    }, signal);

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
      llmClassified = await classifyWithLLM(K, ambiguous, outcomeText, signal);
    }

    // Include pairs filtered out by Tier 1 as neutral
    const filteredOut = pairs.filter(p => !relevant.includes(p)).map(p => ({
      ...p,
      direction: "neutral",
      confidence: 0,
      surprise: 0,
    }));

    const allClassified = [...resolved, ...llmClassified, ...filteredOut];
    return computeMetrics(
      allClassified,
      baseResult,
      desires,
      {
        baseSigma: patternEntries.length === 0 ? 1 : 0,
        desireAlpha,
      },
    );

  } catch (_err) {
    // ── Full LLM fallback ──
    try {
      const llmClassified = pairs.length > 0
        ? await classifyWithLLM(K, pairs, outcomeText, signal)
        : [];
      return computeMetrics(
        llmClassified,
        { ...baseResult, eval_method: "llm_fallback" },
        desires,
        {
          baseSigma: patternEntries.length === 0 ? 1 : 0,
          desireAlpha,
        },
      );
    } catch (_fallbackErr) {
      // Degraded: return zeros
      return {
        sigma: 0,
        alpha: {},
        desire_axis: 0,
        salience: 0,
        pattern_scores: {},
        ...baseResult,
        eval_method: "degraded",
      };
    }
  }
}

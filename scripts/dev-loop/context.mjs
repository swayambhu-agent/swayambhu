// Context assembly — transforms analysis + classify output + rubric
// into a single context.json package for Claude Code to analyze.

import { readFile } from "fs/promises";
import { join } from "path";

const RUBRIC_PATH = join(import.meta.dirname, "rubric.json");
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || "http://localhost:8790";
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";

let _rubricCache = null;

async function loadRubric() {
  if (_rubricCache) return _rubricCache;
  const raw = await readFile(RUBRIC_PATH, "utf8");
  _rubricCache = JSON.parse(raw);
  return _rubricCache;
}

/**
 * Build a context package from analysis data, mechanical issues, and rubric.
 *
 * @param {object} opts
 * @param {object} opts.analysis - Output of analyze-sessions.mjs
 * @param {string} opts.sessionId - Latest session ID
 * @param {number} opts.cycle - Current dev-loop cycle number
 * @param {string} opts.strategy - Observation strategy used (e.g. "accumulate", "cold_start")
 * @param {Array}  opts.mechanicalIssues - Issues from classify stage
 * @returns {Promise<object>} Context package
 */
export async function buildContextFromAnalysis({
  analysis,
  sessionId,
  cycle,
  strategy,
  mechanicalIssues = [],
}) {
  const rubric = await loadRubric();

  // Ensure we have the act session's karma, not just the most-recent tick's.
  // analyze-sessions uses a recency heuristic that can be shadowed by post-act ticks.
  const karma = { ...(analysis.karma || {}) };
  if (sessionId) {
    const actKarmaKey = `karma:${sessionId}`;
    if (!karma[actKarmaKey]) {
      try {
        const keys = encodeURIComponent(actKarmaKey);
        const res = await fetch(`${DASHBOARD_URL}/kv/multi?keys=${keys}`, {
          headers: { "X-Patron-Key": DASHBOARD_KEY },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data[actKarmaKey]) karma[actKarmaKey] = data[actKarmaKey];
        }
      } catch {
        // Fall back to whatever analysis returned
      }
    }
  }

  return {
    meta: {
      generated_at: new Date().toISOString(),
      cycle,
      strategy,
      scope: "current_snapshot",
    },
    session_id: sessionId,
    karma,
    desires: analysis.desires || {},
    patterns: analysis.patterns || {},
    experiences: analysis.experiences || {},
    tactics: analysis.tactics || {},
    config: {
      defaults: analysis.defaults || {},
      models: analysis.models || {},
    },
    prompts: analysis.prompts || {},
    last_reflect: analysis.last_reflect || null,
    dr_state: analysis.dr_state || null,
    session_health: analysis.session_health || null,
    rubric,
    mechanical_issues: mechanicalIssues,
  };
}

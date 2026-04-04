// Context assembly — transforms analysis + classify output + rubric
// into a single context.json package for Claude Code to analyze.

import { readFile } from "fs/promises";
import { join } from "path";

const RUBRIC_PATH = join(import.meta.dirname, "rubric.json");

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

  return {
    meta: {
      generated_at: new Date().toISOString(),
      cycle,
      strategy,
      scope: "current_snapshot",
    },
    session_id: sessionId,
    karma: analysis.karma || {},
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

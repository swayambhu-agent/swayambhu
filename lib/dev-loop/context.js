import { readFile } from "fs/promises";
import { join } from "path";
import { getDefaultServiceUrls } from "../local-services.js";

const RUBRIC_PATH = join(import.meta.dirname, "../../scripts/operator/dev-loop/rubric.json");
const DEFAULT_URLS = getDefaultServiceUrls();
const DASHBOARD_URL = process.env.SWAYAMBHU_DASHBOARD_URL || DEFAULT_URLS.dashboardUrl;
const DASHBOARD_KEY = process.env.SWAYAMBHU_PATRON_KEY || process.env.PATRON_KEY || "test";

let rubricCache = null;

export async function loadRubric() {
  if (rubricCache) return rubricCache;
  const raw = await readFile(RUBRIC_PATH, "utf8");
  rubricCache = JSON.parse(raw);
  return rubricCache;
}

export async function buildContextFromAnalysis({
  analysis,
  sessionId,
  cycle,
  strategy,
  mechanicalIssues = [],
}) {
  const rubric = await loadRubric();

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
    review_notes: analysis.review_notes || {},
    config: {
      defaults: analysis.defaults || {},
      models: analysis.models || {},
    },
    prompts: analysis.prompts || {},
    last_reflect: analysis.last_reflect || null,
    reflections: analysis.reflections || {},
    dr_state: analysis.dr_state || null,
    session_health: analysis.session_health || null,
    rubric,
    mechanical_issues: mechanicalIssues,
  };
}

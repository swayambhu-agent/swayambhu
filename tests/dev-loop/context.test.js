import { describe, it, expect } from 'vitest';
import { buildContextFromAnalysis } from '../../lib/dev-loop/context.js';

const MOCK_ANALYSIS = {
  desires: {
    'desire:learn': { slug: 'learn', direction: 'approach', description: 'Learn from experience' },
  },
  patterns: {
    'pattern:feedback_loop': { pattern: 'Feedback improves output', strength: 0.8 },
  },
  experiences: {
    'experience:1': { summary: 'First session', salience: 0.9 },
  },
  karma: {
    'karma:001': { event: 'session_start', ts: '2026-04-04T00:00:00Z' },
  },
  defaults: { act_model: 'claude-sonnet-4-20250514', session_budget: 0.50 },
  models: { alias_map: { deepseek: 'deepseek/deepseek-v3.2' } },
  last_reflect: { session: 3, ts: '2026-04-03T12:00:00Z' },
  dr_state: { status: 'idle' },
  tactics: { 'tactic:probe': { description: 'Probe for info' } },
  prompts: { 'prompt:deep_reflect': '# Deep reflect prompt' },
  review_notes: {
    'review_note:userspace_review:x_dr:d1:000:missing-meta-policy-surface': {
      slug: 'missing-meta-policy-surface',
      summary: 'Need a non-live meta-policy bucket.',
      source_depth: 1,
    },
  },
  reflections: {
    'reflect:1:s_1': {
      session_id: 's_1',
      reflection: 'A structural issue was noticed.',
      meta_policy_notes: [
        { slug: 'missing-meta-policy-surface', summary: 'Need a non-live meta-policy bucket.' },
      ],
    },
  },
  session_health: { sessions_since_reflect: 2 },
};

const MOCK_ISSUES = [
  { id: 'abc123', summary: 'Desire uses avoidance framing', locus: 'desire:avoid_errors', severity: 'medium' },
];

describe('buildContextFromAnalysis', () => {
  it('populates meta fields', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: MOCK_ANALYSIS,
      sessionId: 's_test_001',
      cycle: 5,
      strategy: 'accumulate',
      mechanicalIssues: [],
    });

    expect(ctx.meta.cycle).toBe(5);
    expect(ctx.meta.strategy).toBe('accumulate');
    expect(ctx.meta.scope).toBe('current_snapshot');
    expect(ctx.meta.generated_at).toBeTruthy();
    // ISO timestamp format
    expect(() => new Date(ctx.meta.generated_at)).not.toThrow();
    expect(new Date(ctx.meta.generated_at).toISOString()).toBe(ctx.meta.generated_at);
  });

  it('passes through session_id', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: MOCK_ANALYSIS,
      sessionId: 's_test_002',
      cycle: 1,
      strategy: 'cold_start',
    });

    expect(ctx.session_id).toBe('s_test_002');
  });

  it('includes desires, patterns, experiences from analysis', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: MOCK_ANALYSIS,
      sessionId: 's_test_001',
      cycle: 1,
      strategy: 'accumulate',
    });

    expect(ctx.desires).toEqual(MOCK_ANALYSIS.desires);
    expect(ctx.patterns).toEqual(MOCK_ANALYSIS.patterns);
    expect(ctx.experiences).toEqual(MOCK_ANALYSIS.experiences);
  });

  it('includes mechanical_issues array', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: MOCK_ANALYSIS,
      sessionId: 's_test_001',
      cycle: 2,
      strategy: 'accumulate',
      mechanicalIssues: MOCK_ISSUES,
    });

    expect(ctx.mechanical_issues).toEqual(MOCK_ISSUES);
    expect(ctx.mechanical_issues).toHaveLength(1);
  });

  it('defaults mechanical_issues to empty array', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: MOCK_ANALYSIS,
      sessionId: 's_test_001',
      cycle: 0,
      strategy: 'cold_start',
    });

    expect(ctx.mechanical_issues).toEqual([]);
  });

  it('loads rubric with quality_lenses and design_principles', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: MOCK_ANALYSIS,
      sessionId: 's_test_001',
      cycle: 1,
      strategy: 'accumulate',
    });

    expect(ctx.rubric).toBeDefined();
    expect(Array.isArray(ctx.rubric.quality_lenses)).toBe(true);
    expect(ctx.rubric.quality_lenses.length).toBeGreaterThan(0);
    expect(Array.isArray(ctx.rubric.design_principles)).toBe(true);
    expect(ctx.rubric.design_principles.length).toBeGreaterThan(0);
    // Spot-check a known lens
    expect(ctx.rubric.quality_lenses.some(l => l.name === 'elegance')).toBe(true);
  });

  it('handles missing analysis fields gracefully', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: {},
      sessionId: 's_empty',
      cycle: 0,
      strategy: 'cold_start',
    });

    expect(ctx.karma).toEqual({});
    expect(ctx.desires).toEqual({});
    expect(ctx.patterns).toEqual({});
    expect(ctx.experiences).toEqual({});
    expect(ctx.tactics).toEqual({});
    expect(ctx.review_notes).toEqual({});
    expect(ctx.config).toEqual({ defaults: {}, models: {} });
    expect(ctx.prompts).toEqual({});
    expect(ctx.last_reflect).toBeNull();
    expect(ctx.reflections).toEqual({});
    expect(ctx.dr_state).toBeNull();
    expect(ctx.session_health).toBeNull();
  });

  it('includes config, prompts, and other analysis fields', async () => {
    const ctx = await buildContextFromAnalysis({
      analysis: MOCK_ANALYSIS,
      sessionId: 's_test_001',
      cycle: 3,
      strategy: 'accumulate',
    });

    expect(ctx.config.defaults).toEqual(MOCK_ANALYSIS.defaults);
    expect(ctx.config.models).toEqual(MOCK_ANALYSIS.models);
    expect(ctx.prompts).toEqual(MOCK_ANALYSIS.prompts);
    expect(ctx.review_notes).toEqual(MOCK_ANALYSIS.review_notes);
    expect(ctx.last_reflect).toEqual(MOCK_ANALYSIS.last_reflect);
    expect(ctx.reflections).toEqual(MOCK_ANALYSIS.reflections);
    expect(ctx.dr_state).toEqual(MOCK_ANALYSIS.dr_state);
    expect(ctx.karma).toEqual(MOCK_ANALYSIS.karma);
    expect(ctx.tactics).toEqual(MOCK_ANALYSIS.tactics);
    expect(ctx.session_health).toEqual(MOCK_ANALYSIS.session_health);
  });
});

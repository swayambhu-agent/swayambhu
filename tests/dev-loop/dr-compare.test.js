import { describe, it, expect } from 'vitest';
import {
  buildComparePrompt,
  buildCompactSnapshotSummary,
  scoreDrPayload,
  compareScoredOutputs,
  rewriteReasoningPathRefs,
} from '../../scripts/dev-loop/dr-compare.mjs';

describe('buildComparePrompt', () => {
  it('wraps the base prompt with local snapshot instructions', () => {
    const prompt = buildComparePrompt('Read /home/swayambhu/reasoning/INDEX.md\n\nBASE PROMPT', { reasoningDir: './reasoning' });

    expect(prompt).toContain('dev-loop deep-reflect comparison harness');
    expect(prompt).toContain('treat references to /home/swayambhu/reasoning/ as ./reasoning/.');
    expect(prompt).toContain('summary/state.compact.json');
    expect(prompt).toContain('Respond with only the JSON object');
    expect(prompt).toContain('BASE PROMPT');
    expect(prompt).not.toContain('/home/swayambhu/reasoning/INDEX.md');
    expect(prompt).toContain('./reasoning/INDEX.md');
  });
});

describe('rewriteReasoningPathRefs', () => {
  it('rewrites literal reasoning archive paths to the frozen snapshot path', () => {
    const rewritten = rewriteReasoningPathRefs(
      'Open /home/swayambhu/reasoning/INDEX.md and /home/swayambhu/reasoning/tasks.md',
      './reasoning',
    );
    expect(rewritten).toBe('Open ./reasoning/INDEX.md and ./reasoning/tasks.md');
  });
});

describe('buildCompactSnapshotSummary', () => {
  it('omits bulky embeddings and raw tool blobs while preserving cognitive facts', () => {
    const compact = buildCompactSnapshotSummary({
      'principle:reflection': 'I regularly examine my reasoning.',
      'desire:live-situational-direction': {
        slug: 'live-situational-direction',
        direction: 'approach',
        description: 'I have enough live situational awareness to identify a concrete next task.',
      },
      'experience:1': {
        timestamp: '2026-04-06T10:00:00.000Z',
        observation: 'A sweep found foundational desires stranded in artifacts.',
        desire_alignment: { top_positive: [], top_negative: [], affinity_magnitude: 0 },
        pattern_delta: { sigma: 1, scores: [] },
        salience: 1,
        embedding: Array.from({ length: 10 }, (_, i) => i),
        text_rendering: { narrative: 'Compact narrative' },
      },
      'action:a_1': {
        kind: 'action',
        timestamp: '2026-04-06T10:05:00.000Z',
        tool_calls: [{ tool: 'kv_manifest', ok: true, output_preview: 'large...' }],
        final_text: 'Reported the persistence issue.',
        eval: { sigma: 1, patterns_relied_on: ['desire:live-situational-direction'] },
      },
      'last_reflect': { carry_forward: [] },
      'config:defaults': { deep_reflect: { default_interval_sessions: 20 } },
      'kernel:source_map': { userspace: 'userspace.js' },
    });

    expect(compact.state.principles).toHaveLength(1);
    expect(compact.state.desires).toHaveLength(1);
    expect(compact.experiences[0].observation).toContain('stranded in artifacts');
    expect(compact.experiences[0].embedding).toBeUndefined();
    expect(compact.actions[0].tool_names).toEqual(['kv_manifest']);
    expect(compact.actions[0].tool_ok).toEqual([{ tool: 'kv_manifest', ok: true, error: null }]);
  });
});

describe('scoreDrPayload', () => {
  const snapshot = {
    'desire:existing': {
      slug: 'existing',
      direction: 'approach',
      description: 'I understand the current patron context.',
      source_principles: ['principle:care'],
    },
    'last_reflect': {
      carry_forward: [
        {
          id: 'cf-existing',
          item: 'Keep watching the runtime trace',
          why: 'Observability is still stabilizing',
          priority: 'medium',
          status: 'active',
          created_at: '2026-04-06T10:00:00.000Z',
          updated_at: '2026-04-06T10:00:00.000Z',
          expires_at: '2026-04-13T10:00:00.000Z',
          desire_key: 'desire:existing',
        },
      ],
    },
  };

  it('scores a grounded DR payload higher than an invalid one', () => {
    const strong = scoreDrPayload({
      reflection: 'Bootstrap experience should seed a concrete self-knowledge desire.',
      note_to_future_self: 'Check whether the next act uses the seeded desire.',
      kv_operations: [
        {
          key: 'desire:self-knowledge',
          value: {
            slug: 'self-knowledge',
            direction: 'approach',
            description: 'I understand my current operating context and constraints.',
            source_principles: ['principle:care'],
          },
        },
        {
          key: 'pattern:bootstrap:no-action-seeds-desire',
          value: {
            pattern: 'Repeated no-action bootstrap sessions create salient substrate for desire formation.',
            strength: 0.3,
          },
        },
      ],
      carry_forward: [
        {
          id: 'cf1',
          item: 'Inspect the first post-bootstrap act session',
          why: 'Confirms whether the new desire changes behavior',
          priority: 'high',
          status: 'active',
          created_at: '2026-04-06T12:00:00.000Z',
          updated_at: '2026-04-06T12:00:00.000Z',
          expires_at: '2026-04-13T12:00:00.000Z',
          desire_key: 'desire:self-knowledge',
        },
      ],
      reasoning_artifacts: [],
      code_stage_requests: [],
      deploy: false,
      next_reflect: { after_sessions: 5, after_days: 3 },
    }, snapshot);

    const weak = scoreDrPayload({
      reflection: '',
      kv_operations: [
        {
          key: 'kernel:bad',
          value: { nope: true },
        },
        {
          key: 'pattern:advice',
          value: {
            pattern: 'Should always do the safe thing',
            strength: 1.8,
          },
        },
        {
          key: 'desire:existing',
          value: {
            slug: 'existing',
            direction: 'avoid',
            description: 'Someone gives me all the answers.',
            source_principles: [],
          },
        },
      ],
      carry_forward: [
        {
          id: '',
          item: '',
          why: '',
          priority: 'urgent',
          status: 'active',
          expires_at: 'not-a-date',
          desire_key: 'desire:missing',
        },
      ],
      reasoning_artifacts: [{ slug: '', summary: '', decision: '', conditions_to_revisit: 'bad', body: '' }],
      code_stage_requests: [],
      deploy: 'no',
      next_reflect: { after_sessions: 'soon' },
    }, snapshot);

    expect(strong.total).toBeGreaterThan(weak.total);
    expect(weak.issues.some((issue) => issue.includes('invalid write target'))).toBe(true);
    expect(weak.issues.some((issue) => issue.includes('desire direction must be approach'))).toBe(true);
    expect(weak.issues.some((issue) => issue.includes('pattern looks advisory'))).toBe(true);
  });

  it('prefers bootstrap-aware minimal intervention on an empty-desire bootstrap snapshot', () => {
    const bootstrapSnapshot = {
      'action:a_1': {
        kind: 'no_action',
        plan: { no_action: true, reason: 'No active desires are present.' },
      },
      'experience:1': {
        observation: 'No action was taken because no active desires were present.',
        desire_alignment: { top_positive: [], top_negative: [], affinity_magnitude: 0 },
        pattern_delta: { sigma: 1, scores: [] },
      },
      'last_reflect': {
        carry_forward: [],
      },
    };

    const eager = scoreDrPayload({
      reflection: 'This bootstrap needs multiple new structures immediately, so I created two desires and a bootstrap pattern.',
      note_to_future_self: 'Watch the new bootstrap desires.',
      kv_operations: [
        {
          key: 'desire:know-my-world',
          value: {
            slug: 'know-my-world',
            direction: 'approach',
            description: 'I have explored my operational environment and know my patron context.',
            source_principles: ['principle:discipline'],
          },
        },
        {
          key: 'desire:operational-readiness',
          value: {
            slug: 'operational-readiness',
            direction: 'approach',
            description: 'I have verified that my core capabilities work before I rely on them.',
            source_principles: ['principle:health'],
          },
        },
        {
          key: 'pattern:bootstrap:cold-start-inaction',
          value: {
            pattern: 'When no desires exist, deep-reflect must seed them.',
            strength: 0.3,
          },
        },
      ],
      carry_forward: [
        {
          id: 'cf1',
          item: 'Explore operational environment',
          why: 'Need concrete context first',
          priority: 'high',
          status: 'active',
          created_at: '2026-04-06T12:00:00.000Z',
          updated_at: '2026-04-06T12:00:00.000Z',
          expires_at: '2026-04-13T12:00:00.000Z',
          desire_key: 'desire:know-my-world',
        },
        {
          id: 'cf2',
          item: 'Verify tool functionality',
          why: 'Need confidence in the body',
          priority: 'medium',
          status: 'active',
          created_at: '2026-04-06T12:00:00.000Z',
          updated_at: '2026-04-06T12:00:00.000Z',
          expires_at: '2026-04-13T12:00:00.000Z',
          desire_key: 'desire:operational-readiness',
        },
      ],
      reasoning_artifacts: [],
      code_stage_requests: [],
      deploy: false,
      next_reflect: { after_sessions: 5, after_days: 7 },
    }, bootstrapSnapshot);

    const minimal = scoreDrPayload({
      reflection: 'This is a bootstrap stall: one no_action trace from an empty desire set. Seed one minimal desire, avoid pattern/tactic growth, and re-check quickly after the first real act.',
      note_to_future_self: 'If the next act still returns no_action, investigate desire-loading rather than inventing more bootstrap structure.',
      kv_operations: [
        {
          key: 'desire:live-situational-direction',
          value: {
            slug: 'live-situational-direction',
            direction: 'approach',
            description: 'I have enough live situational awareness to identify a concrete, principle-grounded next task, or to justify inaction with explicit evidence.',
            source_principles: ['principle:discipline', 'principle:responsibility'],
          },
        },
      ],
      carry_forward: [
        {
          id: 'cf1',
          item: 'Inspect the smallest set of live signals needed to choose the next grounded action',
          why: 'Tests whether the seeded desire produces direction without forcing excess structure',
          priority: 'high',
          status: 'active',
          created_at: '2026-04-06T12:00:00.000Z',
          updated_at: '2026-04-06T12:00:00.000Z',
          expires_at: '2026-04-13T12:00:00.000Z',
          desire_key: 'desire:live-situational-direction',
        },
      ],
      reasoning_artifacts: [
        {
          slug: 'bootstrap-direction-from-empty-desires',
          summary: 'One bootstrap no_action trace is enough to seed a minimal desire, but not enough to justify pattern growth.',
          decision: 'Create one bootstrap desire, keep carry_forward minimal, and re-check soon.',
          conditions_to_revisit: ['The next act still returns no_action even with the new desire present.'],
          body: '# Bootstrap direction\n\nUse one desire, not a larger structure burst.',
        },
      ],
      code_stage_requests: [],
      deploy: false,
      next_reflect: { after_sessions: 1, after_days: 1 },
    }, bootstrapSnapshot);

    expect(minimal.total).toBeGreaterThan(eager.total);
    expect(minimal.total).toBeLessThanOrEqual(100);
    expect(minimal.max_total).toBe(110);
    expect(eager.issues.some((issue) => issue.includes('bootstrap output should avoid creating patterns'))).toBe(true);
    expect(minimal.breakdown.bootstrap_calibration).toBeGreaterThan(eager.breakdown.bootstrap_calibration);
  });
});

describe('compareScoredOutputs', () => {
  it('declares a winner only when the margin is meaningful', () => {
    const clear = compareScoredOutputs([
      { runner: 'claude', score: { total: 82 } },
      { runner: 'codex', score: { total: 70 } },
    ]);
    expect(clear.winner).toBe('claude');
    expect(clear.margin).toBe(12);

    const tieish = compareScoredOutputs([
      { runner: 'claude', score: { total: 82 } },
      { runner: 'codex', score: { total: 80 } },
    ]);
    expect(tieish.winner).toBeNull();
    expect(tieish.margin).toBe(2);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { initState, listProbes } from '../../scripts/operator/dev-loop/state.mjs';
import { runClassify } from '../../scripts/operator/dev-loop/classify.mjs';
import { routeProposal, generateApprovalId } from '../../lib/operator/dev-loop/decide.js';

const TEST_DIR = join(import.meta.dirname, '../../.swayambhu/dev-loop-integration-test');

describe('dev-loop integration', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await initState(TEST_DIR);
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('classify → decide pipeline with mock observation', async () => {
    const timestamp = '2026-04-04T12-00-00Z';
    const observation = {
      timestamp,
      strategy: 'accumulate',
      session_counter_before: 5,
      session_counter_after: 6,
      latest_session_id: 's_test_001',
      analysis: {
        desires: {
          'desire:avoid_errors': {
            slug: 'avoid_errors',
            direction: 'approach',
            description: 'Avoid making errors in my code',
          },
        },
        patterns: {
          'pattern:always_works': {
            pattern: 'Everything always works perfectly',
            strength: 1.0,
          },
        },
        experiences: {},
        karma: {},
      },
    };

    // CLASSIFY
    const { classification, newIssues } = await runClassify({
      baseDir: TEST_DIR,
      observation,
      timestamp,
    });

    expect(classification.total_issues_found).toBeGreaterThan(0);
    expect(newIssues.some(i => i.summary.includes('avoidance'))).toBe(true);
    expect(newIssues.some(i => i.summary.includes('strength'))).toBe(true);

    // Probes should be saved
    const probes = await listProbes(TEST_DIR);
    expect(probes.length).toBe(newIssues.length);

    // DECIDE — route each issue based on evidence quality
    for (const issue of newIssues) {
      const route = routeProposal({
        blast_radius: issue.blast_radius,
        evidence_quality: issue.evidence_quality,
      });
      // Issues with strong evidence + local blast radius → auto_apply
      // Issues with weak evidence → defer
      expect(['auto_apply', 'defer']).toContain(route.action);
    }

    // Classification file should exist
    const classFile = join(TEST_DIR, 'runs', timestamp, 'classification.json');
    expect(existsSync(classFile)).toBe(true);
  });

  it('dedup prevents duplicate issues across cycles', async () => {
    const obs = {
      timestamp: 'cycle-1',
      strategy: 'accumulate',
      analysis: {
        desires: {
          'desire:avoid_errors': {
            slug: 'avoid_errors',
            direction: 'approach',
            description: 'Avoid making errors',
          },
        },
        patterns: {}, experiences: {}, karma: {},
      },
    };

    // First classify
    await runClassify({ baseDir: TEST_DIR, observation: obs, timestamp: 'cycle-1' });
    const probes1 = await listProbes(TEST_DIR);

    // Second classify with same data
    await runClassify({ baseDir: TEST_DIR, observation: obs, timestamp: 'cycle-2' });
    const probes2 = await listProbes(TEST_DIR);

    // Should not create duplicate probes
    expect(probes2.length).toBe(probes1.length);
    // But evidence should be appended
    const probe = probes2.find(p => p.summary.includes('avoidance'));
    expect(probe.evidence.length).toBeGreaterThan(0);
  });

  it('approval ID is 5-char alphanumeric', () => {
    const id = generateApprovalId('2026-04-04T120000Z', 1);
    expect(id).toHaveLength(5);
    expect(id).toMatch(/^[a-z2-9]{5}$/);
  });

  it('routeProposal handles all blast radius levels', () => {
    expect(routeProposal({ blast_radius: 'local', evidence_quality: 'strong' }).action).toBe('auto_apply');
    expect(routeProposal({ blast_radius: 'module', evidence_quality: 'strong' }).action).toBe('defer');
    expect(routeProposal({ blast_radius: 'system', evidence_quality: 'strong' }).action).toBe('defer');
  });
});

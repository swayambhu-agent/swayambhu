import { describe, expect, it } from 'vitest';

import { parseArgs } from '../scripts/ui-review.mjs';

describe('parseArgs', () => {
  it('parses explicit options', () => {
    const options = parseArgs([
      '--url', 'http://localhost:9021/patron/',
      '--patron-key', 'test',
      '--output-dir', '/tmp/ui-review',
      '--viewports', 'desktop',
      '--timeout-ms', '4000',
      '--headed',
    ]);

    expect(options.url).toBe('http://localhost:9021/patron/');
    expect(options.patronKey).toBe('test');
    expect(options.outputDir).toBe('/tmp/ui-review');
    expect(options.viewports).toEqual(['desktop']);
    expect(options.timeoutMs).toBe(4000);
    expect(options.headed).toBe(true);
  });

  it('rejects unsupported viewports', () => {
    expect(() => parseArgs(['--viewports', 'tablet'])).toThrow(/Unsupported viewport/);
  });
});

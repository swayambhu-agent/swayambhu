import { describe, expect, it } from 'vitest';

import { buildRuntimeDashboardConfig } from '../scripts/dev-serve.mjs';

describe('buildRuntimeDashboardConfig', () => {
  it('preserves base config and injects branch-local api/kernel urls', () => {
    const source = `window.DASHBOARD_CONFIG = { timezone: "UTC" };`;
    const result = buildRuntimeDashboardConfig(source, { dashboardPort: 8910, kernelPort: 8907 });

    expect(result).toContain('timezone: "UTC"');
    expect(result).toContain('apiUrl: "/api"');
    expect(result).toContain('kernelUrl: "http://localhost:8907"');
    expect(result).toContain('Object.assign');
  });

  it('creates a fallback config when no base file exists', () => {
    const result = buildRuntimeDashboardConfig('', { dashboardPort: 8790, kernelPort: 8787 });

    expect(result).toContain('window.DASHBOARD_CONFIG = {};');
    expect(result).toContain('apiUrl: "/api"');
    expect(result).toContain('kernelUrl: "http://localhost:8787"');
  });
});

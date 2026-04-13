import { API_URL } from './config.js';
export { API_URL };

// ── API helpers ───────────────────────────────────────────
export const kvReadCount = { current: 0 };

export async function api(path, _legacyKey = null, timeoutMs = 8000) {
  kvReadCount.current++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      signal: ctrl.signal,
    });
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Browser-side cache for stable keys
const stableCache = {};
const STABLE_PREFIXES = ['dharma', 'wisdom', 'prompt:', 'tool:', 'provider:'];

export async function cachedApi(path, key) {
  const cacheKey = path;
  if (stableCache[cacheKey]) return stableCache[cacheKey];
  const data = await api(path, key);
  // Cache stable keys
  if (STABLE_PREFIXES.some(p => path.includes(p))) {
    stableCache[cacheKey] = data;
  }
  return data;
}

export async function apiMulti(keys, patronKey) {
  if (!keys.length) return {};
  const encoded = keys.map(k => encodeURIComponent(k)).join(',');
  return api(`/kv/multi?keys=${encoded}`, patronKey);
}

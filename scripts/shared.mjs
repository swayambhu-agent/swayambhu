// Shared Miniflare factory for local KV scripts.
// Single source of truth for KV namespace ID and persist path.

import { Miniflare } from "miniflare";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const root = resolve(__dirname, "..");
export const DEFAULT_LOCAL_STATE_DIR = resolve(root, ".wrangler/shared-state");

const KV_NAMESPACE_ID = "05720444f9654ed4985fb67af4aea24d";

let _mf = null;
let _mfStateDir = null;

export function resolveStateDir(options = {}) {
  return options.stateDir || process.env.SWAYAMBHU_PERSIST_DIR || DEFAULT_LOCAL_STATE_DIR;
}

export async function getKV(options = {}) {
  const stateDir = resolveStateDir(options);
  if (_mf && _mfStateDir !== stateDir) {
    await _mf.dispose();
    _mf = null;
    _mfStateDir = null;
  }
  if (!_mf) {
    _mf = new Miniflare({
      modules: true,
      script: `export default { fetch() { return new Response("ok"); } }`,
      kvPersist: resolve(stateDir, "v3/kv"),
      kvNamespaces: { KV: KV_NAMESPACE_ID },
    });
    _mfStateDir = stateDir;
  }
  return _mf.getKVNamespace("KV");
}

export async function dispose() {
  if (_mf) await _mf.dispose();
  _mf = null;
  _mfStateDir = null;
}

// Shared Miniflare factory for local KV scripts.
// Single source of truth for KV namespace ID and persist path.

import { Miniflare } from "miniflare";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const root = resolve(__dirname, "..");

const KV_NAMESPACE_ID = "05720444f9654ed4985fb67af4aea24d";

let _mf = null;

export async function getKV() {
  _mf = new Miniflare({
    modules: true,
    script: `export default { fetch() { return new Response("ok"); } }`,
    kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
    kvNamespaces: { KV: KV_NAMESPACE_ID },
  });
  return _mf.getKVNamespace("KV");
}

export async function dispose() {
  if (_mf) await _mf.dispose();
}

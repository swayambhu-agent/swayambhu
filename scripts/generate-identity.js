#!/usr/bin/env node
// Generate a dedicated identity keypair for Swayambhu's did:ethr DID.
//
// This key is SEPARATE from the wallet key:
//   - Identity key: signs VCs, controls DID Document, authenticates
//   - Wallet key: signs financial transactions
//
// If the wallet key leaks → move funds, update DID binding. Identity survives.
// If the identity key leaks → rotate via ERC-1056 changeOwner(). DID survives.
// If both leak → recover via human custodian (you) + out-of-band announcement.
//
// Usage:
//   node scripts/generate-identity.js                # interactive
//   node scripts/generate-identity.js --json          # machine-readable
//   node scripts/generate-identity.js --seed-kv       # write to local KV

import { ethers } from "ethers";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const CHAIN_ID = 8453; // Base mainnet
const CHAIN_NAME = "base";
const REGISTRY = "0xdca7ef03e98e0dc2b855be647c39abe984fcf21b";

function generateIdentity() {
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address.toLowerCase();

  return {
    did: `did:ethr:${CHAIN_ID}:${address}`,
    address,
    privateKeyHex: wallet.privateKey,
    publicKey: wallet.publicKey,
    chainId: CHAIN_ID,
    chainName: CHAIN_NAME,
    registry: REGISTRY,
    generatedAt: new Date().toISOString(),
  };
}

function kvPayload(identity) {
  return {
    did: identity.did,
    address: identity.address,
    chain_id: identity.chainId,
    chain_name: identity.chainName,
    registry: identity.registry,
    registry_deployed: false, // flip to true after deploying ERC-1056 on Base
    created_at: identity.generatedAt,
    dharma_hash: null,        // set after dharma is finalized
    controller: identity.address, // self-controlled; changes after changeOwner()
  };
}

// ── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const seedKV = args.includes("--seed-kv");

const identity = generateIdentity();
const kv = kvPayload(identity);

if (jsonMode) {
  console.log(JSON.stringify({ ...identity, kv }, null, 2));
  process.exit(0);
}

console.log(`
╔══════════════════════════════════════════════════════════╗
║           SWAYAMBHU IDENTITY KEYPAIR GENERATED          ║
╚══════════════════════════════════════════════════════════╝

  DID:       ${identity.did}
  Address:   ${identity.address}
  Chain:     Base (${identity.chainId})
  Registry:  ${identity.registry}
  Generated: ${identity.generatedAt}

┌──────────────────────────────────────────────────────────┐
│  ⚠  PRIVATE KEY — STORE SECURELY, NEVER COMMIT TO GIT  │
└──────────────────────────────────────────────────────────┘

  ${identity.privateKeyHex}

── Next steps ─────────────────────────────────────────────

  1. Store as Wrangler secret (production):
     echo -n "${identity.privateKeyHex}" | wrangler secret put IDENTITY_PRIVATE_KEY

  2. Seed local KV:
     node scripts/generate-identity.js --seed-kv
     # or add the identity block to seed-local-kv.mjs

  3. Later, when dharma is finalized:
     Deploy ERC-1056 registry to Base, then call setAttribute
     to anchor the dharma hash on-chain.
`);

if (seedKV) {
  const { Miniflare } = await import("miniflare");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, "..");

  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    kvPersist: resolve(root, ".wrangler/shared-state/v3/kv"),
    kvNamespaces: { KV: "05720444f9654ed4985fb67af4aea24d" },
  });

  const kvStore = await mf.getKVNamespace("KV");
  await kvStore.put("identity:did", JSON.stringify(kv, null, 2), {
    metadata: { format: "json", description: "Swayambhu DID identity" },
  });
  console.log("  ✓ identity:did written to local KV\n");
  await mf.dispose();
} else {
  console.log(`── To seed into local KV ───────────────────────────────────

  node scripts/generate-identity.js --seed-kv
`);
}
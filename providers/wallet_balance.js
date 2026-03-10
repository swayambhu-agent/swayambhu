export const meta = { secrets: ["WALLET_ADDRESS"], timeout_ms: 10000 };

const RPC_URLS = [
  "https://base-mainnet.public.blastapi.io",
  "https://base.meowrpc.com",
  "https://mainnet.base.org",
];

export async function check({ secrets, fetch }) {
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const wallet = secrets.WALLET_ADDRESS;
  const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "eth_call",
    params: [{ to: usdc, data }, "latest"],
  });

  let lastError;
  for (const url of RPC_URLS) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!resp.ok) { lastError = `${url}: HTTP ${resp.status}`; continue; }
      const result = await resp.json();
      if (result.error) { lastError = `${url}: ${result.error.message}`; continue; }
      return parseInt(result.result, 16) / 1e6;
    } catch (e) { lastError = `${url}: ${e.message}`; }
  }
  throw new Error(`All RPCs failed: ${lastError}`);
}

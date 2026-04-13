export const meta = {
  secrets: ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "COMPUTER_API_KEY"],
  kv_access: "none",
  timeout_ms: 300000,
  provider: "compute",
};

const BASE = "https://akash.swayambhu.dev";

export async function execute({ command, timeout, secrets, fetch, provider, config }) {
  const baseUrl = config?.jobs?.base_url || BASE;
  return provider.call({ command, baseUrl, timeout, secrets, fetch });
}

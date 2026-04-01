export const meta = { secrets: ["OPENROUTER_API_KEY"], timeout_ms: 10000 };

export async function check({ secrets, fetch }) {
  const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { "Authorization": "Bearer " + secrets.OPENROUTER_API_KEY }
  });
  const data = await resp.json();
  const d = data?.data;
  if (!d) return null;
  // limit_remaining resets monthly — actual balance is limit minus total usage
  if (d.limit != null && d.usage != null) return Math.round((d.limit - d.usage) * 100) / 100;
  return d.limit_remaining ?? null;
}

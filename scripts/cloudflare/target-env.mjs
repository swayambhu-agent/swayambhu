export function parseTargetEnv(argv, { defaultEnv = "staging" } = {}) {
  let envName = defaultEnv;
  let prodConfirmed = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env") {
      envName = argv[i + 1] || "";
      i++;
      continue;
    }
    if (arg === "--prod") {
      prodConfirmed = true;
    }
  }

  if (!["staging", "prod"].includes(envName)) {
    throw new Error(`invalid --env value: ${envName}`);
  }
  if (envName === "prod" && !prodConfirmed) {
    throw new Error("prod requires explicit confirmation: pass both --env prod and --prod");
  }

  return { envName, prodConfirmed };
}

export async function confirmProdInteractive(envName, label = "operation") {
  if (envName !== "prod") return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`prod ${label} requires an interactive terminal confirmation`);
  }

  const { createInterface } = await import("readline/promises");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `You are targeting prod for ${label}. Type 'yes' to continue: `
    );
    if (answer.trim() !== "yes") {
      throw new Error("prod confirmation aborted");
    }
  } finally {
    rl.close();
  }
}

export function cloudflareTargetConfig(envName) {
  if (envName === "prod") {
    return {
      envName,
      zoneName: "swayambhu.dev",
      domain: "swayambhu.dev",
      apiHost: "api.swayambhu.dev",
      agentHost: "agent.swayambhu.dev",
      siteProject: "swayambhu-site",
      runtimeName: "swayambhu-cns",
      dashboardName: "swayambhu-dashboard-api",
      kvTitle: "KV-prod",
      accessAppName: "swayambhu-patron",
      jobsBaseUrl: "https://akash.swayambhu.dev",
      emailRelayUrl: "https://email.swayambhu.dev",
      operatorEnvCandidates: [".env.patron.prod", ".env.patron"],
      runtimeEnvCandidates: [".env.prod", ".env"],
      tmpDirName: "cloudflare-prod",
      pagesBranch: "main",
      wranglerEnv: null,
    };
  }

  return {
    envName: "staging",
    zoneName: "swayambhu.dev",
    domain: "staging.swayambhu.dev",
    apiHost: "api-staging.swayambhu.dev",
    agentHost: "agent-staging.swayambhu.dev",
    siteProject: "swayambhu-site-staging",
    runtimeName: "swayambhu-cns-staging",
    dashboardName: "swayambhu-dashboard-api-staging",
    kvTitle: "KV",
    accessAppName: "swayambhu-patron-staging",
    jobsBaseUrl: "https://akash-dev.swayambhu.dev",
    emailRelayUrl: "https://email-dev.swayambhu.dev",
    operatorEnvCandidates: [".env.patron", ".env.patron.prod"],
    runtimeEnvCandidates: [".env", ".env.prod"],
    tmpDirName: "cloudflare-staging",
    pagesBranch: "staging",
    wranglerEnv: "staging",
  };
}

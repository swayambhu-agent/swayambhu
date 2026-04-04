// State module for the dev loop.
// Manages file-based state in .swayambhu/dev-loop/ — gitignored operational data,
// not agent state. All other dev-loop stages depend on this for persistent state.

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdir, readFile, writeFile, readdir, rename } from "fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = join(__dirname, "../../.swayambhu/dev-loop");

const DEFAULT_STATE = () => ({
  cycle: 0,
  cash_budget_spent_today: 0,
  budget_reset_date: new Date().toISOString().slice(0, 10),
  phase: "idle",
  heartbeat: null,
  stage_failures: {},
  disabled_stages: [],
  processed_reply_ids: [],
});

const SUBDIRS = [
  "probes",
  "queue/pending",
  "queue/approved",
  "queue/rejected",
  "runs",
  "metrics",
];

export async function initState(baseDir) {
  for (const sub of SUBDIRS) {
    await mkdir(join(baseDir, sub), { recursive: true });
  }
  const statePath = join(baseDir, "state.json");
  try {
    await readFile(statePath);
  } catch {
    await writeFile(statePath, JSON.stringify(DEFAULT_STATE(), null, 2));
  }
}

export async function loadState(baseDir) {
  try {
    const raw = await readFile(join(baseDir, "state.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return DEFAULT_STATE();
  }
}

export async function saveState(baseDir, state) {
  await writeFile(join(baseDir, "state.json"), JSON.stringify(state, null, 2));
}

export async function loadProbe(baseDir, id) {
  const raw = await readFile(join(baseDir, "probes", `${id}.json`), "utf8");
  return JSON.parse(raw);
}

export async function saveProbe(baseDir, probe) {
  await writeFile(
    join(baseDir, "probes", `${probe.id}.json`),
    JSON.stringify(probe, null, 2),
  );
}

export async function listProbes(baseDir) {
  const dir = join(baseDir, "probes");
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const probes = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = await readFile(join(dir, f), "utf8");
    probes.push(JSON.parse(raw));
  }
  return probes;
}

export async function loadQueue(baseDir, bucket) {
  const dir = join(baseDir, "queue", bucket);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const items = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = await readFile(join(dir, f), "utf8");
    items.push(JSON.parse(raw));
  }
  return items;
}

export async function moveQueue(baseDir, id, from, to) {
  const src = join(baseDir, "queue", from, `${id}.json`);
  const dst = join(baseDir, "queue", to, `${id}.json`);
  await rename(src, dst);
}

export async function saveRun(baseDir, timestamp, filename, data) {
  const runDir = join(baseDir, "runs", String(timestamp));
  await mkdir(runDir, { recursive: true });
  const content = typeof data === "object" ? JSON.stringify(data, null, 2) : data;
  await writeFile(join(runDir, filename), content);
}

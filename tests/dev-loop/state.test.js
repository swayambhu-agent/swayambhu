import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { rm, readdir, readFile } from "fs/promises";
import {
  initState,
  loadState,
  saveState,
  loadProbe,
  saveProbe,
  listProbes,
  loadQueue,
  moveQueue,
  saveRun,
  STATE_DIR,
} from "../../scripts/operator/dev-loop/state.mjs";

const TEST_DIR = "/tmp/dev-loop-state-test";

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ── initState ────────────────────────────────────────────

describe("initState", () => {
  it("creates all required subdirectories", async () => {
    await initState(TEST_DIR);
    const expected = ["probes", "queue", "runs", "metrics"];
    for (const d of expected) {
      const stat = await readdir(join(TEST_DIR, d));
      expect(stat).toBeDefined();
    }
    // queue subdirs
    for (const b of ["pending", "approved", "rejected"]) {
      const stat = await readdir(join(TEST_DIR, "queue", b));
      expect(stat).toBeDefined();
    }
  });

  it("creates state.json with defaults", async () => {
    await initState(TEST_DIR);
    const state = JSON.parse(await readFile(join(TEST_DIR, "state.json"), "utf8"));
    expect(state.cycle).toBe(0);
    expect(state.phase).toBe("idle");
    expect(state.heartbeat).toBeNull();
    expect(state.disabled_stages).toEqual([]);
    expect(state.processed_reply_ids).toEqual([]);
  });

  it("does not overwrite existing state.json", async () => {
    await initState(TEST_DIR);
    await saveState(TEST_DIR, { cycle: 5, phase: "running" });
    await initState(TEST_DIR);
    const state = await loadState(TEST_DIR);
    expect(state.cycle).toBe(5);
  });
});

// ── loadState / saveState ────────────────────────────────

describe("loadState / saveState", () => {
  it("returns defaults when state.json does not exist", async () => {
    const state = await loadState(TEST_DIR);
    expect(state.cycle).toBe(0);
    expect(state.phase).toBe("idle");
  });

  it("round-trips state", async () => {
    await initState(TEST_DIR);
    const data = { cycle: 3, phase: "observe", custom: "field" };
    await saveState(TEST_DIR, data);
    const loaded = await loadState(TEST_DIR);
    expect(loaded).toEqual(data);
  });
});

// ── probes ───────────────────────────────────────────────

describe("probes", () => {
  it("saves and loads a probe by id", async () => {
    await initState(TEST_DIR);
    const probe = { id: "p-001", type: "test", status: "pending" };
    await saveProbe(TEST_DIR, probe);
    const loaded = await loadProbe(TEST_DIR, "p-001");
    expect(loaded).toEqual(probe);
  });

  it("lists all probes", async () => {
    await initState(TEST_DIR);
    await saveProbe(TEST_DIR, { id: "a", x: 1 });
    await saveProbe(TEST_DIR, { id: "b", x: 2 });
    const all = await listProbes(TEST_DIR);
    expect(all).toHaveLength(2);
    const ids = all.map((p) => p.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("listProbes returns empty array when no probes dir", async () => {
    const result = await listProbes(TEST_DIR);
    expect(result).toEqual([]);
  });
});

// ── queue ────────────────────────────────────────────────

describe("queue", () => {
  it("moves item between buckets", async () => {
    await initState(TEST_DIR);
    const item = { id: "q-1", description: "test item" };
    const { writeFile: wf } = await import("fs/promises");
    await wf(
      join(TEST_DIR, "queue/pending/q-1.json"),
      JSON.stringify(item),
    );

    let pending = await loadQueue(TEST_DIR, "pending");
    expect(pending).toHaveLength(1);

    await moveQueue(TEST_DIR, "q-1", "pending", "approved");

    pending = await loadQueue(TEST_DIR, "pending");
    expect(pending).toHaveLength(0);
    const approved = await loadQueue(TEST_DIR, "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe("q-1");
  });

  it("loadQueue returns empty array for empty bucket", async () => {
    await initState(TEST_DIR);
    const result = await loadQueue(TEST_DIR, "pending");
    expect(result).toEqual([]);
  });
});

// ── runs ─────────────────────────────────────────────────

describe("saveRun", () => {
  it("saves object data as JSON", async () => {
    await initState(TEST_DIR);
    await saveRun(TEST_DIR, 1234567890, "result.json", { ok: true });
    const raw = await readFile(
      join(TEST_DIR, "runs/1234567890/result.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });

  it("saves string data raw", async () => {
    await initState(TEST_DIR);
    await saveRun(TEST_DIR, 99, "log.txt", "hello world");
    const raw = await readFile(join(TEST_DIR, "runs/99/log.txt"), "utf8");
    expect(raw).toBe("hello world");
  });
});

// ── STATE_DIR ────────────────────────────────────────────

describe("STATE_DIR", () => {
  it("defaults to the external dev-loop directory", () => {
    expect(STATE_DIR).toMatch(/\/dev-loop$/);
    expect(STATE_DIR).not.toContain("/repo/");
  });
});

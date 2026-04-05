import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { makeMockK } from "./helpers/mock-kernel.js";
import { executeReflect, applyReflectOutput } from "../reflect.js";

describe("reflect prompt contract", () => {
  it("describes carry-forward updates and limits", () => {
    const prompt = readFileSync(new URL("../prompts/reflect.md", import.meta.url), "utf8");

    expect(prompt).toContain("carry_forward_updates");
    expect(prompt).toContain("new_carry_forward");
    expect(prompt).toContain("carry_forward");
    expect(prompt).toContain("7-day TTL");
    expect(prompt).toContain("at most 5 items active");
  });

  it("describes deep-reflect carry-forward hygiene", () => {
    const prompt = readFileSync(new URL("../prompts/deep_reflect.md", import.meta.url), "utf8");

    expect(prompt).toContain("carry_forward");
    expect(prompt).toContain("Merge duplicates");
    expect(prompt).toContain("expired");
    expect(prompt).toContain("at most 5 items");
  });
});

describe("executeReflect carry-forward merge", () => {
  const state = {
    defaults: {
      reflect: { model: "test-model", effort: "medium", max_output_tokens: 1000 },
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function makeReflectK(lastReflect, output) {
    const K = makeMockK(
      lastReflect ? { last_reflect: lastReflect, session_counter: 3 } : { session_counter: 3 },
      {
        defaults: state.defaults,
        executionId: "s_test",
        karma: [{ event: "act_complete" }],
      },
    );

    K.runAgentLoop = vi.fn(async () => output);
    return K;
  }

  it("updates carried-forward items to done, dropped, refreshed, and adds new items", async () => {
    const K = makeReflectK(
      {
        carry_forward: [
          {
            id: "s_prev:cf1",
            item: "Finish the report",
            why: "Needed for patron follow-up",
            priority: "high",
            status: "active",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
            expires_at: "2026-04-08T00:00:00.000Z",
          },
          {
            id: "s_prev:cf2",
            item: "Retry the flaky tool",
            why: "Tool reliability is uncertain",
            priority: "medium",
            status: "active",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
            expires_at: "2026-04-08T00:00:00.000Z",
          },
          {
            id: "s_prev:cf3",
            item: "Keep this alive",
            why: "Still relevant",
            priority: "low",
            status: "active",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
            expires_at: "2026-04-08T00:00:00.000Z",
          },
        ],
      },
      {
        session_summary: "Session summary",
        note_to_future_self: "Keep going",
        next_act_context: { load_keys: [], reason: "none" },
        carry_forward_updates: [
          {
            id: "s_prev:cf1",
            status: "done",
            updated_at: "2026-04-05T12:00:00.000Z",
            result: "Completed during this session",
          },
          {
            id: "s_prev:cf2",
            status: "dropped",
            updated_at: "2026-04-05T12:00:00.000Z",
            reason: "No longer relevant",
          },
          {
            id: "s_prev:cf3",
            status: "active",
            why: "Still blocked on upstream work",
            priority: "high",
            updated_at: "2026-04-05T12:00:00.000Z",
            expires_at: "2026-04-12T12:00:00.000Z",
            desire_key: "desire:d_help",
          },
        ],
        new_carry_forward: [
          {
            id: "s_test:cf1",
            item: "Start the next check-in",
            why: "Sets up the next session",
            priority: "medium",
          },
        ],
        task_updates: [{ id: "stale:t1", status: "done" }],
        new_tasks: [{ id: "stale:t2", task: "old" }],
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    const lastReflect = await K.kvGet("last_reflect");
    expect(lastReflect.carry_forward).toHaveLength(4);

    const doneItem = lastReflect.carry_forward.find(item => item.id === "s_prev:cf1");
    expect(doneItem.status).toBe("done");
    expect(doneItem.result).toBe("Completed during this session");
    expect(doneItem.done_session).toBe("s_test");

    const droppedItem = lastReflect.carry_forward.find(item => item.id === "s_prev:cf2");
    expect(droppedItem.status).toBe("dropped");
    expect(droppedItem.reason).toBe("No longer relevant");

    const refreshedItem = lastReflect.carry_forward.find(item => item.id === "s_prev:cf3");
    expect(refreshedItem.status).toBe("active");
    expect(refreshedItem.why).toBe("Still blocked on upstream work");
    expect(refreshedItem.priority).toBe("high");
    expect(refreshedItem.updated_at).toBe("2026-04-05T12:00:00.000Z");
    expect(refreshedItem.expires_at).toBe("2026-04-12T12:00:00.000Z");
    expect(refreshedItem.desire_key).toBe("desire:d_help");

    const newItem = lastReflect.carry_forward.find(item => item.id === "s_test:cf1");
    expect(newItem.status).toBe("active");
    expect(newItem.created_at).toBe("2026-04-05T12:00:00.000Z");
    expect(newItem.updated_at).toBe("2026-04-05T12:00:00.000Z");
    expect(newItem.expires_at).toBe("2026-04-12T12:00:00.000Z");

    expect(lastReflect.task_updates).toBeUndefined();
    expect(lastReflect.new_tasks).toBeUndefined();
    expect(lastReflect.carry_forward_updates).toBeUndefined();
    expect(lastReflect.new_carry_forward).toBeUndefined();
  });

  it("logs missed carry-forward updates", async () => {
    const K = makeReflectK(
      {
        carry_forward: [],
      },
      {
        session_summary: "Session summary",
        note_to_future_self: "Keep going",
        next_act_context: { load_keys: [], reason: "none" },
        carry_forward_updates: [
          {
            id: "missing:cf1",
            status: "done",
            updated_at: "2026-04-05T12:00:00.000Z",
            result: "Missing",
          },
        ],
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    expect(K.karmaRecord).toHaveBeenCalledWith({
      event: "carry_forward_updates_missed",
      missed: [
        {
          id: "missing:cf1",
          status: "done",
          updated_at: "2026-04-05T12:00:00.000Z",
          result: "Missing",
        },
      ],
    });
  });

  it("expires stale active carry-forward items", async () => {
    const K = makeReflectK(
      {
        carry_forward: [
          {
            id: "s_prev:cf1",
            item: "Old continuation",
            why: "Was important",
            priority: "medium",
            status: "active",
            created_at: "2026-03-20T00:00:00.000Z",
            updated_at: "2026-03-25T00:00:00.000Z",
            expires_at: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
      {
        session_summary: "Session summary",
        note_to_future_self: "Keep going",
        next_act_context: { load_keys: [], reason: "none" },
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    const lastReflect = await K.kvGet("last_reflect");
    expect(lastReflect.carry_forward[0].status).toBe("expired");
    expect(lastReflect.carry_forward[0].updated_at).toBe("2026-04-05T12:00:00.000Z");
  });
});

describe("applyReflectOutput deep-reflect carry-forward writeback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("stores carry_forward on depth 1 and logs removed items", async () => {
    const K = makeMockK(
      {
        last_reflect: {
          carry_forward: [
            {
              id: "s_prev:cf1",
              item: "Keep this",
              status: "active",
            },
            {
              id: "s_prev:cf2",
              item: "Drop this",
              status: "active",
            },
          ],
        },
        session_counter: 4,
      },
      {
        executionId: "s_dr",
      },
    );

    const state = {
      refreshDefaults: vi.fn(async () => {}),
    };

    const output = {
      reflection: "Deep reflect summary",
      note_to_future_self: "Watch this",
      carry_forward: [
        {
          id: "s_prev:cf1",
          item: "Keep this",
          why: "Still active",
          priority: "high",
          status: "active",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-05T12:00:00.000Z",
          expires_at: "2026-04-12T12:00:00.000Z",
        },
      ],
      next_reflect: {
        after_sessions: 20,
        after_days: 7,
      },
    };

    await applyReflectOutput(K, state, 1, output, {});

    const storedReflect = await K.kvGet("reflect:1:s_dr");
    expect(storedReflect.carry_forward).toEqual(output.carry_forward);

    const lastReflect = await K.kvGet("last_reflect");
    expect(lastReflect.carry_forward).toEqual(output.carry_forward);
    expect(lastReflect.was_deep_reflect).toBe(true);

    expect(K.karmaRecord).toHaveBeenCalledWith({
      event: "carry_forward_dropped",
      dropped: [
        {
          id: "s_prev:cf2",
          item: "Drop this",
          status: "active",
        },
      ],
    });
  });
});

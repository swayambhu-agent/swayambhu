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
    expect(prompt).toContain("active_desire_keys");
    expect(prompt).toContain("non-self surface");
    expect(prompt).toContain("7-day TTL");
    expect(prompt).toContain("at most 5 items active or blocked");
    expect(prompt).toContain("blocked_on");
    expect(prompt).toContain("wake_condition");
  });

  it("teaches the canonical KV-op shape and strict rejection of aliases", () => {
    const prompt = readFileSync(new URL("../prompts/reflect.md", import.meta.url), "utf8");

    expect(prompt).toContain('{ "op": "put", "key": "workspace:cyclic-cosmology"');
    expect(prompt).toContain('{ "op": "delete", "key": "workspace:stale-note" }');
    expect(prompt).toContain('{ "op": "patch", "key": "workspace:journal"');
    expect(prompt).toContain("Do not invent synonyms like `operation` or `set`");
    expect(prompt).not.toContain("field_merge");
  });

  it("describes deep-reflect carry-forward hygiene", () => {
    const prompt = readFileSync(new URL("../prompts/deep_reflect.md", import.meta.url), "utf8");

    expect(prompt).toContain("carry_forward");
    expect(prompt).toContain("Merge duplicates");
    expect(prompt).toContain("expired");
    expect(prompt).toContain("at most 5 items");
  });

  it("teaches deep-reflect to read and emit reasoning artifacts", () => {
    const prompt = readFileSync(new URL("../prompts/deep_reflect.md", import.meta.url), "utf8");

    expect(prompt).toContain("If this run includes a reasoning archive, start with its `INDEX.md`");
    expect(prompt).toContain("Treat each artifact as prior deliberation, not immutable truth.");
    expect(prompt).toContain("reasoning_artifacts");
    expect(prompt).toContain("conditions_to_revisit");
    expect(prompt).toContain("full markdown body of the reasoning");
  });
});

describe("executeReflect carry-forward merge", () => {
  const state = {
    defaults: {
      reflect: { model: "test-model", effort: "medium", max_output_tokens: 1000 },
    },
    desires: {
      "desire:d_help": {
        description: "Help concretely",
      },
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
    expect(newItem.request_id).toEqual(expect.any(String));
    expect(newItem.created_at).toBe("2026-04-05T12:00:00.000Z");
    expect(newItem.updated_at).toBe("2026-04-05T12:00:00.000Z");
    expect(newItem.expires_at).toBe("2026-04-12T12:00:00.000Z");

    expect(lastReflect.task_updates).toBeUndefined();
    expect(lastReflect.new_tasks).toBeUndefined();
    expect(lastReflect.carry_forward_updates).toBeUndefined();
    expect(lastReflect.new_carry_forward).toBeUndefined();
  });

  it("preserves structured waiting fields on refreshed carry-forward items", async () => {
    const K = makeReflectK(
      {
        carry_forward: [
          {
            id: "s_prev:cf1",
            item: "Wait for patron confirmation",
            why: "The next step depends on patron input.",
            priority: "high",
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
            status: "active",
            blocked_on: "explicit patron confirmation",
            wake_condition: "the patron sends confirmation",
            updated_at: "2026-04-05T12:00:00.000Z",
          },
        ],
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    const lastReflect = await K.kvGet("last_reflect");
    const item = lastReflect.carry_forward.find(entry => entry.id === "s_prev:cf1");
    expect(item.blocked_on).toBe("explicit patron confirmation");
    expect(item.wake_condition).toBe("the patron sends confirmation");
  });

  it("passes active desire keys into session reflect context", async () => {
    const K = makeReflectK(
      { carry_forward: [] },
      {
        session_summary: "Session summary",
        note_to_future_self: "Keep going",
        next_act_context: { load_keys: [], reason: "none" },
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    const args = K.runAgentLoop.mock.calls[0][0];
    const initialContext = JSON.parse(args.initialContext);
    expect(initialContext.active_desire_keys).toEqual(["desire:d_help"]);
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

  it("ignores invalid desire keys on new carry-forward items", async () => {
    const K = makeReflectK(
      {
        carry_forward: [
          {
            id: "s_prev:cf1",
            item: "Existing thread",
            why: "Still relevant",
            priority: "high",
            status: "active",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
            expires_at: "2026-04-08T00:00:00.000Z",
            desire_key: "desire:missing",
          },
        ],
      },
      {
        session_summary: "Session summary",
        note_to_future_self: "Keep going",
        next_act_context: { load_keys: [], reason: "none" },
        new_carry_forward: [
          {
            id: "s_test:cf1",
            item: "New thread",
            why: "Should survive",
            priority: "medium",
            desire_key: "desire:missing",
          },
        ],
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    const lastReflect = await K.kvGet("last_reflect");
    expect(lastReflect.carry_forward).toHaveLength(2);
    const newItem = lastReflect.carry_forward.find(item => item.id === "s_test:cf1");
    expect(newItem.desire_key).toBeUndefined();
    expect(K.karmaRecord).toHaveBeenCalledWith({
      event: "carry_forward_invalid_desire_key_ignored",
      source: "new",
      id: "s_test:cf1",
      desire_key: "desire:missing",
    });
  });

  it("ignores invalid desire keys on carry-forward updates", async () => {
    const K = makeReflectK(
      {
        carry_forward: [
          {
            id: "s_prev:cf1",
            item: "Existing thread",
            why: "Still relevant",
            priority: "high",
            status: "active",
            created_at: "2026-04-01T00:00:00.000Z",
            updated_at: "2026-04-01T00:00:00.000Z",
            expires_at: "2026-04-08T00:00:00.000Z",
            desire_key: "desire:d_help",
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
            status: "active",
            updated_at: "2026-04-05T12:00:00.000Z",
            desire_key: "desire:missing",
          },
        ],
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    const lastReflect = await K.kvGet("last_reflect");
    const item = lastReflect.carry_forward.find(entry => entry.id === "s_prev:cf1");
    expect(item.desire_key).toBe("desire:d_help");
    expect(K.karmaRecord).toHaveBeenCalledWith({
      event: "carry_forward_invalid_desire_key_ignored",
      source: "update",
      id: "s_prev:cf1",
      desire_key: "desire:missing",
    });
  });

  it("synthesizes minimal bootstrap reflect output without calling the LLM", async () => {
    const bootstrapState = {
      defaults: {
        reflect: { model: "test-model", effort: "medium", max_output_tokens: 1000 },
      },
      desires: {},
    };

    const K = makeMockK(
      { session_counter: 1 },
      {
        defaults: bootstrapState.defaults,
        executionId: "s_bootstrap",
        karma: [
          { event: "plan_no_action", cycle: 0 },
          { event: "experience_written", key: "experience:1", salience: 1, sigma: 1 },
          { event: "act_complete", cycles_run: 0, total_cost: 0 },
        ],
      },
    );

    await executeReflect(K, bootstrapState, bootstrapState.defaults.reflect);

    expect(K.runAgentLoop).not.toHaveBeenCalled();

    const lastReflect = await K.kvGet("last_reflect");
    expect(lastReflect.session_summary).toBe("Session 1 had no active desires. No action was taken. A bootstrap experience was written.");
    expect(lastReflect.note_to_future_self).toBe("No action until desire exists.");
    expect(lastReflect.carry_forward).toEqual([]);

    const record = await K.kvGet("reflect:0:s_bootstrap");
    expect(record.reflection).toBe("Session 1 had no active desires. No action was taken. A bootstrap experience was written.");
    expect(record.note_to_future_self).toBe("No action until desire exists.");
  });

  it("persists reflect output even when malformed kv_operations are rejected", async () => {
    const K = makeReflectK(
      { carry_forward: [] },
      {
        session_summary: "Session summary",
        note_to_future_self: "Keep going",
        next_act_context: { load_keys: [], reason: "none" },
        kv_operations: [
          {
            operation: "set",
            key: "workspace:cyclic-cosmology",
            value: { status: "in_progress" },
          },
        ],
      },
    );

    await executeReflect(K, state, state.defaults.reflect);

    const lastReflect = await K.kvGet("last_reflect");
    const record = await K.kvGet("reflect:0:s_test");
    expect(lastReflect.session_summary).toBe("Session summary");
    expect(record.reflection).toBe("Session summary");
    expect(await K.kvGet("workspace:cyclic-cosmology")).toBeNull();
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "kv_operation_schema_rejected",
      source: "reflect",
    }));
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "kv_operation_batch_rejected",
      source: "reflect",
    }));
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
    expect(storedReflect.carry_forward).toEqual([
      expect.objectContaining({
        id: "s_prev:cf1",
        item: "Keep this",
        status: "active",
      }),
    ]);
    expect(storedReflect.carry_forward[0].request_id).toEqual(expect.any(String));

    const lastReflect = await K.kvGet("last_reflect");
    expect(lastReflect.carry_forward).toEqual([
      expect.objectContaining({
        id: "s_prev:cf1",
        item: "Keep this",
        status: "active",
      }),
    ]);
    expect(lastReflect.carry_forward[0].request_id).toEqual(expect.any(String));
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

  it("stores deep-reflect output even when kv_operations are batch-rejected", async () => {
    const K = makeMockK(
      {
        last_reflect: {
          carry_forward: [],
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

    await applyReflectOutput(K, state, 1, {
      reflection: "Deep reflect summary",
      note_to_future_self: "Watch this",
      kv_operations: [
        {
          operation: "set",
          key: "pattern:test",
          value: { pattern: "bad", strength: 0.5 },
        },
      ],
    }, {});

    expect(await K.kvGet("pattern:test")).toBeNull();
    expect(await K.kvGet("reflect:1:s_dr")).toEqual(expect.objectContaining({
      reflection: "Deep reflect summary",
      note_to_future_self: "Watch this",
    }));
    expect(await K.kvGet("last_reflect")).toEqual(expect.objectContaining({
      session_summary: "Deep reflect summary",
      was_deep_reflect: true,
    }));
    expect(K.karmaRecord).toHaveBeenCalledWith(expect.objectContaining({
      event: "kv_operation_batch_rejected",
      source: "deep-reflect",
    }));
  });
});

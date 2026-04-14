import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import worker from "../index.js";
import { Kernel } from "../kernel.js";
import * as userspace from "../userspace.js";
import { makeKVStore } from "./helpers/mock-kv.js";

function makeEnv(initial = {}) {
  return { KV: makeKVStore(initial) };
}

function signSlackBody(secret, timestamp, rawBody) {
  const hex = crypto
    .createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return `v0=${hex}`;
}

describe("job completion callback", () => {
  it("accepts a valid callback, advances schedule, and wakes the kernel", async () => {
    const env = makeEnv({
      "job:j1": {
        id: "j1",
        type: "cc_analysis",
        status: "running",
        callback_secret: "cb_secret",
        workdir: "/tmp/jobs/j1",
        created_at: new Date().toISOString(),
      },
      "config:defaults": {
        schedule: { interval_seconds: 21600 },
        session_budget: { max_duration_seconds: 600 },
        jobs: { callback_advance_seconds: 30 },
      },
      "config:event_handlers": {
        handlers: { job_complete: ["sessionTrigger"] },
        deferred: {},
      },
      "session_schedule": {
        next_session_after: new Date(Date.now() + 3600_000).toISOString(),
        interval_seconds: 21600,
        no_action_streak: 0,
      },
    });

    const waitUntilPromises = [];
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    };

    const response = await worker.fetch(
      new Request("http://localhost/job-complete/j1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Callback-Secret": "cb_secret",
        },
        body: JSON.stringify({ exit_code: 0 }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(202);
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);

    const job = JSON.parse(env.KV._store.get("job:j1"));
    expect(job.status).toBe("completed");
    expect(job.exit_code).toBe(0);
    expect(job.callback_received_at).toBeTruthy();

    const executionHistory = JSON.parse(env.KV._store.get("kernel:last_executions"));
    expect(executionHistory[0].outcome).toBe("clean");
  });

  it("rejects an invalid callback secret", async () => {
    const env = makeEnv({
      "job:j1": {
        id: "j1",
        type: "cc_analysis",
        status: "running",
        callback_secret: "cb_secret",
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/job-complete/j1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Callback-Secret": "wrong",
        },
        body: JSON.stringify({ exit_code: 0 }),
      }),
      env,
      { waitUntil() {} },
    );

    expect(response.status).toBe(401);
  });

  it("hydrates job_result from callback output artifacts when provided", async () => {
    const env = makeEnv({
      "job:j1": {
        id: "j1",
        type: "custom",
        status: "running",
        callback_secret: "cb_secret",
        workdir: "/tmp/jobs/j1",
      },
      "config:defaults": {
        schedule: { interval_seconds: 21600 },
        session_budget: { max_duration_seconds: 600 },
        jobs: { callback_advance_seconds: 30 },
      },
      "config:event_handlers": {
        handlers: { job_complete: ["sessionTrigger"] },
        deferred: {},
      },
      "session_schedule": {
        next_session_after: new Date(Date.now() + 3600_000).toISOString(),
        interval_seconds: 21600,
        no_action_streak: 0,
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/job-complete/j1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Callback-Secret": "cb_secret",
        },
        body: JSON.stringify({
          exit_code: 0,
          output_base64: Buffer.from(JSON.stringify({
            review_note_key: "review_note:userspace_review:x_wait:d1:000:test",
            promotion_recommendation: "stageable",
            validated_changes_hash: "abc",
            validated_changes: { kv_operations: [], code_stage_requests: [], deploy: false },
          }), "utf8").toString("base64"),
          lab_result_base64: Buffer.from(JSON.stringify({
            review_note_key: "review_note:userspace_review:x_wait:d1:000:test",
            validated_changes_hash: "abc",
          }), "utf8").toString("base64"),
        }),
      }),
      env,
      { waitUntil() {} },
    );

    expect(response.status).toBe(202);
    const job = JSON.parse(env.KV._store.get("job:j1"));
    expect(job.result_key).toBe("job_result:j1");
    const result = JSON.parse(env.KV._store.get("job_result:j1"));
    expect(result.result.review_note_key).toBe("review_note:userspace_review:x_wait:d1:000:test");
    expect(result.lab_result.validated_changes_hash).toBe("abc");
  });

  it("persists a callback result record even when output artifacts are missing", async () => {
    const env = makeEnv({
      "job:j1": {
        id: "j1",
        type: "custom",
        status: "running",
        callback_secret: "cb_secret",
        workdir: "/tmp/jobs/j1",
      },
      "config:defaults": {
        schedule: { interval_seconds: 21600 },
        session_budget: { max_duration_seconds: 600 },
        jobs: { callback_advance_seconds: 30 },
      },
      "config:event_handlers": {
        handlers: { job_complete: ["sessionTrigger"] },
        deferred: {},
      },
      "session_schedule": {
        next_session_after: new Date(Date.now() + 3600_000).toISOString(),
        interval_seconds: 21600,
        no_action_streak: 0,
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/job-complete/j1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Callback-Secret": "cb_secret",
        },
        body: JSON.stringify({ exit_code: 0 }),
      }),
      env,
      { waitUntil() {} },
    );

    expect(response.status).toBe(202);
    const job = JSON.parse(env.KV._store.get("job:j1"));
    expect(job.result_key).toBe("job_result:j1");
    const result = JSON.parse(env.KV._store.get("job_result:j1"));
    expect(result.result).toBeNull();
    expect(result.callback_error).toBe("callback_missing_output");
  });

  it("marks corrupt callback artifacts on the result record instead of leaving the job running", async () => {
    const env = makeEnv({
      "job:j1": {
        id: "j1",
        type: "custom",
        status: "running",
        callback_secret: "cb_secret",
        workdir: "/tmp/jobs/j1",
      },
      "config:defaults": {
        schedule: { interval_seconds: 21600 },
        session_budget: { max_duration_seconds: 600 },
        jobs: { callback_advance_seconds: 30 },
      },
      "config:event_handlers": {
        handlers: { job_complete: ["sessionTrigger"] },
        deferred: {},
      },
      "session_schedule": {
        next_session_after: new Date(Date.now() + 3600_000).toISOString(),
        interval_seconds: 21600,
        no_action_streak: 0,
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/job-complete/j1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Callback-Secret": "cb_secret",
        },
        body: JSON.stringify({
          exit_code: 0,
          output_base64: "%%%not-base64%%%",
          lab_result_base64: "%%%also-bad%%%",
        }),
      }),
      env,
      { waitUntil() {} },
    );

    expect(response.status).toBe(202);
    const job = JSON.parse(env.KV._store.get("job:j1"));
    expect(job.status).toBe("completed");
    expect(job.result_key).toBe("job_result:j1");
    const result = JSON.parse(env.KV._store.get("job_result:j1"));
    expect(result.callback_error).toBe("invalid_output_base64");
    expect(result.lab_result_error).toBe("invalid_lab_result_base64");
  });
});

describe("external wake endpoint", () => {
  it("emits a wake event and runs the kernel without mutating the schedule", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const env = makeEnv({
      "config:defaults": {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model", max_output_tokens: 1000 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 600, reflect_reserve_pct: 0.33 },
        schedule: { interval_seconds: 21600 },
        execution: { max_steps: { act: 1, reflect: 1, deep_reflect: 1 } },
      },
      "config:event_handlers": {
        handlers: {},
        deferred: {},
      },
      "session_schedule": {
        next_session_after: future,
        interval_seconds: 21600,
        no_action_streak: 0,
      },
    });

    const waitUntilPromises = [];
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    };

    const response = await worker.fetch(
      new Request("http://localhost/__wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "dev_loop", context: { intent: "probe" } }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(202);
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);

    const sessionCounter = JSON.parse(env.KV._store.get("session_counter"));
    expect(sessionCounter).toBeGreaterThanOrEqual(1);

    const schedule = JSON.parse(env.KV._store.get("session_schedule"));
    expect(schedule.interval_seconds).toBeDefined();

    const executionHistory = JSON.parse(env.KV._store.get("kernel:last_executions"));
    expect(executionHistory[0].outcome).toBe("clean");
  });
});

describe("burst endpoint", () => {
  it("runs a bounded burst of sessions back-to-back", async () => {
    const env = makeEnv({
      "config:defaults": {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model", max_output_tokens: 1000 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 600, reflect_reserve_pct: 0.33 },
        schedule: { interval_seconds: 21600 },
        execution: { max_steps: { act: 1, reflect: 1, deep_reflect: 1 } },
      },
      "config:event_handlers": {
        handlers: {},
        deferred: {},
      },
      "session_schedule": {
        next_session_after: new Date(Date.now() + 3600_000).toISOString(),
        interval_seconds: 21600,
        no_action_streak: 0,
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/__burst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 2, actor: "test", reason: "burst_test" }),
      }),
      env,
      { waitUntil() {} },
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.requested).toBe(2);
    expect(payload.executed).toBeGreaterThanOrEqual(1);
    expect(payload.executed).toBeLessThanOrEqual(2);
    expect(payload.remaining).toBe(0);

    const sessionCounter = JSON.parse(env.KV._store.get("session_counter"));
    expect(sessionCounter).toBeGreaterThanOrEqual(2);
    const schedule = JSON.parse(env.KV._store.get("session_schedule"));
    expect(schedule.burst_remaining).toBeUndefined();
  });

  it("rejects concurrent bursts", async () => {
    const env = makeEnv({
      "kernel:active_burst": {
        started_at: new Date().toISOString(),
        actor: "test",
        reason: "already_running",
        count: 2,
      },
      "config:defaults": {
        schedule: { interval_seconds: 21600 },
      },
    });

    const response = await worker.fetch(
      new Request("http://localhost/__burst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 2 }),
      }),
      env,
      { waitUntil() {} },
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("burst already active");
  });
});

describe("inbound fast path", () => {
  it("handles trivial acknowledgements immediately while a session lock is active", async () => {
    const slackSecret = "slack_secret";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({
      event: {
        type: "message",
        channel: "D123",
        user: "U123",
        text: "ok great",
        ts: "1775576606.857549",
        client_msg_id: "msg-1",
      },
    });

    const env = {
      ...makeEnv({
        "config:defaults": {
          chat: {
            model: "sonnet",
            effort: "low",
            max_cost_per_conversation: 0.5,
            max_output_tokens: 1000,
            max_history_messages: 40,
          },
          act: { model: "sonnet" },
          session_budget: { max_duration_seconds: 600 },
        },
        "kernel:active_execution": {
          id: "x_active",
          started_at: new Date().toISOString(),
        },
        "session_request:req_1": {
          id: "req_1",
          contact: "swami_kevala",
          summary: "Investigate the Akash project",
          status: "pending",
          updated_at: "2026-04-07T12:00:00.000Z",
          ref: "chat:slack:U123",
        },
      }),
      SLACK_SIGNING_SECRET: slackSecret,
      SLACK_BOT_TOKEN: "xoxb-test",
    };

    const waitUntilPromises = [];
    const response = await worker.fetch(
      new Request("http://localhost/channel/slack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": signSlackBody(slackSecret, timestamp, body),
        },
        body,
      }),
      env,
      { waitUntil(promise) { waitUntilPromises.push(promise); } },
    );

    expect(response.status).toBe(200);
    await Promise.all(waitUntilPromises);
    expect([...env.KV._store.keys()].filter((key) => key.startsWith("event:"))).toEqual([]);

    const conv = JSON.parse(env.KV._store.get("chat:slack:U123"));
    expect(conv.messages.at(-1).role).toBe("user");
    expect(conv.messages.at(-1).content).toBe("ok great");
  });

  it("settles triaged inbound events during deferred processing without crashing", async () => {
    const eventTimestamp = "2026-04-08T10:00:00.000Z";
    const env = makeEnv({
      "config:defaults": {
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model", max_output_tokens: 1000 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 600, reflect_reserve_pct: 0.33 },
        schedule: { interval_seconds: 21600 },
        execution: { max_steps: { act: 1, reflect: 1, deep_reflect: 1 } },
      },
      "config:event_handlers": {
        handlers: {},
        deferred: { inbound_message: ["comms"] },
      },
      "chat:slack:U123": {
        id: "chat:slack:U123",
        messages: [
          { role: "user", content: "Look into the project", ts: eventTimestamp },
          { role: "assistant", content: "I’m taking this on.", ts: "2026-04-08T10:00:05.000Z" },
        ],
      },
      "event:000000000000001:inbound_message:test": {
        type: "inbound_message",
        key: "event:000000000000001:inbound_message:test",
        idempotency_key: "event:000000000000001:inbound_message:test",
        triage_attempted: true,
        timestamp: eventTimestamp,
        conversation_id: "chat:slack:U123",
        reply_target: { platform: "slack", channel: "U123", thread_ts: null },
        source: "inbound",
        content: "Look into the project",
        metadata: { sentTs: "1775576606.857549", userId: "U123" },
      },
    });

    await worker.scheduled({}, env, { waitUntil() {} });

    expect(env.KV._store.has("event:000000000000001:inbound_message:test")).toBe(false);

    const executionHistory = JSON.parse(env.KV._store.get("kernel:last_executions"));
    expect(executionHistory[0].outcome).toBe("clean");

    const karmas = executionHistory
      .map((entry) => JSON.parse(env.KV._store.get(`karma:${entry.id}`) || "[]"));
    expect(karmas.some((karma) => karma.some((entry) => entry.event === "comms_inbound_event_settled_after_immediate_triage"))).toBe(true);
    expect(karmas.some((karma) => karma.some((entry) => entry.event === "deferred_processor_error"))).toBe(false);
  });

  it("reprocesses triaged inbound events during deferred processing when no assistant reply exists yet", async () => {
    const llmSpy = vi.spyOn(Kernel.prototype, "callLLM").mockResolvedValue({
      content: '{"action":"discard","reason":"noop"}',
      cost: 0.001,
      toolCalls: null,
      usage: {},
    });
    const tickSpy = vi.spyOn(userspace, "run").mockResolvedValue();

    const eventTimestamp = "2026-04-08T10:00:00.000Z";
    const env = makeEnv({
      "config:defaults": {
        chat: {
          model: "sonnet",
          effort: "low",
          max_cost_per_conversation: 0.5,
          max_output_tokens: 1000,
          max_history_messages: 40,
        },
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model", max_output_tokens: 1000 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 600, reflect_reserve_pct: 0.33 },
        schedule: { interval_seconds: 21600 },
        execution: { max_steps: { act: 1, reflect: 1, deep_reflect: 1 } },
      },
      "config:event_handlers": {
        handlers: {},
        deferred: { inbound_message: ["comms"] },
      },
      "chat:slack:U123": {
        id: "chat:slack:U123",
        messages: [
          { role: "user", content: "Look into the project", ts: eventTimestamp },
        ],
      },
      "event:000000000000002:inbound_message:test": {
        type: "inbound_message",
        key: "event:000000000000002:inbound_message:test",
        idempotency_key: "event:000000000000002:inbound_message:test",
        triage_attempted: true,
        timestamp: eventTimestamp,
        conversation_id: "chat:slack:U123",
        reply_target: { platform: "slack", channel: "U123", thread_ts: null },
        source: "inbound",
        content: "Look into the project",
        metadata: { sentTs: "1775576606.857549", userId: "U123" },
      },
    });

    try {
      await worker.scheduled({}, env, { waitUntil() {} });
    } finally {
      llmSpy.mockRestore();
      tickSpy.mockRestore();
    }

    expect(env.KV._store.has("event:000000000000002:inbound_message:test")).toBe(false);

    const executionHistory = JSON.parse(env.KV._store.get("kernel:last_executions"));
    expect(executionHistory[0].outcome).toBe("clean");

    const karma = JSON.parse(env.KV._store.get(`karma:${executionHistory[0].id}`));
    expect(karma.some((entry) => entry.event === "comms_inbound_event_settled_after_immediate_triage")).toBe(false);
    expect(karma.some((entry) => entry.event === "deferred_processor_error")).toBe(false);
  });

  it("delivers fulfilled request follow-ups through deferred comms", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    globalThis.fetch = fetchMock;

    const llmSpy = vi.spyOn(Kernel.prototype, "callLLM").mockResolvedValue({
      content: null,
      cost: 0.001,
      usage: {},
      toolCalls: [
        {
          id: "tc_send_1",
          function: {
            name: "send",
            arguments: JSON.stringify({ message: "I reviewed the repo and completed the requested improvement." }),
          },
        },
      ],
    });
    const tickSpy = vi.spyOn(userspace, "run").mockResolvedValue();

    const env = makeEnv({
      "config:defaults": {
        chat: {
          model: "sonnet",
          effort: "low",
          max_cost_per_conversation: 0.5,
          max_output_tokens: 1000,
          max_history_messages: 40,
        },
        act: { model: "test-model", effort: "low", max_output_tokens: 2000 },
        reflect: { model: "test-model", max_output_tokens: 1000 },
        session_budget: { max_cost: 0.5, max_duration_seconds: 600, reflect_reserve_pct: 0.33 },
        schedule: { interval_seconds: 21600 },
        execution: { max_steps: { act: 1, reflect: 1, deep_reflect: 1 } },
      },
      "config:event_handlers": {
        handlers: {},
        deferred: { session_response: ["comms"] },
      },
      "chat:slack:U123": {
        id: "chat:slack:U123",
        reply_target: { platform: "slack", channel: "U123", thread_ts: null },
        messages: [
          { role: "user", content: "Please review the repo.", ts: "2026-04-08T09:00:00.000Z" },
        ],
      },
      "conversation_index:swami_kevala": "chat:slack:U123",
      "session_request:req_123": {
        id: "req_123",
        contact: "swami_kevala",
        summary: "Review the repo and make one meaningful improvement",
        status: "fulfilled",
        result: "I reviewed the repo and completed the requested improvement.",
        updated_at: "2026-04-08T10:00:00.000Z",
        ref: "chat:slack:U123",
      },
      "event:000000000000003:session_response:test": {
        type: "session_response",
        key: "event:000000000000003:session_response:test",
        idempotency_key: "event:000000000000003:session_response:test",
        ref: "session_request:req_123",
        contact: "swami_kevala",
        status: "fulfilled",
        timestamp: "2026-04-08T10:00:01.000Z",
      },
    });

    try {
      await worker.scheduled({}, env, { waitUntil() {} });
    } finally {
      llmSpy.mockRestore();
      tickSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }

    expect(env.KV._store.has("event:000000000000003:session_response:test")).toBe(false);

    const conv = JSON.parse(env.KV._store.get("chat:slack:U123"));
    expect(conv.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "I reviewed the repo and completed the requested improvement.",
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});

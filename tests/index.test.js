import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import worker from "../index.js";
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

    const schedule = JSON.parse(env.KV._store.get("session_schedule"));
    expect(new Date(schedule.next_session_after).getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
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
    expect(sessionCounter).toBe(1);

    const schedule = JSON.parse(env.KV._store.get("session_schedule"));
    expect(schedule.interval_seconds).toBeDefined();

    const executionHistory = JSON.parse(env.KV._store.get("kernel:last_executions"));
    expect(executionHistory[0].outcome).toBe("clean");
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
      { waitUntil() {} },
    );

    expect(response.status).toBe(200);
    expect([...env.KV._store.keys()].filter((key) => key.startsWith("event:"))).toEqual([]);

    const conv = JSON.parse(env.KV._store.get("chat:slack:U123"));
    expect(conv.messages.at(-1).role).toBe("user");
    expect(conv.messages.at(-1).content).toBe("ok great");
  });
});

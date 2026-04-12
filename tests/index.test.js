import { describe, it, expect } from "vitest";

import worker from "../index.js";
import { makeKVStore } from "./helpers/mock-kv.js";

function makeEnv(initial = {}) {
  return { KV: makeKVStore(initial) };
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

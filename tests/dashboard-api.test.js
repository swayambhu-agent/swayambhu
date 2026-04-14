import { describe, it, expect } from "vitest";
import worker from "../dashboard-api/worker.js";
import { makeKVStore } from "./helpers/mock-kv.js";

function makeEnv(initial = {}, metadata = {}) {
  const KV = makeKVStore(initial);
  for (const [key, meta] of Object.entries(metadata)) {
    KV._meta.set(key, meta);
  }
  return { KV };
}

async function fetchJson(path, env, init = {}) {
  const response = await worker.fetch(
    new Request(`http://localhost${path}`, init),
    env,
  );
  return response.json();
}

async function fetchResponse(url, env, init = {}) {
  return worker.fetch(new Request(url, init), env);
}

describe("dashboard API", () => {
  it("requires Cloudflare Access headers for non-local authenticated routes", async () => {
    const env = makeEnv();
    const response = await fetchResponse("https://api.swayambhu.dev/health", env);
    expect(response.status).toBe(401);

    const authed = await fetchResponse("https://api.swayambhu.dev/health", env, {
      headers: { "Cf-Access-Authenticated-User-Email": "swami@example.com" },
    });
    expect(authed.status).toBe(200);
  });

  it("/sessions distinguishes act, deep_reflect, and event_only executions", async () => {
    const env = makeEnv(
      {
        "karma:x_1000_act": [{ event: "act_start" }],
        "karma:x_2000_dr": [{ event: "privileged_write", key: "desire:test", op: "put", new_value: { slug: "test" } }],
        "karma:x_3000_evt": [{ event: "events_drained", count: 1 }],
        "reflect:1:x_2000_dr": { reflection: "DR complete", session_id: "x_2000_dr" },
        "cache:session_ids": ["x_1000_act"],
      },
      {
        "karma:x_1000_act": { updated_at: "2026-04-06T10:00:00.000Z" },
        "karma:x_2000_dr": { updated_at: "2026-04-06T10:01:00.000Z" },
        "karma:x_3000_evt": { updated_at: "2026-04-06T10:02:00.000Z" },
      },
    );

    const body = await fetchJson("/sessions", env);
    expect(body.sessions).toEqual([
      { id: "x_1000_act", type: "act", ts: "2026-04-06T10:00:00.000Z" },
      { id: "x_2000_dr", type: "deep_reflect", ts: "2026-04-06T10:01:00.000Z" },
      { id: "x_3000_evt", type: "event_only", ts: "2026-04-06T10:02:00.000Z" },
    ]);
  });

  it("/deep-reflect reconstructs operator outputs from DR karma when kv_operations are absent", async () => {
    const env = makeEnv({
      "reflect:1:x_3000_dr": {
        reflection: "Bootstrap DR",
        note_to_future_self: "Watch the next act session.",
        session_id: "x_3000_dr",
      },
      "karma:x_3000_dr": [
        {
          event: "privileged_write",
          key: "desire:self-knowledge",
          op: "put",
          new_value: {
            slug: "self-knowledge",
            direction: "approach",
            description: "I understand my own infrastructure.",
            source_principles: ["reflection"],
          },
        },
        {
          event: "privileged_write",
          key: "pattern:bootstrap:no-desires",
          op: "put",
          new_value: {
            pattern: "No active desires lead to no_action bootstrap sessions.",
            strength: 0.3,
          },
        },
      ],
      "cache:session_ids": ["x_1000_act", "x_2000_act"],
      "experience:1": {
        timestamp: "2026-04-06T10:00:00.000Z",
        action_ref: "action:a1",
        observation: "No action was taken.",
        desire_alignment: {
          top_positive: [{ desire_key: "desire:self-knowledge", score: 0.82 }],
          top_negative: [],
          affinity_magnitude: 0.82,
        },
        pattern_delta: { sigma: 1, scores: [] },
        salience: 1,
      },
      "experience:2": {
        timestamp: "2026-04-06T10:01:00.000Z",
        action_ref: "action:a2",
        observation: "No action was taken again.",
        desire_alignment: {
          top_positive: [{ desire_key: "desire:self-knowledge", score: 0.82 }],
          top_negative: [],
          affinity_magnitude: 0.82,
        },
        pattern_delta: { sigma: 1, scores: [] },
        salience: 1,
      },
      "dr:state:1": {
        dispatched_at: "2026-04-06T10:00:00.000Z",
        completed_at: "2026-04-06T10:02:00.000Z",
      },
    });

    const body = await fetchJson("/deep-reflect/x_3000_dr", env);
    expect(body.accumulation.act_sessions).toBe(2);
    expect(body.execution.d_output).toEqual([
      {
        action: "written",
        key: "desire:self-knowledge",
        description: "I understand my own infrastructure.",
        direction: "approach",
        source_principles: ["reflection"],
      },
    ]);
    expect(body.execution.s_output).toEqual([
      {
        action: "written",
        key: "pattern:bootstrap:no-desires",
        pattern: "No active desires lead to no_action bootstrap sessions.",
        strength: 0.3,
      },
    ]);
    expect(body.execution.duration_ms).toBe(120000);
    expect(body.experiences[0].desire_alignment).toEqual({
      top_positive: [{ desire_key: "desire:self-knowledge", score: 0.82 }],
      top_negative: [],
      affinity_magnitude: 0.82,
    });
  });

  it("/mind falls back to dr:state:1 for deep-reflect health when reflect schedule is absent", async () => {
    const env = makeEnv({
      "desire:self-knowledge": {
        slug: "self-knowledge",
        description: "I understand my tools.",
      },
      "experience:1": {
        timestamp: "2026-04-06T10:00:00.000Z",
        action_ref: "action:a1",
        observation: "No action was taken.",
        pattern_delta: { sigma: 1, scores: [] },
        salience: 1,
      },
      "reflect:1:x_3000_dr": {
        reflection: "Bootstrap DR",
        session_id: "x_3000_dr",
      },
      "dr:state:1": {
        status: "idle",
        generation: 1,
        last_applied_session: 2,
        next_due_session: 7,
      },
      "session_counter": 3,
    });

    const body = await fetchJson("/mind", env);
    expect(body.operator_health).toMatchObject({
      bootstrap_complete: true,
      last_deep_reflect_session: 2,
      sessions_since_dr: 1,
      next_dr_due: 7,
      deep_reflect_status: "idle",
      deep_reflect_generation: 1,
    });
  });

  it("/requests returns durable request summary sorted by status then recency", async () => {
    const env = makeEnv({
      "contact:swk": { name: "Swami Kevala" },
      "session_request:req_pending": {
        id: "req_pending",
        status: "pending",
        summary: "Inspect the repo for the next improvement",
        note: "Waiting on delegated task",
        requester: { type: "contact", id: "swk" },
        created_at: "2026-04-07T18:00:00.000Z",
        updated_at: "2026-04-07T18:30:00.000Z",
        ref: "chat:slack:U123",
      },
      "session_request:req_done": {
        id: "req_done",
        status: "fulfilled",
        summary: "Report back with one concrete finding",
        result: "Found a serialization simplification",
        requester: { type: "self", id: "self" },
        created_at: "2026-04-07T17:00:00.000Z",
        updated_at: "2026-04-07T18:45:00.000Z",
      },
      "session_request:req_rejected": {
        id: "req_rejected",
        status: "rejected",
        summary: "Attempt unreachable host",
        error: "ssh timeout",
        created_at: "2026-04-07T16:00:00.000Z",
        updated_at: "2026-04-07T18:10:00.000Z",
      },
    });

    const body = await fetchJson("/requests", env);
    expect(body.summary).toEqual({
      total: 3,
      open: 1,
      active: 1,
      blocked: 0,
      stale: 0,
      fulfilled: 1,
      expired: 0,
      rejected: 1,
      superseded: 0,
      closed: 2,
    });
    expect(body.requests.map((item) => item.id)).toEqual([
      "req_pending",
      "req_done",
      "req_rejected",
    ]);
    expect(body.requests[0]).toMatchObject({
      requester_name: "Swami Kevala",
      note: "Waiting on delegated task",
      ref: "chat:slack:U123",
    });
  });
});

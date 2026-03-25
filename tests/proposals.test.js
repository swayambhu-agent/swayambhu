import { describe, it, expect, vi, beforeEach } from "vitest";
import { Kernel } from "../kernel.js";
import { makeKVStore } from "./helpers/mock-kv.js";

// ── Test helpers ──────────────────────────────────────────────

function makeKernel(kvInit = {}, opts = {}) {
  const env = { KV: makeKVStore(kvInit) };
  const kernel= new Kernel(env, {
    TOOLS: opts.TOOLS || {},
    HOOKS: opts.HOOKS || {},
    PROVIDERS: opts.PROVIDERS || {},
    CHANNELS: opts.CHANNELS || {},
  });
  kernel.defaults = opts.defaults || {};
  kernel.toolRegistry = opts.toolRegistry || null;
  kernel.modelsConfig = opts.modelsConfig || null;
  kernel.modelCapabilities = opts.modelCapabilities || null;
  kernel.dharma = opts.dharma || null;
  kernel.toolGrants = opts.toolGrants || {};
  return { kernel, env };
}

// ── 1. isCodeKey ──────────────────────────────────────────────

describe("isCodeKey", () => {
  it("returns true for code keys", () => {
    expect(Kernel.isCodeKey("tool:kv_query:code")).toBe(true);
    expect(Kernel.isCodeKey("provider:llm:code")).toBe(true);
    expect(Kernel.isCodeKey("hook:act:code")).toBe(true);
    expect(Kernel.isCodeKey("channel:slack:code")).toBe(true);
  });

  it("returns false for non-code keys", () => {
    expect(Kernel.isCodeKey("tool:kv_query:meta")).toBe(false);
    expect(Kernel.isCodeKey("config:defaults")).toBe(false);
    expect(Kernel.isCodeKey("prompt:act")).toBe(false);
    expect(Kernel.isCodeKey("dharma")).toBe(false);
  });
});

// ── 2. createProposal ─────────────────────────────────────────

describe("createProposal", () => {
  let kernel, env;

  beforeEach(() => {
    ({ kernel, env } = makeKernel({
      session_counter: JSON.stringify(5),
    }));
  });

  it("creates proposal with correct structure", async () => {
    const request = {
      claims: ["improve web_fetch error handling"],
      ops: [{ key: "tool:web_fetch:code", op: "put", value: "new code" }],
      checks: [{ type: "kv_assert", key: "tool:web_fetch:code", predicate: "exists" }],
    };

    const id = await kernel.createProposal(request, "session_1", 0);

    expect(id).toBeTruthy();
    expect(id).toMatch(/^p_\d+_/);

    // Read the stored proposal
    const stored = await env.KV.get(`proposal:${id}`, "json");
    expect(stored.id).toBe(id);
    expect(stored.status).toBe("proposed");
    expect(stored.claims).toEqual(["improve web_fetch error handling"]);
    expect(stored.targets).toEqual(["tool:web_fetch:code"]);
    expect(stored.changes["tool:web_fetch:code"]).toEqual({
      op: "put",
      code: "new code",
      old_string: undefined,
      new_string: undefined,
    });
    expect(stored.checks).toHaveLength(1);
    expect(stored.proposed_by).toBe("session_1");
    expect(stored.proposed_by_depth).toBe(0);
    expect(stored.proposed_at_session).toBe(5);
  });

  it("rejects proposal with missing claims", async () => {
    const id = await kernel.createProposal(
      { claims: [], ops: [{ key: "tool:kv_query:code", value: "x" }] },
      "s1",
    );
    expect(id).toBeNull();
  });

  it("rejects proposal with missing ops", async () => {
    const id = await kernel.createProposal(
      { claims: ["do something"], ops: [] },
      "s1",
    );
    expect(id).toBeNull();
  });

  it("rejects proposal targeting non-code keys", async () => {
    const id = await kernel.createProposal(
      {
        claims: ["change config"],
        ops: [{ key: "config:defaults", op: "put", value: "{}" }],
      },
      "s1",
    );
    expect(id).toBeNull();
  });

  it("rejects mixed code and non-code ops", async () => {
    const id = await kernel.createProposal(
      {
        claims: ["mixed ops"],
        ops: [
          { key: "tool:kv_query:code", op: "put", value: "good" },
          { key: "config:defaults", op: "put", value: "bad" },
        ],
      },
      "s1",
    );
    expect(id).toBeNull();
  });

  it("stores patch ops with old_string/new_string", async () => {
    const request = {
      claims: ["fix typo"],
      ops: [{
        key: "hook:act:code",
        op: "patch",
        old_string: "typo",
        new_string: "fixed",
      }],
    };

    const id = await kernel.createProposal(request, "s1", 1);
    const stored = await env.KV.get(`proposal:${id}`, "json");
    expect(stored.changes["hook:act:code"]).toEqual({
      op: "patch",
      code: undefined,
      old_string: "typo",
      new_string: "fixed",
    });
  });
});

// ── 3. loadProposals ──────────────────────────────────────────

describe("loadProposals", () => {
  let kernel, env;

  beforeEach(() => {
    const kvInit = {
      session_counter: JSON.stringify(10),
      "proposal:p_1": JSON.stringify({
        id: "p_1",
        status: "proposed",
        claims: ["first"],
        checks: [],
        proposed_at_session: 8,
      }),
      "proposal:p_2": JSON.stringify({
        id: "p_2",
        status: "accepted",
        claims: ["second"],
        checks: [],
        proposed_at_session: 9,
      }),
      "proposal:p_3": JSON.stringify({
        id: "p_3",
        status: "proposed",
        claims: ["third"],
        checks: [
          { type: "kv_assert", key: "tool:web_fetch:code", predicate: "exists" },
        ],
        proposed_at_session: 7,
      }),
      // Key that the check references
      "tool:web_fetch:code": JSON.stringify("some code"),
    };
    ({ kernel, env } = makeKernel(kvInit));
  });

  it("loads all proposals without filter", async () => {
    const proposals = await kernel.loadProposals();

    expect(Object.keys(proposals)).toHaveLength(3);
    expect(proposals.p_1.record.status).toBe("proposed");
    expect(proposals.p_2.record.status).toBe("accepted");
  });

  it("filters by status", async () => {
    const proposed = await kernel.loadProposals("proposed");
    expect(Object.keys(proposed)).toHaveLength(2);
    expect(proposed.p_1).toBeTruthy();
    expect(proposed.p_3).toBeTruthy();
    expect(proposed.p_2).toBeUndefined();
  });

  it("computes sessions_since correctly", async () => {
    const proposals = await kernel.loadProposals();
    expect(proposals.p_1.sessions_since).toBe(2); // 10 - 8
    expect(proposals.p_2.sessions_since).toBe(1); // 10 - 9
    expect(proposals.p_3.sessions_since).toBe(3); // 10 - 7
  });

  it("evaluates checks on proposals that have them", async () => {
    const proposals = await kernel.loadProposals();

    // p_1 and p_2 have no checks
    expect(proposals.p_1.check_results).toBeNull();
    expect(proposals.p_2.check_results).toBeNull();

    // p_3 has a kv_assert check — tool:web_fetch:code should exist
    expect(proposals.p_3.check_results).toBeTruthy();
    expect(proposals.p_3.check_results.all_passed).toBe(true);
    expect(proposals.p_3.check_results.results).toHaveLength(1);
    expect(proposals.p_3.check_results.results[0].passed).toBe(true);
  });

  it("returns empty object when no proposals exist", async () => {
    const { kernel: emptyKernel } = makeKernel({});
    const proposals = await emptyKernel.loadProposals();
    expect(proposals).toEqual({});
  });
});

// ── 4. updateProposalStatus ───────────────────────────────────

describe("updateProposalStatus", () => {
  let kernel, env;

  beforeEach(() => {
    ({ kernel, env } = makeKernel({
      "proposal:p_1": JSON.stringify({
        id: "p_1",
        status: "proposed",
        claims: ["test"],
      }),
    }));
  });

  it("updates status and adds timestamp", async () => {
    await kernel.updateProposalStatus("p_1", "accepted", { accepted_by_depth: 1 });

    const stored = await env.KV.get("proposal:p_1", "json");
    expect(stored.status).toBe("accepted");
    expect(stored.accepted_by_depth).toBe(1);
    expect(stored.accepted_at).toBeTruthy();
  });

  it("throws for nonexistent proposal", async () => {
    await expect(kernel.updateProposalStatus("p_missing", "accepted"))
      .rejects.toThrow("No proposal: p_missing");
  });
});

// ── 5. processProposalVerdicts ────────────────────────────────

describe("processProposalVerdicts", () => {
  let kernel, env;

  beforeEach(() => {
    ({ kernel, env } = makeKernel({
      "proposal:p_1": JSON.stringify({
        id: "p_1",
        status: "proposed",
        claims: ["feature A"],
        targets: ["tool:web_fetch:code"],
        changes: { "tool:web_fetch:code": { op: "put", code: "new" } },
        checks: [],
      }),
      "proposal:p_2": JSON.stringify({
        id: "p_2",
        status: "proposed",
        claims: ["feature B"],
        targets: ["hook:act:code"],
        changes: { "hook:act:code": { op: "patch", old_string: "a", new_string: "b" } },
        checks: [],
      }),
      "proposal:p_3": JSON.stringify({
        id: "p_3",
        status: "proposed",
        claims: ["feature C"],
        targets: ["tool:kv_query:code"],
        changes: { "tool:kv_query:code": { op: "put", code: "v2" } },
        checks: [],
      }),
    }));
    // processProposalVerdicts writes deploy:pending using this.sessionId
    kernel.sessionId = "test_session";
  });

  it("accept — updates status and writes deploy:pending", async () => {
    await kernel.processProposalVerdicts(
      [{ proposal_id: "p_1", verdict: "accept" }],
      1,
    );

    const stored = await env.KV.get("proposal:p_1", "json");
    expect(stored.status).toBe("accepted");
    expect(stored.accepted_by_depth).toBe(1);

    // deploy:pending signal
    const pending = await env.KV.get("deploy:pending", "json");
    expect(pending).toBeTruthy();
    expect(pending.session_id).toBe("test_session");
  });

  it("reject — updates status with reason", async () => {
    await kernel.processProposalVerdicts(
      [{ proposal_id: "p_2", verdict: "reject", reason: "too risky" }],
      1,
    );

    const stored = await env.KV.get("proposal:p_2", "json");
    expect(stored.status).toBe("rejected");
    expect(stored.reason).toBe("too risky");
    expect(stored.rejected_by_depth).toBe(1);

    // No deploy:pending when only rejections
    const pending = await env.KV.get("deploy:pending", "json");
    expect(pending).toBeNull();
  });

  it("withdraw — deletes proposal from KV", async () => {
    await kernel.processProposalVerdicts(
      [{ proposal_id: "p_3", verdict: "withdraw" }],
      1,
    );

    const stored = await env.KV.get("proposal:p_3", "json");
    expect(stored).toBeNull();
  });

  it("modify — updates ops, changes, targets, and claims", async () => {
    await kernel.processProposalVerdicts(
      [{
        proposal_id: "p_1",
        verdict: "modify",
        updated_ops: [{ key: "tool:web_fetch:code", op: "put", value: "modified code" }],
        updated_claims: ["revised feature A"],
        updated_checks: [{ type: "kv_assert", key: "tool:web_fetch:code", predicate: "exists" }],
      }],
      1,
    );

    const stored = await env.KV.get("proposal:p_1", "json");
    expect(stored.claims).toEqual(["revised feature A"]);
    expect(stored.targets).toEqual(["tool:web_fetch:code"]);
    expect(stored.changes["tool:web_fetch:code"].code).toBe("modified code");
    expect(stored.checks).toHaveLength(1);
    expect(stored.modified_at).toBeTruthy();
    // Status should still be proposed (not accepted)
    expect(stored.status).toBe("proposed");
  });

  it("defer — records karma only, no status change", async () => {
    await kernel.processProposalVerdicts(
      [{ proposal_id: "p_2", verdict: "defer", reason: "need more data" }],
      1,
    );

    const stored = await env.KV.get("proposal:p_2", "json");
    expect(stored.status).toBe("proposed"); // unchanged
  });

  it("handles mixed verdicts — accept + reject", async () => {
    await kernel.processProposalVerdicts(
      [
        { proposal_id: "p_1", verdict: "accept" },
        { proposal_id: "p_2", verdict: "reject", reason: "bad" },
      ],
      1,
    );

    const p1 = await env.KV.get("proposal:p_1", "json");
    const p2 = await env.KV.get("proposal:p_2", "json");
    expect(p1.status).toBe("accepted");
    expect(p2.status).toBe("rejected");

    // deploy:pending should be written because at least one was accepted
    const pending = await env.KV.get("deploy:pending", "json");
    expect(pending).toBeTruthy();
  });

  it("skips verdicts without proposal_id", async () => {
    // Should not throw
    await kernel.processProposalVerdicts(
      [{ verdict: "accept" }, { proposal_id: "p_1", verdict: "accept" }],
      1,
    );

    const p1 = await env.KV.get("proposal:p_1", "json");
    expect(p1.status).toBe("accepted");
  });

  it("handles null/undefined verdicts gracefully", async () => {
    await kernel.processProposalVerdicts(null, 1);
    await kernel.processProposalVerdicts(undefined, 1);
    // Should not throw
  });
});

// ── 6. _evaluateChecks ────────────────────────────────────────

describe("_evaluateChecks", () => {
  it("kv_assert — passes when key exists", async () => {
    const { kernel } = makeKernel({
      "tool:web_fetch:code": JSON.stringify("export function execute() {}"),
    });

    const result = await kernel._evaluateChecks([
      { type: "kv_assert", key: "tool:web_fetch:code", predicate: "exists" },
    ]);

    expect(result.all_passed).toBe(true);
    expect(result.results[0].passed).toBe(true);
  });

  it("kv_assert — fails when key missing", async () => {
    const { kernel } = makeKernel({});

    const result = await kernel._evaluateChecks([
      { type: "kv_assert", key: "tool:nonexistent:code", predicate: "exists" },
    ]);

    expect(result.all_passed).toBe(false);
    expect(result.results[0].passed).toBe(false);
  });

  it("kv_assert with path — drills into nested value", async () => {
    const { kernel } = makeKernel({
      "config:defaults": JSON.stringify({ schedule: { interval: 3600 } }),
    });

    const result = await kernel._evaluateChecks([
      { type: "kv_assert", key: "config:defaults", path: "schedule.interval", predicate: "gt", expected: 1000 },
    ]);

    expect(result.all_passed).toBe(true);
  });

  it("all_passed is false when any check fails", async () => {
    const { kernel } = makeKernel({
      "tool:web_fetch:code": JSON.stringify("code"),
    });

    const result = await kernel._evaluateChecks([
      { type: "kv_assert", key: "tool:web_fetch:code", predicate: "exists" },
      { type: "kv_assert", key: "tool:missing:code", predicate: "exists" },
    ]);

    expect(result.all_passed).toBe(false);
    expect(result.results[0].passed).toBe(true);
    expect(result.results[1].passed).toBe(false);
  });

  it("unknown check type returns failed", async () => {
    const { kernel } = makeKernel({});

    const result = await kernel._evaluateChecks([
      { type: "bogus_check" },
    ]);

    expect(result.all_passed).toBe(false);
    expect(result.results[0].detail).toContain("unknown check type");
  });
});

import { describe, it, expect } from "vitest";
import { buildActContext } from "../act.js";

// ── buildActContext with events ────────────────────────────

describe("buildActContext with events", () => {
  it("includes events items in context", () => {
    const context = {
      balances: { providers: {}, wallets: {} },
      lastReflect: null,
      additionalContext: {},
      effort: "medium",
      crashData: null,
      events: [
        { type: "chat_message", contact_name: "Swami", summary: "explore on your own" },
        { type: "patron_direct", message: "check balances" },
      ],
    };
    const result = JSON.parse(buildActContext(context));
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe("chat_message");
    expect(result.events[1].type).toBe("patron_direct");
  });

  it("omits events key when events is empty", () => {
    const context = {
      balances: {}, lastReflect: null, additionalContext: {},
      effort: "low", crashData: null, events: [],
    };
    const result = JSON.parse(buildActContext(context));
    expect(result).not.toHaveProperty("events");
  });
});


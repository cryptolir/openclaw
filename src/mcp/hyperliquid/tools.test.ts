import { describe, it, expect } from "vitest";
import type { HyperliquidRuntimeClient } from "./runtime-client.js";
import { HYPERLIQUID_TOOLS } from "./tools.js";

const transferTool = () => {
  const t = HYPERLIQUID_TOOLS.find((x) => x.name === "hl_transfer");
  if (!t) {
    throw new Error("hl_transfer tool missing");
  }
  return t;
};

/** Records what would have gone over the wire; nothing is sent. */
const spyClient = () => {
  const calls: unknown[] = [];
  const client = {
    transfer: async (b: unknown) => {
      calls.push(b);
      return { ok: true };
    },
  } as unknown as HyperliquidRuntimeClient;
  return { calls, client };
};

describe("hl_transfer direction", () => {
  it("passes a valid spot_to_perp through", async () => {
    const { client, calls } = spyClient();
    await transferTool().handler(client, { amount: 20, direction: "spot_to_perp" });
    expect(calls).toEqual([{ amount: 20, direction: "spot_to_perp" }]);
  });

  // The bug this guards: the handler used to hardcode the direction, so asking
  // to move funds BACK to spot silently deposited more INTO perp instead.
  it("refuses the opposite direction instead of rewriting it", () => {
    const { client, calls } = spyClient();
    expect(() => transferTool().handler(client, { amount: 20, direction: "perp_to_spot" })).toThrow(
      /spot_to_perp/,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a missing direction", () => {
    const { client, calls } = spyClient();
    expect(() => transferTool().handler(client, { amount: 20 })).toThrow(/direction/);
    expect(calls).toEqual([]);
  });
});

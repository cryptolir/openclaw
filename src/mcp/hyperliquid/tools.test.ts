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

describe("hl_swap", () => {
  const swapTool = () => {
    const t = HYPERLIQUID_TOOLS.find((x) => x.name === "hl_swap");
    if (!t) {
      throw new Error("hl_swap tool missing");
    }
    return t;
  };
  const spy = () => {
    const calls: unknown[] = [];
    const client = {
      swap: async (b: unknown) => {
        calls.push(b);
        return { ok: true };
      },
    } as unknown as HyperliquidRuntimeClient;
    return { calls, client };
  };

  it("sends exactly {from, amount} — nothing that could widen the swap", async () => {
    const { client, calls } = spy();
    // Extra arguments a model might invent must not reach the runtime.
    await swapTool().handler(client, {
      from: "USDH",
      amount: 123.27,
      to: "BTC",
      px: 0.5,
      isBuy: true,
    });
    expect(calls).toEqual([{ from: "USDH", amount: 123.27 }]);
  });

  it("advertises only the three stablecoins", () => {
    const from = (swapTool().inputSchema as { properties: { from: { enum: string[] } } }).properties
      .from;
    expect(from.enum).toEqual(["USDH", "USDT0", "USDE"]);
  });

  it("refuses a missing coin or amount before calling the runtime", () => {
    const { client, calls } = spy();
    expect(() => swapTool().handler(client, { amount: 50 })).toThrow(/from/);
    expect(() => swapTool().handler(client, { from: "USDH" })).toThrow(/amount/);
    expect(calls).toEqual([]);
  });
});

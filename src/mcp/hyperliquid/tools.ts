/**
 * MCP tool definitions for the Hyperliquid integration.
 *
 * Tools are GROUPED rather than one-per-endpoint: a single hl_market_data with
 * a typed `kind` beats twenty near-identical tools, both for model accuracy and
 * for review surface.
 *
 * Every tool is a thin call to the dashboard. This layer enforces nothing —
 * typed schemas stop the model inventing parameters, they do not stop it
 * wanting the wrong thing. Caps, the asset allowlist and the key all live
 * behind /api/runtime/hyperliquid/*, which an agent can reach directly, so
 * that route is the boundary and this file is ergonomics.
 */

import type { HyperliquidRuntimeClient } from "./runtime-client.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: HyperliquidRuntimeClient, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== "string" || !v) {
    throw new Error(`${k} is required`);
  }
  return v;
};
const num = (o: Record<string, unknown>, k: string): number => {
  const v = typeof o[k] === "string" ? Number(o[k]) : o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${k} must be a number`);
  }
  return v;
};

export const HYPERLIQUID_TOOLS: ToolDef[] = [
  {
    name: "hl_market_data",
    description:
      "Read Hyperliquid market data: mid prices, the order book, candles, or perp metadata (asset list, size precision, max leverage). No account access, no signing.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "allMids",
            "l2Book",
            "candleSnapshot",
            "meta",
            "metaAndAssetCtxs",
            "fundingHistory",
            "predictedFundings",
          ],
          description: "Which market read to perform.",
        },
        coin: {
          type: "string",
          description:
            "Asset symbol, e.g. BTC. Required for l2Book, candleSnapshot, fundingHistory.",
        },
        interval: {
          type: "string",
          description: "Candle interval, e.g. 1m, 15m, 1h, 1d. Only for candleSnapshot.",
        },
        startTime: {
          type: "number",
          description: "Epoch ms. Only for candleSnapshot / fundingHistory.",
        },
        endTime: { type: "number", description: "Epoch ms, optional." },
      },
      required: ["kind"],
    },
    handler: (c, a) => {
      const kind = str(a, "kind");
      const body: Record<string, unknown> = { type: kind };
      if (kind === "l2Book" || kind === "fundingHistory") {
        body.coin = str(a, "coin");
      }
      if (kind === "candleSnapshot") {
        body.req = {
          coin: str(a, "coin"),
          interval: str(a, "interval"),
          startTime: num(a, "startTime"),
          endTime: a.endTime,
        };
      }
      if (kind === "fundingHistory") {
        body.startTime = num(a, "startTime");
      }
      return c.info(body);
    },
  },
  {
    name: "hl_account",
    description:
      "Read this agent's own Hyperliquid account: perp positions and margin, spot balances, open orders, recent fills, or portfolio history. The address is always this agent's own bound wallet — it cannot be pointed at another account.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "clearinghouseState",
            "spotClearinghouseState",
            "openOrders",
            "frontendOpenOrders",
            "userFills",
            "portfolio",
            "userFees",
          ],
          description: "Which account read to perform.",
        },
      },
      required: ["kind"],
    },
    handler: (c, a) => c.info({ type: str(a, "kind") }),
  },
  {
    name: "hl_place_order",
    description:
      "Place a limit order on Hyperliquid. Subject to owner-set limits: per-order and daily notional caps, a maximum leverage, and an asset allowlist. Exceeding a limit returns 403 with a cap_* code — do not retry or attempt to work around it. Hyperliquid has no market order: to cross the spread, send an aggressive limit price and accept the slippage explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        coin: {
          type: "string",
          description: "Asset symbol, e.g. BTC. Must be in the agent's allowlist.",
        },
        isBuy: { type: "boolean", description: "true to buy/long, false to sell/short." },
        px: {
          type: "number",
          description: "Limit price. Rounded server-side to the asset's tick rules.",
        },
        sz: { type: "number", description: "Size in units of the asset (not USD)." },
        reduceOnly: {
          type: "boolean",
          description: "Only reduce an existing position. Default false.",
        },
        tif: {
          type: "string",
          enum: ["Gtc", "Ioc", "Alo"],
          description: "Time in force. Default Gtc.",
        },
      },
      required: ["coin", "isBuy", "px", "sz"],
    },
    handler: (c, a) =>
      c.placeOrder({
        coin: str(a, "coin"),
        isBuy: Boolean(a.isBuy),
        px: num(a, "px"),
        sz: num(a, "sz"),
        reduceOnly: a.reduceOnly === true,
        tif: a.tif as "Gtc" | "Ioc" | "Alo" | undefined,
      }),
  },
  {
    name: "hl_cancel_order",
    description:
      "Cancel one resting order by its order id (oid), which comes from hl_account with kind=openOrders.",
    inputSchema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Asset symbol the order is on." },
        oid: { type: "number", description: "Order id from openOrders." },
      },
      required: ["coin", "oid"],
    },
    handler: (c, a) => c.cancelOrder({ coin: str(a, "coin"), oid: num(a, "oid") }),
  },
  {
    name: "hl_set_leverage",
    description:
      "Set leverage for one asset. Bounded by the owner-set maximum; a higher value returns 403 leverage_exceeded. Raising leverage raises liquidation risk on any open position.",
    inputSchema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Asset symbol." },
        leverage: { type: "number", description: "Requested leverage, e.g. 3." },
        isCross: {
          type: "boolean",
          description: "true for cross margin (default), false for isolated.",
        },
      },
      required: ["coin", "leverage"],
    },
    handler: (c, a) =>
      c.setLeverage({
        coin: str(a, "coin"),
        leverage: num(a, "leverage"),
        isCross: a.isCross !== false,
      }),
  },
  {
    name: "hl_transfer",
    description:
      "Move USDC from the spot account into the perp account so it can back trades. This is the ONLY direction — perp-to-spot does not exist here, deliberately. Amount is whole US dollars (no cents: the dashboard sets the cents as a tracking tag and sends slightly less than requested). One transfer at a time per account; if one is unresolved, reconcile with hl_transfer_status before retrying. Bounded by the owner-set daily limit.",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description: "Whole US dollars to move, e.g. 20. Minimum 5.",
        },
        direction: {
          type: "string",
          enum: ["spot_to_perp"],
          description: "Only spot_to_perp exists.",
        },
      },
      required: ["amount", "direction"],
    },
    handler: (c, a) =>
      c.transfer({
        amount: num(a, "amount"),
        direction: "spot_to_perp",
      }),
  },
  {
    name: "hl_transfer_status",
    description:
      "Reconcile the account's in-flight transfer against the exchange ledger: reports landed, still-pending (with whether a retry is allowed yet), or blocked (an owner must clear a double-land).",
    inputSchema: { type: "object", properties: {} },
    handler: (c) => c.transferStatus(),
  },
  {
    name: "hl_account_status",
    description:
      "Trading readiness for this agent's own account: whether Hyperliquid is enabled, the Trading Key is present, the exchange still honours its approval, and when that approval expires. Use this to explain WHY an order might be refused, instead of discovering it from the refusal.",
    inputSchema: { type: "object", properties: {} },
    handler: (c) => c.accountStatus(),
  },
];

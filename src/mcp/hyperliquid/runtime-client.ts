/**
 * Thin HTTP client for the dashboard's /api/runtime/hyperliquid/* endpoints.
 *
 * Holds NO credential of its own and never contacts api.hyperliquid.xyz: the
 * exchange is reached only by the dashboard, which owns the Trading Key, the
 * caps and the signing. This process reads AGENTGLOB_RUNTIME_URL and
 * AGENTGLOB_RUNTIME_TOKEN from the gateway's env, exactly like the Rain MCP.
 */

export class RuntimeClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RuntimeClientError";
  }
}

export class HyperliquidRuntimeClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  static fromEnv(): HyperliquidRuntimeClient {
    const url = process.env.AGENTGLOB_RUNTIME_URL;
    const token = process.env.AGENTGLOB_RUNTIME_TOKEN;
    if (!url || !token) {
      throw new RuntimeClientError(
        0,
        "Hyperliquid MCP requires AGENTGLOB_RUNTIME_URL and AGENTGLOB_RUNTIME_TOKEN in the environment. Redeploy the agent from the dashboard so these are populated.",
      );
    }
    return new HyperliquidRuntimeClient(url.replace(/\/$/, ""), token);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/runtime/hyperliquid${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // A non-JSON body means we did not reach the route we think we did —
      // an HTML login redirect reads as success to a naive parser.
      throw new RuntimeClientError(
        res.status,
        `non-JSON response from the runtime (${res.status})`,
      );
    }
    if (!res.ok) {
      const o = json as { error?: string; code?: string };
      throw new RuntimeClientError(res.status, o?.error ?? `runtime error ${res.status}`, o?.code);
    }
    return json;
  }

  /** Market and account reads. `user` is filled in server-side, never here. */
  info(body: Record<string, unknown>): Promise<unknown> {
    return this.post("/info", body);
  }

  placeOrder(body: {
    coin: string;
    isBuy: boolean;
    px: number;
    sz: number;
    reduceOnly?: boolean;
    tif?: "Gtc" | "Ioc" | "Alo";
  }): Promise<unknown> {
    return this.post("/order", body);
  }

  cancelOrder(body: { coin: string; oid: number }): Promise<unknown> {
    return this.post("/cancel", body);
  }

  setLeverage(body: { coin: string; leverage: number; isCross?: boolean }): Promise<unknown> {
    return this.post("/leverage", body);
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: vi.fn(() => ({ gateway: { auth: { token: "t" } } })) };
});

import { BrowserControlHttpError, fetchBrowserJson } from "./client-fetch.js";

const URL_OPEN = "http://127.0.0.1:18791/tabs/open";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBrowserJson: the control service's own error answers", () => {
  it("passes an error status through as the service's message, not as \"can't reach\"", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "tab limit reached (6 tabs open, browser.maxTabs=6)" }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );
    const err = await fetchBrowserJson(URL_OPEN, { method: "POST" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserControlHttpError);
    expect((err as BrowserControlHttpError).status).toBe(409);
    expect((err as Error).message).toBe("tab limit reached (6 tabs open, browser.maxTabs=6)");
    expect((err as Error).message).not.toMatch(/retry|can't reach/i);
  });

  it("still wraps a connection failure as unreachable, telling the model not to retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:18791");
      }),
    );
    await expect(fetchBrowserJson(URL_OPEN, { method: "POST" })).rejects.toThrow(
      /Can't reach the OpenClaw browser control service.*Do NOT retry/,
    );
  });
});

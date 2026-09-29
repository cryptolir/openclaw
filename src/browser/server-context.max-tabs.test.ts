import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { resolveBrowserConfig } from "./config.js";
import * as pwAiModule from "./pw-ai-module.js";
import type { BrowserServerState } from "./server-context.js";
import "./server-context.chrome-test-harness.js";
import { BrowserTabLimitError, createBrowserRouteContext } from "./server-context.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeState(maxTabs: number | undefined): BrowserServerState {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpProtocol: "https",
      cdpHost: "browserless.example",
      cdpIsLoopback: false,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      evaluateEnabled: false,
      maxTabs,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
      defaultProfile: "remote",
      profiles: {
        remote: {
          cdpUrl: "https://browserless.example/chrome?token=abc",
          cdpPort: 443,
          color: "#00AA00",
        },
      },
    },
    profiles: new Map(),
  };
}

function page(id: string, type = "page") {
  return { targetId: id, title: id, url: `https://example.com/${id}`, type };
}

function harness(params: { tabs: ReturnType<typeof page>[]; maxTabs: number | undefined }) {
  global.fetch = withFetchPreconnect(
    vi.fn(async () => {
      throw new Error("unexpected fetch");
    }),
  );
  const createPageViaPlaywright = vi.fn(async () => page("NEW"));
  vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue({
    listPagesViaPlaywright: vi.fn(async () => params.tabs),
    createPageViaPlaywright,
    closePageByTargetIdViaPlaywright: vi.fn(async () => {}),
  } as unknown as Awaited<ReturnType<typeof pwAiModule.getPwAiModule>>);
  const ctx = createBrowserRouteContext({ getState: () => makeState(params.maxTabs) });
  return { ctx, remote: ctx.forProfile("remote"), createPageViaPlaywright };
}

describe("browser tab limit (browser.maxTabs)", () => {
  it("refuses to open a tab at the limit, without creating one", async () => {
    const { remote, createPageViaPlaywright } = harness({
      tabs: ["A", "B", "C", "D", "E", "F"].map((id) => page(id)),
      maxTabs: 6,
    });
    await expect(remote.openTab("https://example.com/new")).rejects.toThrow(
      /tab limit reached \(6 tabs open, browser\.maxTabs=6\)/,
    );
    expect(createPageViaPlaywright).not.toHaveBeenCalled();
  });

  it("opens a tab under the limit", async () => {
    const { remote, createPageViaPlaywright } = harness({
      tabs: ["A", "B", "C", "D", "E"].map((id) => page(id)),
      maxTabs: 6,
    });
    await expect(remote.openTab("https://example.com/new")).resolves.toMatchObject({
      targetId: "NEW",
    });
    expect(createPageViaPlaywright).toHaveBeenCalledTimes(1);
  });

  it("counts page targets only, not workers or iframes", async () => {
    const { remote, createPageViaPlaywright } = harness({
      tabs: [
        ...["A", "B", "C", "D", "E"].map((id) => page(id)),
        page("W1", "service_worker"),
        page("W2", "iframe"),
      ],
      maxTabs: 6,
    });
    await remote.openTab("https://example.com/new");
    expect(createPageViaPlaywright).toHaveBeenCalledTimes(1);
  });

  it("applies the default limit when the config has none, and 0 lifts it", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => page(`T${i}`));
    const withDefault = harness({ tabs: ten, maxTabs: undefined });
    await expect(withDefault.remote.openTab("https://example.com/new")).rejects.toThrow(
      /browser\.maxTabs=6/,
    );
    vi.restoreAllMocks();
    const unlimited = harness({ tabs: ten, maxTabs: 0 });
    await unlimited.remote.openTab("https://example.com/new");
    expect(unlimited.createPageViaPlaywright).toHaveBeenCalledTimes(1);
  });

  it("maps the limit error to 409 for the control server", () => {
    const { ctx } = harness({ tabs: [], maxTabs: 6 });
    expect(ctx.mapTabError(new BrowserTabLimitError("tab limit reached"))).toEqual({
      status: 409,
      message: "tab limit reached",
    });
  });

  it("resolves maxTabs from config: default 6, 0 kept, junk falls back", () => {
    expect(resolveBrowserConfig({}).maxTabs).toBe(6);
    expect(resolveBrowserConfig({ maxTabs: 0 }).maxTabs).toBe(0);
    expect(resolveBrowserConfig({ maxTabs: 3.7 }).maxTabs).toBe(3);
    expect(resolveBrowserConfig({ maxTabs: -1 }).maxTabs).toBe(6);
  });
});

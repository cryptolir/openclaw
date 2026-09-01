import { describe, expect, it, vi } from "vitest";
import { SsrFBlockedError, type LookupFn } from "../infra/net/ssrf.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationCompleted,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
} from "./navigation-guard.js";

function createLookupFn(address: string): LookupFn {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn(async () => [{ address, family }]) as unknown as LookupFn;
}

describe("browser navigation guard", () => {
  it("blocks private loopback URLs by default", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://127.0.0.1:8080",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows non-network schemes", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:blank",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows blocked hostnames when explicitly allowed", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://agent.internal:3000",
        ssrfPolicy: {
          allowedHostnames: ["agent.internal"],
        },
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("agent.internal", { all: true });
  });

  it("blocks hostnames that resolve to private addresses by default", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows hostnames that resolve to public addresses", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
      }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("rejects invalid URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "not a url",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });
});

type FakeRequest = {
  url(): string;
  redirectedFrom(): FakeRequest | null;
};

function createRequestChain(urls: string[]) {
  // urls oldest-first; Playwright exposes the newest request, walking back.
  let current: FakeRequest | null = null;
  for (const url of urls) {
    const previous: FakeRequest | null = current;
    current = { url: () => url, redirectedFrom: () => previous };
  }
  return current as never;
}

function createPage(finalUrl: string) {
  const gotos: string[] = [];
  return {
    gotos,
    page: {
      url: () => finalUrl,
      goto: async (url: string) => {
        gotos.push(url);
        return null;
      },
    },
  };
}

describe("browser navigation post-navigation guards", () => {
  it("blocks a redirect chain that ends on a private address", async () => {
    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: createRequestChain(["https://example.com/start", "http://127.0.0.1:8080/admin"]),
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows a redirect chain that stays public", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: createRequestChain(["https://example.com/a", "https://example.com/b"]),
        lookupFn,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores browser-internal result URLs", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({ url: "chrome-error://chromewebdata/" }),
    ).resolves.toBeUndefined();
  });

  it("blocks a final URL that landed on a private address", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({ url: "http://169.254.169.254/latest/meta-data/" }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("blanks the page before rethrowing so the content cannot be read back", async () => {
    const { page, gotos } = createPage("http://169.254.169.254/latest/meta-data/");
    await expect(assertBrowserNavigationCompleted({ page })).rejects.toBeInstanceOf(
      SsrFBlockedError,
    );
    expect(gotos).toEqual(["about:blank"]);
  });

  it("leaves an allowed page alone", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const { page, gotos } = createPage("https://example.com/ok");
    await expect(assertBrowserNavigationCompleted({ page, lookupFn })).resolves.toBeUndefined();
    expect(gotos).toEqual([]);
  });
});

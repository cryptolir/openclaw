import {
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
};

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {};
}

export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    return;
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/** Minimal request shape used to walk browser redirect chains. */
type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

/**
 * Post-navigation guard for the URL a page actually landed on.
 *
 * Only network URLs (http/https) are checked so browser-internal error pages
 * (chrome-error://, about:blank) do not produce false positives.
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    return;
  }
  await assertBrowserNavigationAllowed(opts);
}

/**
 * Assert every hop of a redirect chain is policy-allowed.
 *
 * assertBrowserNavigationAllowed only sees the URL we asked for; the browser
 * follows 3xx on its own, so each intermediate hop needs the same check.
 */
export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  // Walk oldest hop first so the error names the first URL that broke policy.
  for (const url of chain.toReversed()) {
    await assertBrowserNavigationResultAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
    });
  }
}

/** Minimal page shape needed to validate and contain a completed navigation. */
type BrowserNavigationPageLike = {
  url(): string;
  goto(url: string): Promise<unknown>;
};

/**
 * Validate a completed navigation: every redirect hop plus the final URL.
 *
 * On failure the page is blanked before rethrowing. Throwing alone would leave
 * the disallowed page loaded in the tab, where a later snapshot or screenshot
 * on the same targetId could still read it.
 */
export async function assertBrowserNavigationCompleted(
  opts: {
    page: BrowserNavigationPageLike;
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const { page, request, ...policy } = opts;
  try {
    await assertBrowserNavigationRedirectChainAllowed({ request, ...policy });
    await assertBrowserNavigationResultAllowed({ url: page.url(), ...policy });
  } catch (err) {
    await page.goto("about:blank").catch(() => {});
    throw err;
  }
}

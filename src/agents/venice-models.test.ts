import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVeniceModelDefinition,
  discoverVeniceModels,
  refreshVeniceCosts,
  resolveVeniceCachePreservation,
  veniceCostFromPricing,
  VENICE_MODEL_CATALOG,
} from "./venice-models.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_FETCH = globalThis.fetch;

function setNonTestEnv() {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
}

describe("venice-models", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_VITEST === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = ORIGINAL_VITEST;
    }
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("buildVeniceModelDefinition preserves catalog maxTokens", () => {
    const entry = VENICE_MODEL_CATALOG.find((m) => m.id === "llama-3.3-70b");
    expect(entry).toBeDefined();
    const def = buildVeniceModelDefinition(entry!);
    expect(def.maxTokens).toBe(4096);
  });

  it("uses Venice API maxCompletionTokens for known catalog models", async () => {
    setNonTestEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "llama-3.3-70b",
            model_spec: {
              name: "Llama 3.3 70B",
              privacy: "private",
              availableContextTokens: 128000,
              maxCompletionTokens: 4096,
              capabilities: {
                supportsReasoning: false,
                supportsVision: false,
                supportsFunctionCalling: true,
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { models, source } = await discoverVeniceModels();
    expect(source).toBe("api");
    const llama = models.find((m) => m.id === "llama-3.3-70b");

    expect(llama).toBeDefined();
    expect(llama?.maxTokens).toBe(4096);
    expect(llama?.contextWindow).toBe(128000);
  });

  it("falls back to 8192 for unknown models without maxCompletionTokens", async () => {
    setNonTestEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "new-unknown-model",
            model_spec: {
              name: "New Unknown",
              privacy: "private",
              availableContextTokens: 64000,
              capabilities: {
                supportsReasoning: false,
                supportsVision: false,
                supportsFunctionCalling: false,
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { models } = await discoverVeniceModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.maxTokens).toBe(8192);
    expect(models[0]?.contextWindow).toBe(64000);
  });
});

describe("veniceCostFromPricing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps full API pricing exactly (USD per million tokens)", () => {
    const cost = veniceCostFromPricing("claude-opus-4-6", {
      input: { usd: 6 },
      output: { usd: 30 },
      cache_input: { usd: 0.6 },
      cache_write: { usd: 7.5 },
    });
    expect(cost).toEqual({ input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 });
  });

  it("fails closed to $0 + warn for missing cache fields (never a guessed rate)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = veniceCostFromPricing("qwen3-5-9b", {
      input: { usd: 0.1 },
      output: { usd: 0.15 },
    });
    expect(cost).toEqual({ input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("qwen3-5-9b");
    expect(String(warn.mock.calls[0]?.[0])).toContain("cache_input");
  });

  it("prices absent pricing all-zero + warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = veniceCostFromPricing("mystery-model", undefined);
    expect(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("mystery-model");
  });

  it("treats negative/NaN usd as absent (0) and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = veniceCostFromPricing("bad-pricing", {
      input: { usd: -5 },
      output: { usd: Number.NaN },
    });
    expect(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("bad-pricing");
  });

  it("flags context-tiered pricing and uses the base tier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = veniceCostFromPricing("qwen-3-6-plus", {
      input: { usd: 1.25 },
      output: { usd: 3.75 },
      cache_input: { usd: 0.03125 },
      cache_write: { usd: 0.39 },
      extended: { context_token_threshold: 256000, input: { usd: 2.5 }, output: { usd: 7.5 } },
    });
    expect(cost).toEqual({ input: 1.25, output: 3.75, cacheRead: 0.03125, cacheWrite: 0.39 });
    const tierWarn = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("context-tiered"));
    expect(tierWarn).toBeDefined();
    expect(tierWarn).toContain("256000");
  });

  it("does not emit a tier warn for flat pricing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    veniceCostFromPricing("flat-model", {
      input: { usd: 1 },
      output: { usd: 2 },
      cache_input: { usd: 0.1 },
      cache_write: { usd: 0.5 },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("refreshVeniceCosts", () => {
  const model = (
    id: string,
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
  ) => ({
    id,
    cost,
  });
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const priced = { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 };

  it("replaces a zero cost with the API cost for matching ids (onboard-catalog reprice)", () => {
    const out = refreshVeniceCosts([model("a", zero)], [model("a", priced)]);
    expect(out[0]?.cost).toEqual(priced);
  });

  it("replaces a stale nonzero cost with an API zero (fail-closed wins)", () => {
    const out = refreshVeniceCosts([model("a", priced)], [model("a", zero)]);
    expect(out[0]?.cost).toEqual(zero);
  });

  it("leaves ids the API did not return untouched (fill semantics)", () => {
    const out = refreshVeniceCosts([model("kept", priced)], [model("other", zero)]);
    expect(out[0]?.cost).toEqual(priced);
  });

  it("skips authoritative entries without a cost (never writes cost: undefined)", () => {
    const out = refreshVeniceCosts([model("a", priced)], [{ id: "a" }]);
    expect(out[0]?.cost).toEqual(priced);
  });
});

describe("resolveVeniceCachePreservation", () => {
  const model = (id: string, input: number) => ({
    id,
    cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
  });

  it("fallback never clobbers a non-empty cache and fills missing ids (zero-cost)", () => {
    const cached = [model("a", 6), model("b", 3)];
    const preservation = resolveVeniceCachePreservation({
      existingModels: cached,
      newModels: [model("a", 0), model("b", 0), model("c", 0)],
      source: "fallback",
    });
    expect(preservation).not.toBeNull();
    // cached prices survive the outage; the fallback-only id is appended
    expect(preservation?.models.map((m) => [m.id, m.cost.input])).toEqual([
      ["a", 6],
      ["b", 3],
      ["c", 0],
    ]);
  });

  it("fallback with an empty cache returns null (fresh write)", () => {
    const preservation = resolveVeniceCachePreservation({
      existingModels: [],
      newModels: [model("a", 0)],
      source: "fallback",
    });
    expect(preservation).toBeNull();
  });

  it("api with fewer models preserves the cache but refreshes costs from the raw API list", () => {
    const preservation = resolveVeniceCachePreservation({
      existingModels: [model("a", 1), model("b", 3)],
      newModels: [model("a", 9)],
      apiModels: [model("a", 9)],
      source: "api",
    });
    expect(preservation).not.toBeNull();
    expect(preservation?.models.map((m) => [m.id, m.cost.input])).toEqual([
      ["a", 9],
      ["b", 3],
    ]);
  });

  it("explicit-only ids never zero cached prices — only the raw API list is authoritative", () => {
    // verify-workflow blocker: cache {A:6,B:3,C:1}; API returned only A;
    // merged list carries the explicit onboard-catalog zero for B. B and C
    // must keep their last-known-good prices.
    const preservation = resolveVeniceCachePreservation({
      existingModels: [model("a", 6), model("b", 3), model("c", 1)],
      newModels: [model("a", 9), model("b", 0)],
      apiModels: [model("a", 9)],
      source: "api",
    });
    expect(preservation).not.toBeNull();
    expect(preservation?.models.map((m) => [m.id, m.cost.input])).toEqual([
      ["a", 9],
      ["b", 3],
      ["c", 1],
    ]);
  });

  it("no discovery (source undefined) never refreshes costs, only fills new ids", () => {
    // verify-workflow blocker: explicit-only run (no Venice key) must not let
    // the zero-cost onboard catalog rewrite cached real prices.
    const preservation = resolveVeniceCachePreservation({
      existingModels: [model("a", 6)],
      newModels: [model("a", 0), model("b", 0)],
      source: undefined,
    });
    expect(preservation).not.toBeNull();
    expect(preservation?.models.map((m) => [m.id, m.cost.input])).toEqual([
      ["a", 6],
      ["b", 0],
    ]);
  });

  it("api with same-or-more models returns null (discovery replaces the cache)", () => {
    const preservation = resolveVeniceCachePreservation({
      existingModels: [model("a", 1)],
      newModels: [model("a", 9), model("b", 2)],
      source: "api",
    });
    expect(preservation).toBeNull();
  });
});

describe("discovery pricing + source", () => {
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_VITEST === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = ORIGINAL_VITEST;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("threads API pricing into catalog-match and unknown models", async () => {
    setNonTestEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "llama-3.3-70b",
            model_spec: {
              name: "Llama 3.3 70B",
              privacy: "private",
              availableContextTokens: 128000,
              maxCompletionTokens: 4096,
              capabilities: {
                supportsReasoning: false,
                supportsVision: false,
                supportsFunctionCalling: true,
              },
              pricing: { input: { usd: 0.7 }, output: { usd: 2.8 } },
            },
          },
          {
            id: "brand-new-model",
            model_spec: {
              name: "Brand New",
              privacy: "private",
              availableContextTokens: 64000,
              capabilities: {
                supportsReasoning: false,
                supportsVision: false,
                supportsFunctionCalling: false,
              },
              pricing: {
                input: { usd: 1 },
                output: { usd: 4 },
                cache_input: { usd: 0.1 },
                cache_write: { usd: 1.25 },
              },
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { models, source } = await discoverVeniceModels();
    expect(source).toBe("api");
    expect(models.find((m) => m.id === "llama-3.3-70b")?.cost).toEqual({
      input: 0.7,
      output: 2.8,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(models.find((m) => m.id === "brand-new-model")?.cost).toEqual({
      input: 1,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it("falls back to the zero-cost catalog with source fallback on fetch failure", async () => {
    setNonTestEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { models, source } = await discoverVeniceModels();
    expect(source).toBe("fallback");
    expect(models.length).toBe(VENICE_MODEL_CATALOG.length);
    expect(models.every((m) => m.cost?.input === 0 && m.cost?.output === 0)).toBe(true);
    const warn = vi.mocked(console.warn);
    expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes("static catalog"))).toBe(
      true,
    );
  }, 20_000);
});

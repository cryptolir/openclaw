import { describe, expect, it } from "vitest";
import { mergeProviders } from "./models-config.js";
import type { ProviderConfig } from "./models-config.providers.js";

// Named tests from docs/plans/venice-per-token-pricing.md §Tests (Rev 2 P1 +
// Rev 5): the Venice-scoped cost-aware merge and its provider scoping.

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const priced = { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 };

function model(id: string, cost: typeof zero) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost,
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function provider(models: ReturnType<typeof model>[]): ProviderConfig {
  return {
    baseUrl: "https://api.venice.ai/api/v1",
    api: "openai-completions",
    models,
  };
}

describe("mergeProviders venice cost-aware merge", () => {
  it("API discovery cost overrides an explicit zero-cost entry (onboard catalog reprice)", () => {
    const merged = mergeProviders({
      implicit: { venice: provider([model("claude-opus-4-6", priced)]) },
      explicit: { venice: provider([model("claude-opus-4-6", zero)]) },
      veniceSource: "api",
    });
    expect(merged.venice?.models?.[0]?.cost).toEqual(priced);
  });

  it("API discovery zero overrides an explicit nonzero entry (fail-closed wins)", () => {
    const merged = mergeProviders({
      implicit: { venice: provider([model("claude-opus-4-6", zero)]) },
      explicit: { venice: provider([model("claude-opus-4-6", priced)]) },
      veniceSource: "api",
    });
    expect(merged.venice?.models?.[0]?.cost).toEqual(zero);
  });

  it("fallback discovery never overrides explicit costs (fills missing ids only)", () => {
    const merged = mergeProviders({
      implicit: {
        venice: provider([model("claude-opus-4-6", zero), model("catalog-only", zero)]),
      },
      explicit: { venice: provider([model("claude-opus-4-6", priced)]) },
      veniceSource: "fallback",
    });
    const models = merged.venice?.models ?? [];
    expect(models.find((m) => m.id === "claude-opus-4-6")?.cost).toEqual(priced);
    expect(models.find((m) => m.id === "catalog-only")?.cost).toEqual(zero);
  });

  it("does not touch non-Venice providers (scope proof)", () => {
    const merged = mergeProviders({
      implicit: { openrouter: provider([model("some-model", priced)]) },
      explicit: { openrouter: provider([model("some-model", zero)]) },
      veniceSource: "api",
    });
    expect(merged.openrouter?.models?.[0]?.cost).toEqual(zero);
  });

  it("keeps explicit-only ids and appends implicit-only ids", () => {
    const merged = mergeProviders({
      implicit: { venice: provider([model("discovered-only", priced)]) },
      explicit: { venice: provider([model("explicit-only", zero)]) },
      veniceSource: "api",
    });
    const ids = (merged.venice?.models ?? []).map((m) => m.id);
    expect(ids).toEqual(["explicit-only", "discovered-only"]);
    expect(merged.venice?.models?.find((m) => m.id === "discovered-only")?.cost).toEqual(priced);
  });
});

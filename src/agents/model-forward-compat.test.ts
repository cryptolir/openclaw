import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveForwardCompatModel } from "./model-forward-compat.js";
import type { ModelRegistry } from "./pi-model-discovery.js";

function createTemplateModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "anthropic-messages",
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<Api>;
}

function createRegistry(models: Record<string, Model<Api>>): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models[`${provider}/${modelId}`] ?? null;
    },
  } as ModelRegistry;
}

describe("agents/model-forward-compat", () => {
  it("resolves anthropic opus 4.6 via 4.5 template", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-opus-4-6", registry);
    expect(model?.id).toBe("claude-opus-4-6");
    expect(model?.name).toBe("claude-opus-4-6");
    expect(model?.provider).toBe("anthropic");
  });

  it("resolves anthropic sonnet 4.6 dot variant with suffix", () => {
    const registry = createRegistry({
      "anthropic/claude-sonnet-4.5-20260219": createTemplateModel(
        "anthropic",
        "claude-sonnet-4.5-20260219",
      ),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-sonnet-4.6-20260219", registry);
    expect(model?.id).toBe("claude-sonnet-4.6-20260219");
    expect(model?.name).toBe("claude-sonnet-4.6-20260219");
    expect(model?.provider).toBe("anthropic");
  });

  it("resolves an unknown openai-codex id by cloning the newest bundled codex template", () => {
    const registry = createRegistry({
      "openai-codex/gpt-5.3-codex": {
        ...createTemplateModel("openai-codex", "gpt-5.3-codex"),
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<Api>,
    });
    const model = resolveForwardCompatModel("openai-codex", "gpt-5.4-mini", registry);
    expect(model?.id).toBe("gpt-5.4-mini");
    expect(model?.provider).toBe("openai-codex");
    expect(model?.api).toBe("openai-codex-responses");
    expect(model?.baseUrl).toBe("https://chatgpt.com/backend-api");
  });

  it("synthesizes an openai-codex model when no codex template is bundled", () => {
    const model = resolveForwardCompatModel("openai-codex", "gpt-6-astra", createRegistry({}));
    expect(model?.id).toBe("gpt-6-astra");
    expect(model?.api).toBe("openai-codex-responses");
    expect(model?.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(model?.reasoning).toBe(true);
  });

  it("does not resolve unknown ids for providers other than openai-codex", () => {
    expect(resolveForwardCompatModel("openai", "gpt-5.4-mini", createRegistry({}))).toBeUndefined();
    expect(resolveForwardCompatModel("openai-codex", "   ", createRegistry({}))).toBeUndefined();
  });

  it("does not resolve anthropic 4.6 fallback for other providers", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("openai", "claude-opus-4-6", registry);
    expect(model).toBeUndefined();
  });
});

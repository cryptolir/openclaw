import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Codex impl round 3 (P1): resolveEnvApiKeyVarName returns the env var NAME
// (stored in models.json for runtime resolution) — discovery must receive the
// real secret for its Authorization header, never the literal var name.

const discoverMock = vi.fn(async (_apiKey?: string) => ({
  models: [],
  source: "api" as const,
}));

vi.mock("./venice-models.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./venice-models.js")>();
  return { ...original, discoverVeniceModels: discoverMock };
});

const { resolveImplicitProviders } = await import("./models-config.providers.js");

const ORIGINAL_VENICE_KEY = process.env.VENICE_API_KEY;

describe("resolveImplicitProviders venice key handling", () => {
  afterEach(() => {
    if (ORIGINAL_VENICE_KEY === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = ORIGINAL_VENICE_KEY;
    }
    vi.clearAllMocks();
  });

  it("passes the real env secret to discovery but stores the var name as apiKey", async () => {
    process.env.VENICE_API_KEY = "vk-real-secret";
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-key-test-"));
    try {
      const { providers, veniceSource } = await resolveImplicitProviders({ agentDir });
      expect(discoverMock).toHaveBeenCalledWith("vk-real-secret");
      expect(providers?.venice?.apiKey).toBe("VENICE_API_KEY");
      expect(veniceSource).toBe("api");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

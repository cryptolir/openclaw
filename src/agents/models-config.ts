import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitBedrockProvider,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";
import {
  reconcileVeniceModels,
  refreshVeniceCosts,
  type VeniceDiscoverySource,
} from "./venice-models.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";

function mergeProviderModels(implicit: ProviderConfig, explicit: ProviderConfig): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  if (implicitModels.length === 0) {
    return { ...implicit, ...explicit };
  }

  const getId = (model: unknown): string => {
    if (!model || typeof model !== "object") {
      return "";
    }
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  };
  const seen = new Set(explicitModels.map(getId).filter(Boolean));

  const mergedModels = [
    ...explicitModels,
    ...implicitModels.filter((model) => {
      const id = getId(model);
      if (!id) {
        return false;
      }
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    }),
  ];

  return {
    ...implicit,
    ...explicit,
    models: mergedModels,
  };
}

export function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
  veniceSource?: VeniceDiscoverySource;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit ? { ...params.implicit } : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = key.trim();
    if (!providerKey) {
      continue;
    }
    const implicit = out[providerKey];
    let merged = implicit ? mergeProviderModels(implicit, explicit) : explicit;
    // Venice cost-aware merge (docs/plans/venice-per-token-pricing.md §Design 3):
    // a successful API discovery is authoritative for the cost of every id it
    // returned, so explicit entries (e.g. the zero-cost onboard catalog) get
    // their cost refreshed. Fallback discoveries never overwrite costs.
    if (providerKey === "venice" && implicit && params.veniceSource === "api") {
      const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
      const mergedModels = Array.isArray(merged.models) ? merged.models : [];
      if (implicitModels.length > 0 && mergedModels.length > 0) {
        merged = { ...merged, models: refreshVeniceCosts(mergedModels, implicitModels) };
      }
    }
    out[providerKey] = merged;
  }
  return out;
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();

  const explicitProviders = cfg.models?.providers ?? {};
  const { providers: implicitProviders, veniceSource } = await resolveImplicitProviders({
    agentDir,
    explicitProviders,
  });
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
    veniceSource,
  });
  const implicitBedrock = await resolveImplicitBedrockProvider({ agentDir, config: cfg });
  if (implicitBedrock) {
    const existing = providers["amazon-bedrock"];
    providers["amazon-bedrock"] = existing
      ? mergeProviderModels(implicitBedrock, existing)
      : implicitBedrock;
  }
  const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
  if (implicitCopilot && !providers["github-copilot"]) {
    providers["github-copilot"] = implicitCopilot;
  }

  if (Object.keys(providers).length === 0) {
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const targetPath = path.join(agentDir, "models.json");

  let mergedProviders = providers;
  let existingRaw = "";
  if (mode === "merge") {
    const existing = await readJson(targetPath);
    if (isRecord(existing) && isRecord(existing.providers)) {
      const existingProviders = existing.providers as Record<
        string,
        NonNullable<ModelsConfig["providers"]>[string]
      >;

      // Reconcile the Venice model list per docs/plans/venice-per-token-pricing.md
      // §Design 3 (Rev 5 + impl notes): authority is id-based — only ids the raw
      // API discovery returned carry API cost authority; every other id keeps
      // its cached cost when one exists, and cached-only ids are appended. The
      // NEW provider object always wins (apiKey/baseUrl/compat stay fresh);
      // only the model list is reconciled.
      const existingVenice = existingProviders.venice;
      const newVenice = providers.venice;
      if (existingVenice && newVenice) {
        const cachedModels = Array.isArray(existingVenice.models) ? existingVenice.models : [];
        const newModels = Array.isArray(newVenice.models) ? newVenice.models : [];
        const implicitVenice = implicitProviders?.venice;
        const apiModels =
          veniceSource === "api" && Array.isArray(implicitVenice?.models)
            ? implicitVenice.models
            : [];
        if (cachedModels.length > 0 && newModels.length > 0) {
          const reconciled = reconcileVeniceModels({ cachedModels, newModels, apiModels });
          if (reconciled.restoredCostCount > 0 || reconciled.preservedIdCount > 0) {
            console.warn(
              `[venice-models] Reconciled with cache: restored ${reconciled.restoredCostCount} cached cost(s), preserved ${reconciled.preservedIdCount} cached-only model(s)`,
            );
          }
          providers.venice = { ...newVenice, models: reconciled.models };
        }
      }

      mergedProviders = { ...existingProviders, ...providers };
    }
  }

  const normalizedProviders = normalizeProviders({
    providers: mergedProviders,
    agentDir,
  });
  const next = `${JSON.stringify({ providers: normalizedProviders }, null, 2)}\n`;
  try {
    existingRaw = await fs.readFile(targetPath, "utf8");
  } catch {
    existingRaw = "";
  }

  if (existingRaw === next) {
    return { agentDir, wrote: false };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, next, { mode: 0o600 });
  return { agentDir, wrote: true };
}

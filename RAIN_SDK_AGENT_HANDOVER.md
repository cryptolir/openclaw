# Rain SDK Agent Integration Handover

## Purpose

This branch captures a proposed OpenClaw integration plan for Rain SDK agent capabilities. It is intended for Claude to review before implementation starts.

## Repo And Branch

- Repo: `openclaw`
- DevAgents path: `/root/projects/openclaw`
- Branch: `codex/docs-rain-sdk-agent-plan`
- Owner: Codex
- Status: planning, no runtime code changes yet

## Source Links

- Rain Builders: https://rain.one/docs/For-Developers/Rain-Builders
- Rain agent skills: https://rain.one/docs/For-Developers/Rain-for-Ai-Agents/Agent-Skills
- Rain SDK account abstraction: https://rain.one/docs/For-Developers/Rain-SDK/Account-Abstraction
- Rain docs index: https://rain.one/docs/llms.txt

## Proposed Direction

Use two layers:

1. Rain OpenClaw skills for developer-time context and code generation.
2. A Rain MCP server for runtime agent tools that expose market data, transaction construction, and guarded wallet execution.

The public Rain docs list these OpenClaw skill installs:

```bash
npx skills add rain1-labs/rain-sdk@rain-create-market
npx skills add rain1-labs/rain-sdk@rain-trade
npx skills add rain1-labs/rain-sdk@rain-data
```

Those skills should help agents write or understand Rain SDK flows. They should not be treated as the runtime security boundary for real wallet actions.

## Proposed Runtime Components

### Rain MCP Server

Create either `@openclaw/mcp-rain` or an extension package under `extensions/rain-mcp`.

Initial read-only tools:

- `rain_get_public_markets`
- `rain_get_market`
- `rain_get_positions`
- `rain_get_price_quote`
- `rain_get_trade_history`
- `rain_subscribe_market_events`

Transaction builder tools:

- `rain_build_buy_option_tx`
- `rain_build_sell_option_tx`
- `rain_build_create_market_tx`
- `rain_build_add_liquidity_tx`
- `rain_build_close_market_tx`
- `rain_build_resolve_market_tx`
- `rain_build_claim_tx`

Execution tools, gated behind wallet policy:

- `rain_prepare_execution`
- `rain_simulate_tx`
- `rain_request_wallet_approval`
- `rain_send_with_wallet`
- `rain_send_with_rain_aa`

### Wallet Capability Modes

Add wallet capability modes to agent config or MCP server config:

- `none`: read-only market/data agent.
- `build-only`: can build unsigned Rain transactions but cannot sign or send.
- `approval-required`: can propose transactions and request owner approval before signing.
- `limited-auto`: can execute only within strict configured limits.
- `aa-sponsored`: can execute through Rain account abstraction with paymaster policy.

### Policy Schema

Executable wallet tools should require a policy object similar to:

```json
{
  "chain": "arbitrum",
  "environment": "production",
  "maxTxUsd": 25,
  "dailySpendUsd": 100,
  "allowedActions": ["buy", "sell", "claim"],
  "blockedActions": ["resolve", "closeMarket"],
  "allowedMarketIds": [],
  "requiresHumanApproval": true
}
```

Secrets such as wallet keys, RPC keys, Alchemy keys, and paymaster policy IDs must be owner-only agent secrets. They must not be returned to member users, prompts, logs, or frontend responses.

## Agent Templates To Consider

- Rain Analyst: read-only market discovery, quote, position, and history tools.
- Rain Trader: quote, position, buy/sell transaction proposals, optional approved execution.
- Rain Market Creator: drafts market specs and builds create-market transactions.
- Rain Liquidity Manager: builds and proposes liquidity actions under treasury policy.
- Rain Resolver: watches markets and proposes close/resolve actions with approval.
- Rain Entropy Agent: explores Rain Entropy Layer workflows if docs/API support the requested use case.

## Validation Against AgentGlob Dashboard And OpenClaw

This plan was checked against the current AgentGlob dashboard repo (`/root/projects/openclaw-dashboard`) and OpenClaw gateway repo (`/root/projects/openclaw`). The main fit is good, but the implementation should follow the dashboard's existing primitives instead of adding a parallel agent-creation path.

### Confirmed Fit

- AgentGlob already has a unified Tools tab for Secrets, MCP servers, and Skills in `app/dashboard/[workspaceSlug]/agents/[agentId]/page.tsx`.
- New-agent deploy already supports `selectedSkills` and copies selected system skills into `/root/.openclaw/agents/{agent}/workspace/skills` via `app/api/agents/deploy/route.ts`.
- Per-agent skill management already exists in `app/api/agents/[agentId]/skills/route.ts` and regenerates the agent capabilities manifest after changes.
- Per-agent MCP management already exists in `app/api/agents/[agentId]/mcps/route.ts`, stores MCP servers under `plugins.entries["mcp-bridge"].config.servers`, restarts the container, and regenerates capabilities.
- New deployments already install/copy the `mcp-bridge` plugin before writing `openclaw.json`, so Rain MCP should integrate through that bridge rather than a new gateway-side MCP runtime.
- Secrets are already merged into per-agent `docker.env` by `buildDockerEnv()` in `lib/agent-server.ts`; workspace secrets flow into deploy through `listWorkspaceSecrets()` in the deploy route.
- Dashboard permission checks already gate secret, skill, deploy, and MCP writes through `resolveAgentAccess()` / `hasWorkspaceCapability()` in `lib/permissions.ts`.

### Required Adjustments

- Treat Rain v1 as an AgentGlob dashboard feature composed of existing pieces: system skills, an MCP preset, per-agent secrets, and optional capability metadata. Do not start with a new first-class runtime subsystem.
- Add Rain to the dashboard MCP preset flow first. The existing MCP API blocks `docker` commands, so the Rain MCP server must run as a binary or Node command available inside the agent container, preferably via the canonical `mcp-bridge` extension path.
- Do not store wallet private keys, seed phrases, or high-risk signing credentials in MCP arguments. The MCP route already rejects some token-looking args, but Rain needs a stricter allowlist and validation for wallet-related env names.
- Be careful with MCP `env`: the current dashboard POST stores `env` under `openclaw.json` for MCP servers. For wallet-capable Rain tools, secrets should be stored in per-agent `docker.env` through the Secrets flow, and the Rain MCP config should reference only required env keys or non-secret policy values.
- Add Rain-specific secrets to the dashboard as skill/API keys, not core deploy-time keys unless they become platform-wide defaults. Likely names: `RAIN_RPC_URL`, `RAIN_ALCHEMY_API_KEY`, `RAIN_PAYMASTER_POLICY_ID`, and a deliberately reviewed signing credential if any custody model is approved.
- Add a Rain MCP preset beside GitHub, Filesystem, and Brave Search in the Tools tab once the MCP server install path is known.
- Add Rain skills to the system skill library (`/opt/openclaw/skills` on Agent servers) or install them through the existing global skills API so the new-agent wizard can select them. Marking them as core skills is already supported through `app/api/core-skills/route.ts`.
- Add policy and wallet capability controls as dashboard-managed agent config metadata before enabling send tools. The current generic MCP flow can add any server for owners, but it does not understand spend limits, allowed actions, market allowlists, or approval requirements.
- Use existing audit logging as the minimum baseline (`mcp.add`, `mcp.delete`, `skill.install`, `secrets.update`), but Rain execution needs transaction-level audit events such as `rain.tx.proposed`, `rain.tx.approved`, `rain.tx.sent`, and `rain.tx.denied`.
- Existing WorkspaceRole is currently `owner | admin`; any member-role distinction from the original plan should be mapped to AgentGlob's current workspace and platform role model before implementation.

### Recommended AgentGlob V1 Scope

For the first implementation, ship Rain Analyst and Rain Trader in `build-only` or `approval-required` mode only. That matches the current AgentGlob MCP/Secrets/Skills architecture while avoiding autonomous wallet execution before policy UI, custody review, and transaction audit logs exist.

## Suggested Implementation Order

1. Install and test the official Rain OpenClaw skills on DevAgents.
2. Verify the current `@buidlrrr/rain-sdk` package API and supported networks directly from source/docs.
3. Scaffold a read-only Rain MCP server with typed tool schemas and no wallet access.
4. Add transaction builder tools that return unsigned transaction payloads only.
5. Add wallet policy schema, approval flow, and audit logging before any send tool.
6. Add RainAA execution support with explicit `ALCHEMY_API_KEY`, paymaster policy, chain, and spending limits.
7. Add dashboard templates so users can create Rain agents with the correct capability mode.
8. Add tests for tool schemas, policy denials, unsigned transaction building, and approval-required execution.
9. Run read-only production smoke tests first; enable execution only after audit and limits are verified.

## Open Questions For Claude Review

- Should the first implementation live as a core MCP server package, an extension package, or dashboard-managed MCP preset?
- Which wallet custody model is acceptable for production: external wallet approval, server-held encrypted key, or RainAA smart account only?
- Should `limited-auto` be allowed at launch, or should v1 require human approval for every transaction?
- Which dashboard surfaces need wallet policy controls: agent creation, agent settings, public chat, or owner-only control channel?
- What exact Rain networks and environments should be enabled for the first smoke tests?

## Review Goal

Claude should validate this plan against current OpenClaw runtime, dashboard config generation, MCP conventions, RBAC/secret handling, and deployment constraints before any implementation branch starts.

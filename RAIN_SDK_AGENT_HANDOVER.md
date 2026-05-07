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

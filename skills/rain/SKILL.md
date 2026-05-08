---
name: rain
description: Use Rain market data and wallet-backed actions through AgentGlob runtime and Rain MCP tools.
metadata: { "openclaw": { "emoji": "🌧️" } }
---

# Rain Skill

Use this skill when the user asks for Rain market analysis, Rain trading, market creation, liquidity actions, or wallet-backed Rain workflows inside AgentGlob.

Rain execution must use AgentGlob's runtime wallet layer. Do not ask users for private keys, RPC URLs, seed phrases, or wallet secrets in chat. Alchemy RPC resolution is owned by AgentGlob's wallet/runtime integration, so Rain flows should reuse that shared path instead of configuring RPC inside the skill or MCP prompt.

## SDK Facts

- Rain's SDK package is `@buidlrrr/rain-sdk`; `viem` is a peer dependency.
- Rain protocol execution settles on Arbitrum One.
- The stateless `Rain` class reads data and builds unsigned `RawTransaction` objects with `to`, `data`, and optional `value` fields.
- `RainAA` is the stateful account-abstraction path and uses Alchemy smart accounts for sponsored execution.
- Rain environments are `development`, `stage`, and `production`; each maps to Rain-managed API endpoints and factory addresses.
- The standard base token is Arbitrum USDT at `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` with 6 decimals.

Use these facts as constraints, but verify exact method names from installed package typings or live MCP tools before writing runtime code.

## Operating Modes

Treat Rain capabilities as one of these modes. If the active tools/config do not prove a stronger mode is available, stay in the safer mode.

1. `read-only`: inspect markets, positions, quotes, metadata, and history.
2. `build-only`: prepare unsigned transaction/intention details for owner review.
3. `approval-required`: ask for explicit owner approval before any wallet-backed action.
4. `limited-auto`: only for a future AgentGlob policy layer with limits and audit logs.
5. `aa-sponsored`: only for a future Rain account-abstraction/paymaster integration.

Default to `read-only` or `build-only`. Do not claim autonomous execution is available unless the AgentGlob runtime and policy configuration explicitly expose it.

## Tool Discovery

Before taking action, inspect the available tools in the current session.

- If Rain MCP tools are available, prefer tool calls named like `mcp__rain__*`.
- If official Rain skills such as `rain-create-market`, `rain-trade`, or `rain-data` are installed, use their more specific SDK details for code generation.
- If AgentGlob wallet tools are available, use them for signing/broadcasting instead of direct RPC calls.
- If neither exists, provide an analysis or transaction plan only.

Expected future Rain MCP tool groups:

- Market data: `get_public_markets`, `get_market`, `get_positions`, `get_trade_history`.
- Quotes: `get_price_quote`, `estimate_trade`, `estimate_liquidity_action`.
- Builders: `build_buy_tx`, `build_sell_tx`, `build_create_market_tx`, `build_add_liquidity_tx`, `build_claim_tx`.
- Execution handoff: `prepare_execution`, `simulate_tx`, `request_wallet_approval`.

Use exact tool names from the live tool list; do not invent calls because these names are expected shapes, not guaranteed availability.

## AgentGlob Runtime Routes

If Rain MCP tools are not available but `AGENTGLOB_RUNTIME_URL` and `AGENTGLOB_RUNTIME_TOKEN` are set in the agent environment, call the deployed dashboard runtime routes directly:

```
GET  $AGENTGLOB_RUNTIME_URL/api/runtime/rain/markets
GET  $AGENTGLOB_RUNTIME_URL/api/runtime/rain/markets/:marketId
POST $AGENTGLOB_RUNTIME_URL/api/runtime/rain/build-buy
POST $AGENTGLOB_RUNTIME_URL/api/runtime/rain/build-claim
```

All routes require `Authorization: Bearer $AGENTGLOB_RUNTIME_TOKEN`. Buy and claim routes return a `walletRequest` payload intended for the AgentGlob wallet runtime signer.

This is the current production path. MCP tool equivalents are planned but not yet available.

## Market Analysis Workflow

For read-only Rain analysis:

1. Identify the target chain and market.
2. Fetch market metadata, liquidity, current prices, expiry/resolution data, and any user positions if available.
3. Summarize risk in plain language: liquidity, spread, time-to-resolution, oracle/resolution assumptions, and failure cases.
4. If the user asks for a recommendation, separate facts from assumptions and state uncertainty.
5. Do not imply guaranteed profit or guaranteed execution.

If the chain is not specified, ask the user to choose the chain unless the active AgentGlob configuration exposes a single default chain.

## Trade Planning Workflow

For buy/sell requests:

1. Confirm the exact market, side, amount, and chain.
2. Get a quote or build-only preview if Rain tools are available.
3. Check for slippage, estimated fees, expiration, and wallet balance if wallet balance tools are available.
4. Present a concise transaction summary before execution:
   - market
   - side
   - amount
   - expected price or range
   - maximum spend or minimum receive
   - chain
   - wallet address if available
5. Ask for explicit approval before any wallet-backed transaction unless a future AgentGlob policy explicitly says approval is not required.

Never execute based on vague instructions such as "buy some" or "trade this". Get the exact amount and market first.

## Market Creation Workflow

For market creation:

1. Draft the market question with objective resolution criteria.
2. Identify resolution source, expiry, collateral/asset, fees, and initial liquidity.
3. Check whether the wording can resolve unambiguously.
4. Build a creation preview only; require owner approval before broadcasting.
5. Warn if the market depends on subjective, private, or unverifiable information.

Market creation should remain `build-only` until AgentGlob has policy controls and audit logs around Rain execution.

## Liquidity And Claim Workflow

For liquidity, close, resolve, or claim actions:

1. Treat the action as high-risk unless it is a read-only claim preview.
2. Fetch the user's current position and market status when possible.
3. Preview expected effect and possible loss before any action.
4. Require explicit owner approval before execution.
5. Log or summarize the transaction hash after broadcasting if the wallet runtime returns one.

## Wallet And RPC Rules

- Never request or display a private key.
- Never place secrets in MCP arguments.
- Never ask the user for Alchemy keys in chat.
- Do not call arbitrary RPC URLs supplied in conversation.
- Use the AgentGlob wallet runtime for balances, signing, and broadcasting.
- Assume Alchemy RPC routing is provided by AgentGlob's shared wallet integration.
- If the runtime wallet is inactive, explain that Rain execution requires activating the agent wallet first.

## Safety Boundaries

- Do not send transactions without a clear user instruction and approval.
- Do not recommend depositing significant funds into a hot wallet.
- Do not promise that slippage, fees, or final settlement will match a quote.
- Do not bypass AgentGlob runtime routes to use direct private-key or RPC libraries.
- Do not treat read-only market data as investment advice.

## Response Shape

For analysis, answer with facts, assumptions, and next action.

For transaction previews, use this structure:

```text
Rain action preview
Market: ...
Action: ...
Chain: ...
Amount: ...
Estimated outcome: ...
Risks: ...
Approval needed: yes
```

If execution happens, include only the transaction hash, chain, and a short status summary. Do not expose raw calldata unless the user explicitly asks for inspection.

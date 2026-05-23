# Plan — Rain skill rewrite + create-market split

> Status: **proposal, awaiting review** (no code changes yet)
> Author: Claude (handover-paired)
> Reviewer: Codex
> Target branch when implemented: `feat/rain-skill-split`

---

## 1. Background

The `rain` MCP server (`src/mcp/rain/`) currently exposes **22 tools** (see `RAIN_TOOLS` in `src/mcp/rain/tools.ts`). The companion skill at `skills/rain/SKILL.md` documents **9** of them. The other 13 are callable, return correct results, and have inline tool descriptions, but no flow guidance in the SKILL.

Concretely, the SKILL covers: `list_markets`, `get_market`, `build_buy`, `build_sell`, `build_claim`, `build_add_liquidity`, `build_create_market`, `get_price_history`, `get_capabilities`.

It does NOT cover:

| Group         | Tools                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Portfolio     | `rain_get_positions`, `rain_get_position_by_market`, `rain_get_lp_position`, `rain_get_portfolio_value`, `rain_get_pnl` |
| Trade history | `rain_get_trade_history`, `rain_get_transactions`, `rain_get_market_transactions`, `rain_get_transaction_details`       |
| Utility       | `rain_get_market_address`, `rain_resolve_market_id`                                                                     |
| Diagnostics   | `rain_get_config`, `rain_get_health`                                                                                    |

Separately, `rain_build_create_market` is bundled into the trading skill, but its risk profile (irreversible, gas-spending, deploys a new contract) and target persona (market creator, not trader) differ enough to justify a separate, opt-in skill.

## 2. Goals

1. **Expand** `skills/rain/SKILL.md` so it documents every read-only and trading tool the MCP exposes.
2. **Extract** create-market into a new opt-in skill `skills/rain-create/SKILL.md`.

Result: every deployed Rain MCP tool is covered by exactly one skill; no tool appears in two skills.

## 3. Non-goals

- No changes to the MCP server (`src/mcp/rain/**`). The tool surface is correct; only the prompt-level guidance changes.
- No dashboard UI changes (e.g. a "Skills tab"). That is a separate product decision.
- No changes to `rain_get_capabilities` — it remains the runtime source of truth.
- No new tests. SKILL.md content is markdown.
- No changes to wallet skill, runtime client, or HTTP routes.

## 4. Scope — Part 1: Expand `skills/rain/SKILL.md`

### 4.1 Add a "Portfolio & analytics" section (read-only)

When to call:

- User asks "what do I own", "what's my position in market X", "how am I doing"
- Use `rain_get_positions` for a wallet's full position list, `rain_get_position_by_market` or `rain_get_lp_position` for one market.
- Use `rain_get_portfolio_value` when the user wants a dollar-value total across markets + tracked tokens.
- Use `rain_get_pnl` for realised + unrealised PnL.

Surfacing rules:

- Convert wei → human units using the relevant market's `baseTokenDecimals`. Never display raw wei to the user.
- Show market title (`details.title` from `rain_get_market`) rather than contract address.
- Read-only — no signing, no preview, no confirmation required.

`rain_get_pnl` quirk:

- `marketAddress` (on-chain) — NOT `marketId`. Use `rain_get_market_address` to convert if the user gave you a marketId.

### 4.2 Add a "Trade history & transactions" section

When to call:

- User asks for a trade log, audit trail, or to look up a specific tx.
- `rain_get_trade_history` for one wallet + one market (both required, both as addresses).
- `rain_get_transactions` for one wallet across all markets (paginated).
- `rain_get_market_transactions` for one market's full activity (no wallet filter).
- `rain_get_transaction_details` for one tx hash — block number, status, gas, events.

Address-vs-id rule (call it out explicitly):

- `rain_list_markets`, `rain_get_market`, `rain_build_claim`, `rain_get_price_history` take **marketId**.
- `rain_get_trade_history`, `rain_get_market_transactions`, `rain_get_pnl` take **marketAddress**.
- `rain_get_market_address` and `rain_resolve_market_id` convert between them.

### 4.3 Add a one-paragraph "Utility & diagnostics" section

- `rain_get_market_address` / `rain_resolve_market_id` — id↔address conversion; usually called silently as a setup step for another tool. Don't surface results to the user.
- `rain_get_config` — chain + env + secret presence. Useful when the user asks "which environment is this connected to?"
- `rain_get_health` — composite RPC + subgraph reachability check. Surface only if the user asks about Rain availability or if another tool returned a 5xx and you want to diagnose.

### 4.4 Remove the existing "Create-market flow" section

Replace it with a one-line pointer: _"Market creation is documented in the separate `rain-create` skill. Enable that skill if the agent should be able to deploy new markets."_

Keep `rain_build_create_market` listed in the "What the Rain MCP gives you" tool list with a `→ rain-create skill` annotation, so an agent that does not have rain-create enabled still knows the tool exists but should not call it without the flow guidance.

### 4.5 Update the header and version

- Title becomes `# Rain skill` (drop the "V2 Phase B" since we're past that classification).
- `description` in frontmatter updated to mention portfolio/analytics coverage.

## 5. Scope — Part 2: Create `skills/rain-create/SKILL.md`

New file. Opt-in, separate persona.

### 5.1 Frontmatter

```yaml
---
name: rain-create
description: Prompt-level guidance for creating new Rain prediction markets. Opt-in skill — high-stakes, irreversible, gas-spending. Pair with the `rain` skill (required for reading market state).
metadata:
  openclaw:
    emoji: 🆕
    requires:
      env: [AGENTGLOB_RUNTIME_URL, AGENTGLOB_RUNTIME_TOKEN]
      skills: [rain]
---
```

Note: `requires.skills` is a **proposed** convention — flag to reviewer (see §7).

### 5.2 Body

- Two-sentence preamble: "this skill enables the agent to deploy new Rain markets. Market creation is irreversible from the agent's side and locks the creator's seed liquidity until resolution."
- Move the existing `## Create-market flow` section from `skills/rain/SKILL.md` verbatim.
- Add **"When NOT to use"** subsection:
  - User has not named a clear, verifiable resolution data source
  - Wallet lacks sufficient base token for `inputAmountWei` + gas
  - User is hesitant or asking exploratory questions ("can I create one?") — answer questions first, then offer to walk them through creation
  - User asks for "test" or "throwaway" markets — explain that on-chain creation is real and costs gas
- Add **"After creation"** subsection: surface the new contract address from the final tx receipt logs, then suggest follow-ups (`rain_get_market` to verify, `rain_build_add_liquidity` to deepen the pool).

## 6. Files touched

| File                          | Change                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `skills/rain/SKILL.md`        | Add three sections (4.1, 4.2, 4.3), remove create-market section, header tweaks |
| `skills/rain-create/SKILL.md` | New file                                                                        |
| `STATUS.md`                   | Add branch ownership entry when implementation starts                           |

No code, no tests, no config.

## 7. Open questions for reviewer

1. **`requires.skills` convention** — does the dashboard's skill loader honour skill-to-skill dependencies, or only `requires.env`? If the dependency is not enforced, the `rain-create` skill needs a runtime check ("if rain MCP is not in the tool list, tell user to enable it first") instead.
2. **Should `rain_build_create_market` be moved out of the `rain` MCP server** into a separate `rain-create` MCP server? Current plan keeps it in the existing server (simpler, no migration). The downside is that the tool is callable even when only the `rain` skill is enabled. The skill text mitigates this ("see rain-create skill") but does not prevent it.
3. **Diagnostics surfacing** — should `rain_get_health` be called proactively before any build\_\* call, as a pre-flight? Or stay reactive (only when something fails)? Current plan: reactive. Confirm.
4. **Phase tag** — `RAIN_CAPABILITY_PHASE` in `tools.ts` says `"V2 Phase B"`. Should this bump when the skills split lands? My read: no — the tool surface didn't change, only the prompt guidance. Confirm.

## 8. Acceptance criteria

- [ ] Every tool name in `RAIN_TOOLS` (from `src/mcp/rain/tools.ts`) appears in exactly one of `skills/rain/SKILL.md` or `skills/rain-create/SKILL.md`.
- [ ] `skills/rain/SKILL.md` and `skills/rain-create/SKILL.md` both have valid frontmatter.
- [ ] No code changes outside `skills/` and `docs/`.
- [ ] No regressions in `rain_get_capabilities` output (still lists all 22 tools).
- [ ] PR description includes a diff of "tool → skill" mapping so reviewers can see coverage at a glance.

## 9. Implementation order (when approved)

1. Add `skills/rain-create/SKILL.md` (greenfield — easier to review independently).
2. Remove create-market section from `skills/rain/SKILL.md`, add pointer.
3. Add portfolio + analytics + utility sections to `skills/rain/SKILL.md`.
4. Update frontmatter + header.
5. Update `STATUS.md`.
6. Open PR titled `docs(skills/rain): expand coverage + split create-market`.

## 10. Out of scope / follow-ups

- Skills marketplace UI in the dashboard
- Skill-to-skill dependency enforcement (the `requires.skills` field if not yet supported)
- Splitting `rain_build_create_market` into its own MCP server
- Adding price-quote / slippage tools (still on the Phase B roadmap, but separate ticket)

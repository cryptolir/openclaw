# OpenClaw — Roadmap

> Full development roadmap, organized by area.
> STATUS.md tracks only the current top priority.

---

## AgentGlob (Website)

- **Take control of the AgentGlob repo** — gain ownership/admin access to the repo and deploy pipeline
- **Agent promos on home page** — add links and promotional sections for selected agents on the AgentGlob home page

## Dashboard (WebApp)

- **Clean signup/signin flow with email verification** — proper auth flow replacing current minimal setup
- **Subscription plan selection & enforcement** — users pick a plan, system enforces limits
- **Billing UI / reporting** — usage-based billing pages on top of stored monthly usage (reporting pages already scaffolded)
- **Moltbook integration** — integrate Moltbook into the dashboard

## Wallet & Payments

- **Per-agent EVM hot wallet (v1)** — owner pastes a private key on the agent Wallet tab; AES-256-GCM encrypted at rest; default Alchemy RPC for Ethereum/Arbitrum/Polygon/Base; agents send tx without policy gates. Tracked in `openclaw-dashboard:HOT_WALLET_INTEGRATION.md` (PR #65). **Active.**
- **AxonFi non-custodial vault custody (v2)** — Cloud KMS-backed bot keys, EIP-712 intents through AxonFi relayer, dashboard-managed policy (per-tx caps, recipient allowlists, protocol allowlists, approval queue). Tracked in `openclaw-dashboard:AXONFI_VAULT_INTEGRATION.md` on branch `claude/docs-axonfi-vault-plan` (PR #64, deferred). Migration path: per-agent toggle once hot-wallet risk envelope is outgrown.
- **Solana support** — separate ed25519 keypair on the wallet record, separate SDK + runtime routes. Out of v1 scope.

## Agent Tech (Containers & Dev)

- **Group behavior policies** — configurable per-group behavior rules for agents
- **Moltbook integration** — integrate Moltbook into agent containers
- **GEMA (Google open-source model) deploy option** — add GEMA as a selectable model for agent deployments
- **Agent memory system (QMD / Obsidian)** — persistent structured memory for agents, markdown-based vault style (ref: mempalace)
- **Agent landing page** — each agent gets a hosted page (HTML, member DB, embedded chat, payments)

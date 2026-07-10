# Venice per-token pricing: make the usage/billing report see Venice spend

**Status:** Rev 5 (final) — folds Codex round 4; owner-approved to implementation
**Repo:** `cryptolir/openclaw` (gateway). No dashboard code changes in this plan.

### Rev 5: Codex round 4 + owner decision (2026-07-10)

Round 4 hit the protocol's 4-round escalation bound. Owner decision: **fold as
final rev and move to implementation** (impl PR gets its own adversarial
review). Both round-4 P2s folded:

- **Fallback must not clobber cached prices.** The static-catalog fallback
  returns zero-cost models indistinguishable from a successful discovery, so
  the Rev 4 unconditional-overwrite rule could zero out good cached prices
  whenever the API is down. Fix: discovery results now carry a **source
  marker** (`api` vs `fallback`). The §Design 3 cost-overwrite applies **only
  to `source: "api"`** results; fallback results never replace existing costs —
  they only fill ids that have no entry yet. New named test.
- **Impl checklist scope.** Sequencing step 2 now lists
  `src/agents/models-config.ts` + the merge tests explicitly, alongside
  `venice-models.ts`.

### Rev 4: Codex round 3 (2026-07-10)

Two P2 findings, both folded:

- **Discovered cost must win even when zero** — the Rev 2 cost-aware-merge rule
  ("take implicit only if explicit is all-zero AND implicit nonzero") let a
  stale **nonzero** cached price survive a fail-closed discovered zero. Rewrote
  §Design 3 to the simpler correct principle: the latest successful discovery is
  authoritative for the `cost` of every id it returns, replacing older
  cost unconditionally (zero included).
- **Context-tiered pricing** — Venice publishes higher `>256K` context tiers for
  some model ids; a single flat `cost` under-reports large-context turns. Sized
  it: **no current fleet primary is tiered** — only `qwen-3-6-plus` (unused)
  carries an `extended` tier. Folded as base-tier pricing + a warn that flags
  any model exposing a tier structure; accurate per-request tiered costing is
  deferred (pi-ai `calculateCost` is flat) — see §Design 4 and NOT-building.

### Rev 3: Codex round 2 (2026-07-10)

Round 2 raised **no** correctness/trust-boundary findings — the Rev 2 pricing
design (cost-aware merge, fail-closed cache) stands. Two doc-hygiene folds:

- **P2 — redact live identifiers.** `docs/` is public repo content (`AGENTS.md`:
  no live config values). Replaced the workspace id, gateway/agent names, and
  customer name with role-based descriptions throughout. (The evidence numbers
  are kept; only identifiers are scrubbed. Rev 1–2 history still contains the
  id — an opaque Firestore id, not a credential — so no history rewrite.)
- **P3 — em-dash headings** break Mintlify anchors (`AGENTS.md` Docs Linking).
  All headings now use colons.

### Rev 2: Codex round 1 (2026-07-10)

Three findings, all valid, all folded:

- **P1 (design-changing) — explicit-config Venice path missed.** My "exactly two
  places" was wrong. `applyVeniceProviderConfig`
  (`src/commands/onboard-auth.config-core.ts:295`) writes the zero-cost static
  catalog into **explicit** config, and `mergeProviderModels`
  (`src/agents/models-config.ts`) puts explicit models first and **drops**
  same-id implicit models — so a Venice-onboarded agent keeps the zero-cost
  entry even after discovery learns the price. Threading discovery alone would
  leave much of the fleet at $0. Fix: a **cost-aware merge** (§Design 3) so a
  priced discovered model overrides a zero-cost same-id entry.
- **P2 (cacheRead fallback) — violated my own fail-closed invariant.** Changed
  `cacheRead: cache_input ?? input` → `?? 0` + warn. No guessed cache price.
- **P2 (stale cache) — was "accepted risk", now fixed.** Same cost-aware merge
  resolves it: the merge no longer lets a larger zero-cost cache shadow priced
  discovery for overlapping ids. Moved out of Risks.

P1 and the stale-cache P2 collapse to **one** mechanism (cost-aware merge) —
see §Design 3.

## Problem (verified live, 2026-07-10)

Every Venice model is defined with `cost: 0`, so the gateway prices all Venice
inference at $0.00. Verified against a live Venice-primary gateway (the flagship
consumer-app agent) via its `usage.report` RPC, 7-day window:

| model                    | tokens    | reported cost |
| ------------------------ | --------- | ------------- |
| `venice/claude-opus-4-6` | 5,113,877 | **$0.00**     |
| `openai/gpt-4.1-mini`    | 14,599    | $0.006        |

~80% of the fleet runs Venice primaries (`qwen3-5-9b`, `claude-opus-4-6`,
`zai-org-glm-4.7`, …), so the daily usage email, the dashboard usage report,
and the `usage_monthly` spend accrual are blind to nearly all real inference
spend. `missingCostEntries` stays 0 — the zero is a _computed_ value, not a
flagged gap, so nothing warns.

## What exists (read, not remembered)

1. **The zero source** — `src/agents/venice-models.ts:7`:

   ```ts
   // Venice uses credit-based pricing, not per-token costs.
   // Set to 0 as costs vary by model and account type.
   export const VENICE_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
   ```

   Used in **three** places (Rev 2 correction — was "two"):
   (a) `buildVeniceModelDefinition` (line 618) — called both by discovery's
   catalog-match branch **and** by the explicit-config path below;
   (b) the non-catalog branch of `discoverVeniceModels` (line 737);
   (c) **`applyVeniceProviderConfig`** (`src/commands/onboard-auth.config-core.ts:295`)
   — maps `VENICE_MODEL_CATALOG` through `buildVeniceModelDefinition` into
   **explicit** `cfg.models.providers.venice` at onboard/auth time.

   **Merge precedence (the P1 root cause):** `mergeProviderModels`
   (`src/agents/models-config.ts`) concatenates explicit models first, then adds
   an implicit model only if its id is not already in the explicit set
   (`seen.has(id) → drop`). So for a model present in both the zero-cost explicit
   catalog (c) and priced discovery (b), the **zero-cost explicit entry wins and
   the priced one is discarded**. Same shape defeats the stale-cache case.

2. **The comment is outdated.** Venice's `GET /api/v1/models` returns per-token
   USD pricing today (verified live):

   ```json
   "pricing": { "input": {"usd": 6, "diem": 6}, "cache_input": {"usd": 0.6, ...},
                "cache_write": {"usd": 7.5, ...}, "output": {"usd": 30, ...} }
   ```

   Units are **USD per million tokens** (glm-5-2 at 1.4/4.4 matches Venice's
   published $/M prices). Some models omit fields: `qwen3-5-9b` has no
   `cache_input`/`cache_write`. `discoverVeniceModels` already fetches this
   endpoint (line ~690) but ignores `model_spec.pricing`; the
   `VeniceModelSpec` interface (line 630) doesn't declare it.

3. **Turn-time costing** — pi-ai `calculateCost`
   (`@mariozechner/pi-ai/dist/models.js:22`) computes
   `usage.cost.input = (model.cost.input / 1_000_000) * usage.input` etc.
   Same USD-per-million convention. The resulting `usage.cost` is persisted
   into the session transcript (`message.usage.cost`), which is what
   `usage.report` sums (`src/infra/session-cost-usage.ts:347-358`).

4. **Report-side fallback already exists** —
   `src/infra/session-cost-usage.ts:251` re-prices entries whose stored cost is
   _undefined_ via `resolveModelCostConfig` + `estimateUsageCost`
   (`src/utils/usage-format.ts:46,64` — also USD-per-million). Venice entries
   skip it because their stored cost is a **defined zero**. No change needed
   here; noted so review doesn't propose rebuilding it.

5. **models.json plumbing** — `ensureAgentModelsJson`
   (`src/agents/models-config.ts:85-150`) writes the discovered Venice models
   (including `cost`) to each agent's `models.json` in merge mode. Gotcha at
   line ~123: when discovery returns _fewer_ Venice models than the cached
   file, the cached (zero-cost) entries are **preserved** — see Risks.

6. **Discovery failure fallback** — `discoverVeniceModels` retries once, then
   falls back to the static `VENICE_MODEL_CATALOG` via
   `buildVeniceModelDefinition` (line ~774), which today hard-codes
   `VENICE_DEFAULT_COST`.

## Design

Rev 2: a pure pricing fn + discovery threading (`src/agents/venice-models.ts`)
**plus** a Venice-scoped cost-aware merge (`src/agents/models-config.ts`) so
priced discovery wins over zero-cost onboard/cached entries.

### 1. Pure mapping fn

```ts
export function veniceCostFromPricing(pricing?: VenicePricing): ModelCost {
  return {
    input: usd(pricing?.input),
    output: usd(pricing?.output),
    // Rev 2 (Codex P2): fail closed. A missing cache price is 0+warn, NOT the
    // input rate — a guessed nonzero rate would overstate spend and could
    // trip a spend-cap suspension. `usd()` returns 0 for missing/NaN/negative.
    cacheRead: usd(pricing?.cache_input),
    cacheWrite: usd(pricing?.cache_write),
  };
}
```

- `usd(field)` = the finite non-negative `field.usd`, else 0. Any field that
  falls back to 0 emits **one `console.warn`** naming the model id and the
  missing field, so an unpriced-but-used dimension is loud, never silent.
- `pricing` absent entirely → all zeros (identical to today) + warn. Fail-closed
  to $0 — never a guessed or sibling-model price.
- Add `pricing?: VenicePricing` to the `VeniceModelSpec` interface
  (`{ input?: {usd?: number}; output?: {usd?: number}; cache_input?: {usd?: number}; cache_write?: {usd?: number} }`).
  All fields optional; non-finite/negative `usd` values are treated as absent
  (reuse the file's `coercePositiveNumber` shape — but allow fractional, so a
  small local guard, not `Math.floor`).

### 2. Thread it through discovery (both branches)

- Catalog-match branch (line ~718): `buildVeniceModelDefinition(catalogEntry)`
  currently bakes in `VENICE_DEFAULT_COST`; the discovery call site overrides
  with `cost: veniceCostFromPricing(apiModel.model_spec.pricing)` (same
  pattern as the existing `contextWindow`/`maxTokens` overrides).
- Non-catalog branch (line ~737): replace `cost: VENICE_DEFAULT_COST` with the
  same call.
- Static-catalog fallback (API down, line ~774): unchanged — stays $0 with the
  existing "using static catalog" warn. We do NOT hand-maintain ~40 price rows
  that Venice changes; the API is the source of truth.
- `VENICE_DEFAULT_COST` stays as the zero fallback constant; the stale comment
  at line 7 is updated to say pricing comes from the API and zero means
  "unpriced".

### 3. Cost-aware merge: resolves P1 (explicit path) + P2 (stale cache)

The explicit onboard catalog (source c) and any larger stale cache both write
**zero-cost** Venice entries that `mergeProviderModels` lets win over priced
discovery for the same id. One principle fixes both:

> **A successful API discovery is authoritative for the `cost` of every id it
> covers.** The discovered `cost` replaces the explicit/cached `cost`
> **unconditionally — including when the discovered cost is zero.** Older
> sources (onboard catalog, on-disk cache) only _fill in_ ids the latest
> discovery did not return.
>
> **Rev 5:** "successful API discovery" is literal — discovery results carry a
> source marker (`api` | `fallback`). A **fallback** result (static catalog,
> API unreachable) is NOT authoritative: it never replaces an existing `cost`
> (zero or nonzero); it only supplies entries for ids with no entry at all.
> This preserves last-known-good prices across API outages while keeping the
> fail-closed semantics of a genuine API-returned zero.

- **Rev 3 fix (Codex round 2, P2):** the Rev 2 rule ("take implicit only if
  explicit is all-zero **and** implicit is nonzero") had a hole — if Venice
  omits/malforms a returned model's pricing, `veniceCostFromPricing` fails
  closed to zero, but a stale **nonzero** cached cost would survive and keep
  over-reporting (violating invariant 2). Dropping the conditional closes it: a
  discovered zero is a deliberate fail-closed signal and must win over a stale
  nonzero. Discovery is the single source of truth for prices of ids it returns.
- Scope the change to the **`venice` provider only** — in `mergeProviderModels`
  (explicit-vs-implicit) and the stale-cache guard in `ensureAgentModelsJson`
  (`models-config.ts:~123`, cached-vs-new). Do not touch generic merge semantics
  for other providers (invariant 3: only `cost`, only Venice). Keep everything
  else (id, aliases, contextWindow) from the retained entry; only `cost` is
  overwritten from discovery.
- This keeps discovery as the single price source and needs no hand-maintained
  prices. If discovery has never succeeded (fresh onboard, API down), entries
  stay zero-cost + warn until the first good discovery — fail-open to $0
  visibility, never a wrong price.
- **`applyVeniceProviderConfig` itself is left writing the catalog** (it has no
  API data at onboard time); the merge is where price wins. Alternative
  considered and rejected: making the onboard path fetch prices — it runs in CLI
  auth flows without guaranteed network and would duplicate discovery.

### 4. Context tiers: base rate + flag (Codex round 3, P2)

Venice's `model_spec.pricing` can carry higher-context tiers (e.g.
`qwen-3-6-plus` has `pricing.extended` with `context_token_threshold: 256000`
at ~2× the base rate). pi-ai's `calculateCost` uses one flat `model.cost` per
model and has no per-request context-size input, so true tiered costing is a
larger change than this plan.

- `veniceCostFromPricing` reads **only the base-tier** `input/output/cache_*`
  (the top-level `usd` fields), which is what it already does.
- **Detect and flag:** if a model's `pricing` contains any tier object (a value
  with a `context_token_threshold`), emit a `console.warn` naming the model and
  threshold, so the under-reporting is visible rather than silent.
- **Bound:** base-tier under-reports only for turns whose context exceeds the
  threshold, and only by the base-vs-tier delta. Verified live (2026-07-10): of
  the fleet's current Venice primaries (`qwen3-5-9b`, `claude-opus-4-6`,
  `claude-opus-4-7-fast`, `zai-org-glm-4.7`) **none expose a tier** — impact on
  today's spend/cap audit is zero; the warn catches it if a tiered model is
  later adopted.

### Explicitly relying on (no changes)

- pi-ai `calculateCost` picks up `model.cost` from `models.json` → new turns
  persist real `usage.cost` into transcripts → `usage.report`, the dashboard
  report, the daily email, and `snapshot-usage` all show real numbers with
  **zero changes** to those layers.
- Unit consistency: Venice `usd` (per-M) → `ModelCost` (per-M) → pi-ai
  divides by 1M. No conversion constant anywhere.

## Rev 5 implementation notes (verification-workflow folds)

A pre-handoff 4-lens adversarial verification of the implementation diff caught
two holes in how the Rev 5 rules were first coded; both are folded and named
in §Tests. They refine — not change — the approved principle ("only a
successful API discovery is cost-authoritative"):

- **Raw-API authority in the cache guard.** The guard must refresh cached
  costs from the _raw discovered list_, never the merged provider models —
  otherwise explicit onboard-catalog zeros piggyback into the authoritative
  set and zero out cached prices for ids the API did not return.
- **No-discovery runs are non-authoritative.** When no implicit Venice
  discovery ran at all (`veniceSource` undefined — no env key/profile, e.g. a
  CLI run outside docker), the guard behaves like "fallback": never refreshes
  costs, preserves a non-empty cache, fills missing ids. Defaulting the
  unknown case to "api" would let an explicit-only run rewrite cached prices.
- **Fill semantics everywhere.** Every preserved-cache outcome appends new ids
  the cache lacks (zero-cost for fallback/no-discovery entries), so a newly
  added catalog or config model still lands during an API outage; and
  `refreshVeniceCosts` skips authoritative entries without a `cost` field
  (never writes `cost: undefined`).

### Impl review round 1 (Codex, 2026-07-10): id-based reconcile

Two P2s on the implementation PR, folded as one mechanism change — the cache
guard's count-based early-return became a fully **id-based reconcile**
(`reconcileVeniceModels`), and the guard now always keeps the **new provider
object** (fresh `apiKey`/`baseUrl`/compat), only swapping in the reconciled
model list:

- count comparisons are gone: even when the API returns _more_ models overall,
  an id it omitted keeps its cached cost (the explicit catalog zero for that id
  cannot clobber it);
- preserved-cache paths no longer discard current provider metadata (the old
  `delete providers.venice` kept a stale cached provider object wholesale).

Named tests: "explicit-only ids never zero cached prices — authority is
id-based, not count-based", "cached-only ids are appended", "fallback/no
discovery never clobbers cached costs and fills new ids".

## Trust-boundary impact (dashboard spend caps)

`openclaw-dashboard` `snapshotAllWorkspaces` feeds
`shouldSuspend(monthlyCostUsd, planLimitFor(plan).maxMonthlyUsd)`. Caps:
free **$5/mo**, builder **$100/mo**, scale/enterprise unlimited. Turning
pricing on makes these caps real for Venice workspaces for the first time.

- Measured: the busiest builder-plan Venice workspace ≈ **$48/mo** at new prices (1.14M input×$6 +
  68k output×$30 + 3.9M cacheRead×$0.6 per week) → safely under $100.
- Risk: any Venice-primary **free** workspace burns its $5 cap fast →
  auto-suspend that reads as an outage.
- **Pre-rollout audit (required, blocking the fleet roll):** for each
  workspace, price its last-30-day `usage.report` tokens at the new rates and
  table it against its plan cap. Any workspace projected > 80% of cap goes to
  the owner for an explicit decision (plan bump, model change, or accept
  suspension) **before** the roll. This is an ops step in the impl PR
  checklist, not new code.
- Monthly accrual is delta-based per-day (`snapshotWorkspaceUsage` diffs
  today's report against today's earlier snapshot), so history stays $0 —
  no retroactive spend spike on roll day. Spend accrues at real rates only
  from post-roll turns.

## Invariants (attack these in review)

1. **Units:** every price is USD per million tokens end-to-end; a per-token or
   per-thousand mixup inflates costs 1,000,000× or 1,000×.
2. **Fail closed to zero, loudly:** missing/malformed pricing → cost 0 + warn.
   Never substitute a default or sibling-model price.
3. **Only `cost` changes.** No change to model ids, selection, fallbacks,
   `compat` (incl. `supportsUsageInStreaming`), context windows, or streaming
   behavior. A pricing fix must not be able to break inference.
4. **No retroactive billing:** stored transcript costs are never rewritten;
   monthly accrual only reflects post-roll turns.
5. **Suspension blast radius is enumerated before the roll**, not discovered
   after.

## Tests (vitest, extend `src/agents/venice-models.test.ts`)

- `veniceCostFromPricing`: full pricing → exact mapping (opus-4-6 fixture:
  6/30/0.6/7.5); **Rev 2 P2:** missing `cache_input` → cacheRead **0** + warn
  (qwen3-5-9b fixture: 0.1/0.15/**0**/0); missing `cache_write` → 0; `pricing`
  absent → all-zero + warn; negative/NaN/`usd` missing → 0 + warn.
- Discovery (existing mocked-fetch tests): catalog-match model carries API
  pricing (not `VENICE_DEFAULT_COST`); non-catalog model likewise; API-failure
  fallback still returns catalog models with zero cost.
- **Rev 2 P1 — cost-aware merge:** a `venice` provider merge where explicit
  (zero-cost) and implicit (priced) share an id → merged entry carries the
  priced `cost` (proves the onboard-catalog case is repriced); a non-Venice
  provider with the same collision is **unchanged** (proves scope); the
  stale-cache guard (`ensureAgentModelsJson`, discovery returns fewer models)
  refreshes cost for matching ids.
- **Rev 3 P2 — discovered-zero wins:** a merge where the cached/explicit entry
  has a **nonzero** cost and an **API** discovery returns the same id with
  **zero** cost (fail-closed) → merged entry is **zero** (proves stale nonzero
  can't survive a genuine API zero).
- **Rev 5 P2 — fallback does not clobber:** cached entry has **nonzero** cost
  and discovery result is `source: "fallback"` (zero-cost catalog) → merged
  entry **keeps the nonzero cached cost** (proves an API outage can't zero out
  last-known-good prices); a fallback id with **no** existing entry is added
  (zero-cost + warn).
- **Rev 3 P2 — tier flag:** a model whose `pricing` carries a
  `context_token_threshold` tier → base-tier `cost` mapped + warn emitted naming
  the model (proves detection); a flat-priced model emits no tier warn.
- Every hole Codex catches in review becomes a named case here (protocol §4).

## Deliberately NOT building

- **Historical re-pricing** of existing zero-cost transcript entries. The
  report-side fallback keys on `costTotal === undefined`; widening it to
  `=== 0` would also require a cost source in the report path (gateway
  `loadConfig()` doesn't include discovered implicit providers) and a
  breakdown-vs-total precedence change. Operator accepts $0 history.
- **Static catalog prices** (~40 hand-maintained rows that go stale).
- **DIEM/VCU credit accounting** — `usd` field only.
- **Accurate per-request context-tier pricing** (Rev 4 / round 3 P2). pi-ai
  `calculateCost` is flat per model; true tiering needs per-request context-size
  input. Deferred — base-tier + a warn (§Design 4); no current fleet primary is
  tiered, so present-day impact is zero.
- **Dashboard daily-email window fix** (`days:1` = "UTC today so far", shows 0
  for yesterday-active agents) — separate one-line dashboard PR, different repo.
- **OB-16** (fallback on unresolvable primary) — tracked in bug_list.md.

## Sequencing

1. This plan PR → Codex adversarial review → fold revs → approve. (Done:
   4 rounds + owner decision at the round-4 escalation bound.)
2. Impl PR (Rev 5 scope): `src/agents/venice-models.ts` (pricing mapping,
   source marker, tier flag) **and `src/agents/models-config.ts`** (Venice-
   scoped cost-aware merge in `mergeProviderModels` + the stale-cache guard),
   plus the full named-test list in §Tests — including the merge tests and the
   fallback-does-not-clobber test. Gate: vitest + typecheck + build.
3. Pre-rollout audit (ops step above); owner ack if any workspace > 80% cap.
4. Standard gateway image release; pin to the flagship Venice agent first,
   verify via a 1-turn smoke + `usage.report` probe (new turn shows
   `venice/... cost > 0`), then fleet roll.

## Risks

- ~~**Stale-cache preservation**~~ — **Rev 2: moved to a fix, not a risk.** The
  cost-aware merge (§Design 3) refreshes `cost` for matching ids, so a
  larger/older zero-cost cache no longer shadows priced discovery. A discovery
  timeout still leaves fresh-boot costs at 0 + warn until the next good
  discovery — fail-open to $0 visibility, never a wrong price.
- **Venice reprices models:** costs update on every successful discovery, so
  they track the API automatically; between discoveries they can be briefly
  stale. Accepted for operator-visibility purposes.
- **`claude-opus-4-7-fast` is $36/$180 per M** — one EU agent runs it as
  primary. The audit in step 3 will price it precisely; expect this
  to be the workspace most likely to need an owner decision.

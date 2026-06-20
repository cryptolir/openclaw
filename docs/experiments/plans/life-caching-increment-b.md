<!-- Status: design proposal — review-only (Codex). rev3 addresses reviews 4536945369 + 4537042419. Follow-up to #77 (rev4) after Increment A (#80) shipped. Not yet implemented; do NOT merge to deploy. -->

# Plan: `life` app-prompt caching — Increment B + Phase 3 (measure → stabilize → cache)

## Context

[#80](https://github.com/cryptolir/openclaw/pull/80) shipped **Increment A** of the [#77](https://github.com/cryptolir/openclaw/pull/77) plan — app-session-only prompt slimming (new `"app"` PromptMode, lean `AGENTS.app.md`/`SOUL.app.md`, excluded boilerplate, per-agent `appSkills` mechanism). That captured the **per-turn size win (~8 KB / ~2K tokens)** for every app turn, with Telegram/owner byte-identical.

The remaining lever is **prompt caching**: today `life` re-bills the _entire_ assembled prompt on every turn (no caching), so a long coaching chat pays for the same ~stable framework+bootstrap prefix N times. Increment A made that prefix _smaller_; it did not make it _cached_. Increment B + Phase 3 close that:

- **Phase 3** is the dominant lever — turn caching _on_, but only if Phase 0 shows the provider actually caches, and via the right mechanism for Venice.
- **Increment B** is the supporting refactor — the cross-user shared prefix **already exists today** (APP_PROFILE is appended last; see rev3 note), so Increment B's job is to keep it **byte-stable across turns** (memoize the static bootstrap span) and pull APP_PROFILE into a first-class render slot so the memo boundary is clean and the run/compaction paths can't drift. It does **not** extend the prefix.

This was deferred from Increment A deliberately: it has **no token/latency payoff until caching exists**, and it touches the load-bearing #71 first-turn greeting, so it belongs with the caching decision, not the size win.

## Review response — Codex review 4536945369 (rev2)

Both findings verified against live source and folded into Phase 0 / Increment B below:

- **[P1] The privacy-safe digest recipe didn't match `cache-trace` reality.** Confirmed: `systemDigest` is computed only inside the `includeSystem` branch (`cache-trace.ts:196–198`), so `OPENCLAW_CACHE_TRACE_SYSTEM=0` suppresses it too — and it digests the **whole** system prompt, not a shared-prefix split. Fix: Phase 0 adds **always-on, content-independent** digest fields — emitted even when raw prompt/system content is disabled. This is a tiny `cache-trace.ts` addition (hashes only), so Phase 0 is no longer pure-config but stays privacy-safe + low-risk. _(rev3 below corrects the exact field set to `preRuntimeDigest` (incl. APP_PROFILE) + `sharedPrefixDigest` (excl.) + `cacheablePrefixBytes`, and fixes that the per-user block is APP_PROFILE only.)_
- **[P2] Memoization scope must exclude bootstrap hooks.** Confirmed: `resolveBootstrapFilesForRun` runs `applyBootstrapHookOverrides(...)` before returning, so memoizing the whole `resolveBootstrapContextForRun` on session/config/app-file keys would **freeze hook-generated context** for the session. Fix: memoize **only the static load → filter → app-variant span** (`loadWorkspaceBootstrapFiles` → `filterBootstrapFilesForSession` → `applyAppBootstrapVariants`) and **re-run `applyBootstrapHookOverrides` (and APP_PROFILE) every turn**; if a hook genuinely needs caching it must declare its own cache key/TTL. Verification adds a **dynamic-hook freshness test** (hook output changes turn-to-turn must still surface), not just `AGENTS.app.md` edits.

## Review response — Codex review 4537042419 (rev3) — premise corrected

**[P1] The digest contract was internally inconsistent, and it exposed a weaker premise than #77 assumed.** Verified in code: `appendAppProfileBootstrapFile` appends APP_PROFILE **last** (`app-profile-context.ts:170` `return [...files, contextFile]`), so it is already the final file in `# Project Context`, with only `## Runtime` after it. Consequences:

- A `sharedPrefixDigest` that stops _before_ APP_PROFILE is therefore **already cross-user stable today** — it cannot, by construction, "differ today and become identical after Increment B." The earlier Phase 0 contract would have measured the wrong thing.
- So **the cross-user shared prefix already exists today** (framework + bootstrap + the agent-scoped skills catalog, everything before the trailing APP_PROFILE). Increment B does **not** extend it. Increment B's real value is narrower: (a) **memoization** for byte-stable assembly **across turns** (same-user multi-turn caching + CPU), and (b) a **render-slot** that pulls APP_PROFILE out of the bootstrap-file list so the memo boundary is clean and APP_PROFILE can't drift between the run/compaction paths. The **dominant** lever remains **Phase 3** (does the provider actually cache the already-stable prefix?).
- Phase 0's digest contract is corrected to **two** explicit digests: `preRuntimeDigest` (includes `APP_PROFILE`, as currently ordered — so it differs per user today, proving `APP_PROFILE` is the per-user variance) and `sharedPrefixDigest` (excludes `APP_PROFILE` — the cacheable candidate, expected already-stable). Plus `cacheablePrefixBytes` (leading bytes identical across two users) as the headline metric.

**Non-blocking wording fixed:** the agent-scoped skills catalog renders early (`## Skills`) and is identical across a given agent's app users → it belongs in the **shared prefix**, not the per-user block. The per-user block is **APP_PROFILE only**. Corrected throughout (Phase 0, Phase 3 breakpoints, verification). Increment B does **not** move scoped skills.

## Carried-over ground truth (from #77, still true post-#80)

- `life` model = `venice/claude-opus-4-6`; **Venice = OpenAI-completions provider** → the Anthropic `cacheRetention` path is inert (`extra-params.ts`) and pi-ai's openai-completions `cache_control` injector is OpenRouter-gated (`openai-completions.js`) → **zero cache breakpoints today**. Venice _does_ return `cached_tokens` on responses → implicit caching is **measurable**.
- Prompt order (post-#80): framework (now `"app"`-trimmed) → bootstrap files (now lean `.app.md` + excluded boilerplate, incl. the agent-scoped `## Skills` catalog) → **APP_PROFILE appended LAST** in `# Project Context` (`appendAppProfileBootstrapFile`, `:170` `[...files, contextFile]`) → `## Runtime` last. **So the cross-user shared prefix already exists today** (everything before the trailing APP_PROFILE is identical across a given agent's app users). The real gaps are: (a) the prefix is re-assembled **every turn** with no guarantee of byte-stability across turns, and (b) APP_PROFILE lives inside the bootstrap-file list, entangling it with any bootstrap memo — both addressed by Increment B, which is a robustness/CPU change, **not** a cross-user-prefix extension.
- `resolveBootstrapContextForRun` is **re-resolved every turn** (no memoization) — fine for correctness, wasteful once we want a stable cached prefix.
- The shared **`resolveAppPromptContext`** helper (`app-prompt-context.ts`, #80) already unifies the run + compaction paths for app sessions — Increment B extends it with the APP_PROFILE render input so the two paths still can't drift (Codex 4536644504 #2).
- `cache-trace.ts` today emits **digests** (hashes, not raw content), but: its `systemDigest` is computed **only when `includeSystem` is on** (`:196–198`) and covers the **whole** system prompt — so it can't, as-is, measure shared-prefix stability with content disabled. Phase 0 adds the always-on split digests (below). It also does **not** capture the provider's `cached_tokens`; that comes from the model **response usage** and needs a separate one-line log.

## Phase 0 — Measure (the gate; do this FIRST; small low-risk code change)

The DOMINANT question is provider caching; the digests confirm the prefix shape and size the levers. Three measurements:

1. **Does the provider cache a stable prefix at all?** (the gate — decides whether Phase 3 is automatic or needs Option A/B.) Capture the model **response `usage.cached_tokens`** on turn 2+ of a single app session whose prefix is unchanged. > 0 ⇒ caches implicitly; 0 ⇒ it does not. Add a one-line `usage.cached_tokens`/`promptTokens` log at the openai-completions response boundary (token counts only — no content).
2. **Is the cross-user shared prefix already stable today, and how large is it?** Per the premise correction above, it should already be stable (APP_PROFILE is appended last) — measure to **confirm**, and to size `cacheablePrefixBytes` (how much is already cacheable).
3. **Is the shared prefix byte-stable across TURNS of one session?** (the gap Increment B's memoization closes.) Compare `sharedPrefixDigest` turn-to-turn within a session — any drift is wasted re-billing.

Privacy-safe capture (P1 — corrected): the existing `systemDigest` is gated behind `includeSystem` and is whole-system. So Phase 0 adds **always-on, content-independent** fields to `cache-trace.ts`, emitted even with `OPENCLAW_CACHE_TRACE_MESSAGES/PROMPT/SYSTEM=0`:

- `preRuntimeDigest` — hash of the assembled prompt up to `## Runtime` **including** APP_PROFILE in its current position. **Differs across users today** → proves APP_PROFILE is the per-user variance (the part that can never be in a cross-user cache).
- `sharedPrefixDigest` — hash of the candidate cacheable prefix **excluding** APP_PROFILE (framework + bootstrap + the agent-scoped skills catalog). Expected **identical across users** today (the existing cache target) and constant across turns.
- `cacheablePrefixBytes` — byte length up to the first cross-user divergence (≈ where APP_PROFILE begins) = the headline "how much is cacheable" number.

All hashes/counts (no content). Output: a table (prompt tokens, `preRuntimeDigest` cross-user-differs y/n, `sharedPrefixDigest` cross-user-stable + cross-turn-stable y/n, `cacheablePrefixBytes`, turn-2 `cached_tokens` y/n, p50 latency) → **decides Phase 3 path**. If the provider doesn't cache, neither Increment B nor the already-stable prefix yields any win → Phase 3 Option A/B is required. NOTE: Phase 0 is a tiny code change (the digest fields + one usage log), not pure-config — low-risk and reusable for the post-Increment-B re-measure.

## Increment B — byte-stable assembly + clean APP_PROFILE separation (openclaw PR → roll life-only)

> Scope note (rev3): the cross-user shared prefix already exists today (APP_PROFILE is appended last). Increment B does **not** extend it — it secures **cross-turn** byte-stability (memoization) and pulls APP_PROFILE into a first-class slot so the memo boundary is clean and the run/compaction paths can't drift. The big win is still **Phase 3** (provider caching).

1. **Dedicated APP_PROFILE render slot** (Codex 4533385398 P2 — a real render split, not a hook reorder): add an `appProfileContext` input to `buildAgentSystemPrompt`, rendered as its **own section AFTER `# Project Context`, immediately before `## Runtime`** (the same end-position it already occupies as the trailing file — this is a clean-separation refactor, not a reorder). Stop appending `APP_PROFILE.md` into the bootstrap-file list (`appendAppProfileBootstrapFile` → feed the render input instead) so APP_PROFILE is **out of the memoized bootstrap span**. Thread it through the shared `resolveAppPromptContext` so **both** `attempt.ts` and `compact.ts` populate it identically. Preserve the #71 first-turn `appUserIdFromSessionKey` resolution. Tests: APP_PROFILE **absent** from the `# Project Context` file list, appears **exactly once** after the shared prefix and before `## Runtime`; greets-by-name on turn 1 intact; compaction parity (`compact.ts` byte-identical to `attempt.ts` for the same inputs).
2. **Per-session memoization of the STATIC bootstrap span only** (Codex 4536644504 #3 + 4536945369 P2): memoize **just** `loadWorkspaceBootstrapFiles` → `filterBootstrapFilesForSession` → `applyAppBootstrapVariants` (the file I/O), keyed on `(sessionKey, promptMode, app-variant file mtime+size [or content hash], config version)`. **`applyBootstrapHookOverrides` and APP_PROFILE re-run every turn** (after the memoized span), so dynamic hook output and per-user context are never frozen. Editing/rolling back `AGENTS.app.md`/`SOUL.app.md` or the `appSkills` allowlist misses the cache and re-resolves; conservative fallback = new-session-only / short TTL. If a hook ever needs to be cached, it must declare its own cache key/TTL (not covered by the static-span memo). Tests: (a) edit `AGENTS.app.md` mid-session → next turn reflects it; (b) **dynamic-hook freshness** — a bootstrap hook whose output changes turn-to-turn still surfaces on every turn (proves hooks aren't memoized).

## Phase 3 — turn caching on (gated on Phase 0; owner decision only if needed)

- **If Phase 0 shows the provider caches implicitly** → the already-stable prefix (kept byte-stable across turns by Increment B's memo) captures the win automatically; no provider change needed.
- **If not** (owner decision): **Option A** — generalize pi-ai's openai-completions `cache_control` injector behind a per-model flag and test whether Venice honors it (keeps Venice; cheapest). **Option B** — route `claude-opus-4-6` to an Anthropic-API endpoint so the existing `cacheRetention` path works (cost + data-routing sign-off).
- Either way: **2 breakpoints** — after the shared prefix (framework + lean app bootstrap + the agent-scoped skills catalog, identical across all life app users) and after the per-user block (**APP_PROFILE only**).

## Critical files

- `src/agents/system-prompt.ts` — `appProfileContext` input + dedicated render slot (after `# Project Context`, before `## Runtime`); stop carrying APP_PROFILE in the bootstrap-file list.
- `src/agents/app-prompt-context.ts` — extend the shared helper with the APP_PROFILE render input (keeps attempt/compact parity).
- `src/agents/bootstrap-files.ts` — remove APP_PROFILE from the bootstrap-file list; memoize **only the static load → filter → app-variant span** (mtime/hash + config-version key) and keep `applyBootstrapHookOverrides` + APP_PROFILE **outside** the memo (re-run every turn) (P2).
- `src/agents/cache-trace.ts` — add always-on, content-independent `preRuntimeDigest` (incl. APP_PROFILE) + `sharedPrefixDigest` (excl. APP_PROFILE) + `cacheablePrefixBytes`, emitted even when `includeSystem`/`includePrompt` are off (P1).
- `src/agents/app-profile-context.ts` — `appendAppProfileBootstrapFile` → provide the render input instead of a synthetic bootstrap file.
- `src/agents/pi-embedded-runner/run/attempt.ts` + `compact.ts` — pass the render input through; cache-trace + response-usage capture for Phase 0.
- `src/agents/pi-embedded-runner/extra-params.ts` + `node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js` — cache-breakpoint enablement (Phase 3 Option A only).

## Expected impact

- No further per-turn _size_ change (Increment A already captured it). The win is **multi-turn**: with caching, the shared prefix is re-billed at ~10% after turn 1 → large input-token + latency cut on long coaching chats (the dominant cost there). Telegram/owner unaffected.

## Verification

- **Phase 0 table** reproduced before vs after (prompt tokens, `preRuntimeDigest` cross-user-differs, `sharedPrefixDigest` cross-user + cross-turn stable, `cacheablePrefixBytes`, turn-2 `cached_tokens`, p50 latency).
- **APP_PROFILE placement**: absent from the `# Project Context` file list; appears exactly once after the shared prefix and before `## Runtime`; #71 turn-1 greeting intact.
- **Cross-user identity**: two different app users share an identical `sharedPrefixDigest` (the cache target — already true today; must stay true) while `preRuntimeDigest` differs (APP_PROFILE is the only per-user variance — scoped skills stay shared).
- **Cross-turn stability (the Increment B win)**: `sharedPrefixDigest` is constant turn-to-turn within a session (memoization); and editing `AGENTS.app.md` mid-session → next turn reflects it (memo invalidation).
- **Dynamic-hook freshness (P2)**: a bootstrap hook whose output changes turn-to-turn surfaces on every turn — proving `applyBootstrapHookOverrides` is not frozen by the static-span memo.
- **Compaction parity**: `compact.ts` and `attempt.ts` produce byte-identical app prompts for the same inputs.
- **Non-app byte-identical** (mechanical gate, unchanged from #80): a Telegram/owner prompt is byte-identical before vs after.

## Decision gate

Phase 3 needs an owner call **only if** Phase 0 shows Venice doesn't cache implicitly: Option A (generalize the openai-completions injector, keep Venice) vs Option B (route Claude via Anthropic — cost + data-routing trade-off). Phase 0 + Increment B carry no such decision and are safe to do first.

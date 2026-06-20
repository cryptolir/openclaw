<!-- Status: design proposal — review-only (Codex). rev2 addresses review 4536945369. Follow-up to #77 (rev4) after Increment A (#80) shipped. Not yet implemented; do NOT merge to deploy. -->

# Plan: `life` app-prompt caching — Increment B + Phase 3 (measure → stabilize → cache)

## Context

[#80](https://github.com/cryptolir/openclaw/pull/80) shipped **Increment A** of the [#77](https://github.com/cryptolir/openclaw/pull/77) plan — app-session-only prompt slimming (new `"app"` PromptMode, lean `AGENTS.app.md`/`SOUL.app.md`, excluded boilerplate, per-agent `appSkills` mechanism). That captured the **per-turn size win (~8 KB / ~2K tokens)** for every app turn, with Telegram/owner byte-identical.

The remaining lever is **prompt caching**: today `life` re-bills the _entire_ assembled prompt on every turn (no caching), so a long coaching chat pays for the same ~stable framework+bootstrap prefix N times. Increment A made that prefix _smaller_; it did not make it _cached_. Increment B + Phase 3 close that:

- **Increment B** makes the shared prefix **byte-stable and position-stable** so it is _cacheable_ (move APP_PROFILE out of the cached region; memoize bootstrap).
- **Phase 3** turns caching _on_ — but only if Phase 0 shows it pays off, and via the right mechanism for Venice.

This was deferred from Increment A deliberately: it has **no token/latency payoff until caching exists**, and it touches the load-bearing #71 first-turn greeting, so it belongs with the caching decision, not the size win.

## Review response — Codex review 4536945369 (rev2)

Both findings verified against live source and folded into Phase 0 / Increment B below:

- **[P1] The privacy-safe digest recipe didn't match `cache-trace` reality.** Confirmed: `systemDigest` is computed only inside the `includeSystem` branch (`cache-trace.ts:196–198`), so `OPENCLAW_CACHE_TRACE_SYSTEM=0` suppresses it too — and it digests the **whole** system prompt, not a shared-prefix split. Fix: Phase 0 now adds **always-on, content-independent** digest fields — `sharedPrefixDigest` (framework + lean bootstrap, up to the APP_PROFILE/Runtime boundary) and `perUserBlockDigest` (APP_PROFILE + trailing per-user block) — emitted even when raw prompt/system content is disabled. This is a tiny `cache-trace.ts` addition (hashes only), so Phase 0 is no longer pure-config but stays privacy-safe + low-risk.
- **[P2] Memoization scope must exclude bootstrap hooks.** Confirmed: `resolveBootstrapFilesForRun` runs `applyBootstrapHookOverrides(...)` before returning, so memoizing the whole `resolveBootstrapContextForRun` on session/config/app-file keys would **freeze hook-generated context** for the session. Fix: memoize **only the static load → filter → app-variant span** (`loadWorkspaceBootstrapFiles` → `filterBootstrapFilesForSession` → `applyAppBootstrapVariants`) and **re-run `applyBootstrapHookOverrides` (and APP_PROFILE) every turn**; if a hook genuinely needs caching it must declare its own cache key/TTL. Verification adds a **dynamic-hook freshness test** (hook output changes turn-to-turn must still surface), not just `AGENTS.app.md` edits.

## Carried-over ground truth (from #77, still true post-#80)

- `life` model = `venice/claude-opus-4-6`; **Venice = OpenAI-completions provider** → the Anthropic `cacheRetention` path is inert (`extra-params.ts`) and pi-ai's openai-completions `cache_control` injector is OpenRouter-gated (`openai-completions.js`) → **zero cache breakpoints today**. Venice _does_ return `cached_tokens` on responses → implicit caching is **measurable**.
- Prompt order (post-#80): framework (now `"app"`-trimmed) → bootstrap files (now lean `.app.md` + excluded boilerplate) → `## Runtime` last. **Remaining wart:** `APP_PROFILE.md` is still appended _inside_ the bootstrap block and rendered in `# Project Context` (`appendAppProfileBootstrapFile`), so the otherwise-shared prefix differs **per app user** → no cross-user prefix to cache, and the per-user block sits _before_ `## Runtime` instead of after the cacheable region.
- `resolveBootstrapContextForRun` is **re-resolved every turn** (no memoization) — fine for correctness, wasteful once we want a stable cached prefix.
- The shared **`resolveAppPromptContext`** helper (`app-prompt-context.ts`, #80) already unifies the run + compaction paths for app sessions — Increment B extends it with the APP_PROFILE render input so the two paths still can't drift (Codex 4536644504 #2).
- `cache-trace.ts` today emits **digests** (hashes, not raw content), but: its `systemDigest` is computed **only when `includeSystem` is on** (`:196–198`) and covers the **whole** system prompt — so it can't, as-is, measure shared-prefix stability with content disabled. Phase 0 adds the always-on split digests (below). It also does **not** capture the provider's `cached_tokens`; that comes from the model **response usage** and needs a separate one-line log.

## Phase 0 — Measure (the gate; do this FIRST, zero code risk)

Two distinct questions decide everything downstream:

1. **Does Venice cache a stable prefix at all?** (decides whether Phase 3 needs Option A/B, or is automatic.) Capture the model **response `usage.cached_tokens`** on turn 2+ of a single app session whose prefix is unchanged. > 0 ⇒ Venice caches implicitly; 0 ⇒ it does not. _(Needs a multi-turn app session; capture token counts only — no prompt/message content.)_
2. **Is the shared prefix currently NOT stable across users?** (confirms Increment B is necessary + sizes the win.) Use `cache-trace` digests: compare the system-prompt prefix digest for **two different app users** — today they differ (APP_PROFILE inside Project Context); after Increment B the framework+bootstrap prefix digest should be **identical** across users, with only the trailing per-user block differing.

Privacy-safe capture (P1 — corrected): the existing `systemDigest` is gated behind `includeSystem` and is whole-system, so it can't answer question 2 with content off. So Phase 0 adds two **always-on, content-independent** digest fields to `cache-trace.ts`, emitted even when `OPENCLAW_CACHE_TRACE_MESSAGES/PROMPT/SYSTEM=0`:

- `sharedPrefixDigest` — hash of the assembled system prompt **up to the APP_PROFILE/`## Runtime` boundary** (framework + lean app bootstrap = the cache target).
- `perUserBlockDigest` — hash of the **trailing** per-user block (APP_PROFILE + scoped skills).

Both are hashes (no content). Then: question 2 = compare `sharedPrefixDigest` across two different app users (today differs → after Increment B identical); question 1 = add a one-line `usage.cached_tokens`/`promptTokens` log at the openai-completions response boundary. Output: a table (prompt tokens, `sharedPrefixDigest` cross-user-stable y/n, turn-2 `cached_tokens` y/n, p50 latency) → **decides Phase 3 path**. If the provider doesn't cache, Increment B has no payoff alone → Phase 3 Option A/B is required for any win. NOTE: this makes Phase 0 a tiny code change (the digest split), not pure-config — but low-risk and reusable for the post-Increment-B re-measure.

## Increment B — make the prefix cacheable (openclaw PR → roll life-only)

1. **Dedicated APP_PROFILE render slot** (Codex 4533385398 P2 — a real render split, not a hook reorder): add an `appProfileContext` input to `buildAgentSystemPrompt`, rendered as its **own section AFTER `# Project Context`, immediately before `## Runtime`**. Stop appending `APP_PROFILE.md` into the bootstrap-file list (`appendAppProfileBootstrapFile` → feed the render input instead). Thread it through the shared `resolveAppPromptContext` so **both** `attempt.ts` and `compact.ts` populate it identically. Net effect: the framework+bootstrap prefix becomes **identical across all app users** (cacheable cross-user), and the per-user block sits _after_ it. Preserve the #71 first-turn `appUserIdFromSessionKey` resolution (APP_PROFILE stays outside any memo span). Tests: APP_PROFILE **absent** from `# Project Context`, appears **exactly once** after the shared prefix and before `## Runtime`; greets-by-name on turn 1 intact; compaction parity (`compact.ts` byte-identical to `attempt.ts` for the same inputs).
2. **Per-session memoization of the STATIC bootstrap span only** (Codex 4536644504 #3 + 4536945369 P2): memoize **just** `loadWorkspaceBootstrapFiles` → `filterBootstrapFilesForSession` → `applyAppBootstrapVariants` (the file I/O), keyed on `(sessionKey, promptMode, app-variant file mtime+size [or content hash], config version)`. **`applyBootstrapHookOverrides` and APP_PROFILE re-run every turn** (after the memoized span), so dynamic hook output and per-user context are never frozen. Editing/rolling back `AGENTS.app.md`/`SOUL.app.md` or the `appSkills` allowlist misses the cache and re-resolves; conservative fallback = new-session-only / short TTL. If a hook ever needs to be cached, it must declare its own cache key/TTL (not covered by the static-span memo). Tests: (a) edit `AGENTS.app.md` mid-session → next turn reflects it; (b) **dynamic-hook freshness** — a bootstrap hook whose output changes turn-to-turn still surfaces on every turn (proves hooks aren't memoized).

## Phase 3 — turn caching on (gated on Phase 0; owner decision only if needed)

- **If Phase 0 shows Venice caches implicitly** → Increment B's now-stable prefix captures the win automatically; no provider change needed.
- **If not** (owner decision): **Option A** — generalize pi-ai's openai-completions `cache_control` injector behind a per-model flag and test whether Venice honors it (keeps Venice; cheapest). **Option B** — route `claude-opus-4-6` to an Anthropic-API endpoint so the existing `cacheRetention` path works (cost + data-routing sign-off).
- Either way: **2 breakpoints** — after the shared prefix (framework + lean app bootstrap, identical across all life app users) and after the per-user block (APP_PROFILE + scoped skills).

## Critical files

- `src/agents/system-prompt.ts` — `appProfileContext` input + dedicated render slot (after `# Project Context`, before `## Runtime`); stop carrying APP_PROFILE in the bootstrap-file list.
- `src/agents/app-prompt-context.ts` — extend the shared helper with the APP_PROFILE render input (keeps attempt/compact parity).
- `src/agents/bootstrap-files.ts` — remove APP_PROFILE from the bootstrap-file list; memoize **only the static load → filter → app-variant span** (mtime/hash + config-version key) and keep `applyBootstrapHookOverrides` + APP_PROFILE **outside** the memo (re-run every turn) (P2).
- `src/agents/cache-trace.ts` — add always-on, content-independent `sharedPrefixDigest` / `perUserBlockDigest` (split at the APP_PROFILE/`## Runtime` boundary), emitted even when `includeSystem`/`includePrompt` are off (P1).
- `src/agents/app-profile-context.ts` — `appendAppProfileBootstrapFile` → provide the render input instead of a synthetic bootstrap file.
- `src/agents/pi-embedded-runner/run/attempt.ts` + `compact.ts` — pass the render input through; cache-trace + response-usage capture for Phase 0.
- `src/agents/pi-embedded-runner/extra-params.ts` + `node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js` — cache-breakpoint enablement (Phase 3 Option A only).

## Expected impact

- No further per-turn _size_ change (Increment A already captured it). The win is **multi-turn**: with caching, the shared prefix is re-billed at ~10% after turn 1 → large input-token + latency cut on long coaching chats (the dominant cost there). Telegram/owner unaffected.

## Verification

- **Phase 0 table** reproduced before vs after (prompt tokens, prefix-stable-across-users, turn-2 `cached_tokens`, p50 latency).
- **APP_PROFILE placement**: absent from `# Project Context`; appears exactly once after the shared prefix; #71 turn-1 greeting intact.
- **Cross-user prefix identity**: two different app users share an identical `sharedPrefixDigest` (the cache target); their `perUserBlockDigest` differs.
- **Memo invalidation**: edit `AGENTS.app.md` mid-session → next turn reflects it.
- **Dynamic-hook freshness (P2)**: a bootstrap hook whose output changes turn-to-turn surfaces on every turn — proving `applyBootstrapHookOverrides` is not frozen by the static-span memo.
- **Compaction parity**: `compact.ts` and `attempt.ts` produce byte-identical app prompts for the same inputs.
- **Non-app byte-identical** (mechanical gate, unchanged from #80): a Telegram/owner prompt is byte-identical before vs after.

## Decision gate

Phase 3 needs an owner call **only if** Phase 0 shows Venice doesn't cache implicitly: Option A (generalize the openai-completions injector, keep Venice) vs Option B (route Claude via Anthropic — cost + data-routing trade-off). Phase 0 + Increment B carry no such decision and are safe to do first.

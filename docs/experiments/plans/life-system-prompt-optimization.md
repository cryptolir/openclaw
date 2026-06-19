<!-- Status: design proposal — review-only (Codex). rev2 addresses review 4533385398. Not yet implemented; do NOT merge to deploy. -->

# Plan: Optimize the `life` agent system prompt (latency + tokens, keep relevance)

## Context

Every turn of a Havaya app chat re-builds and re-sends `life`'s full system prompt — a **~30–34 KB static block** — to the model, with **no prompt caching**. ~90% of the bootstrap weight is two files (`AGENTS.md` 13.4 KB + `SOUL.md` 12.6 KB), and most of `AGENTS.md` is **irrelevant to app users** (Telegram memory lanes §3, group chats §2, projects/meta/temp §6–8). App sessions also receive framework sections they can't use (CLI quick-ref, self-update, heartbeats) and possibly a large bundled skills catalog. Net: we pay latency + tokens every turn for content the app user never needs, and re-pay it because nothing is cached.

Goal: cut per-turn latency + token cost for **app-user** sessions while preserving output quality. Hard constraint: **Telegram/owner sessions stay byte-identical** — and (per review below) this is now enforced *mechanically*, by routing every app change through app-only code paths and never editing shared on-disk files.

## Review response — Codex review 4533385398 (addressed in this revision)

- **[P1] Phase-1 host edits broke the non-app byte-identical gate.** Removed all on-disk edits to shared files. ALL app trimming now flows through the app-only `agent:bootstrap` hook + a new `"app"` PromptMode, reading **additive app-variant files** (`SOUL.app.md`, `AGENTS.app.md`). `SOUL.md`/`AGENTS.md` on disk are untouched → Telegram/owner load identical bytes. Empty/dup files are excluded **for app sessions only** (not deleted globally).
- **[P1] Skill scoping must be life-only/config-driven.** No longer edits the shared `buildAppSkillsPrompt`/`limitAppSkills` to hardcode life's skills. Instead a **per-agent, config-driven allowlist** (life's `openclaw.json`) is read by the shared code; default (no allowlist) = today's behavior, so other app agents keep their own catalog (asserted by test).
- **[P2] APP_PROFILE needs a real render split, not a hook reorder.** Adds a **dedicated app-profile render slot** in `buildAgentSystemPrompt` (its own section after `# Project Context`, just before `## Runtime`); APP_PROFILE is removed from the bootstrap-file list / Project Context. Tests assert it's absent from Project Context and appears exactly once after the shared prefix.
- **[P2] Compaction parity gate.** Verification now covers the compaction/manual-overflow path (`compact.ts`), mirroring the #74 lesson — not just the fresh-session path.

## Verified ground truth (don't re-investigate)

- Prompt rebuilt + re-sent **every turn**; bootstrap resolved at `attempt.ts:321` (no memoization); sent via `applySystemPromptOverrideToSession` (`attempt.ts:657`) → `activeSession.prompt()` (`attempt.ts:1114`).
- **`life` model = `venice/claude-opus-4-6`**; per-agent config `/root/.openclaw/agents/life/openclaw.json` (`agents.defaults.model.primary`). **Venice = OpenAI-completions provider** (`models-config.providers.ts:539`), so the Anthropic `cacheRetention` path is inert (`extra-params.ts:111`) and pi-ai's openai-completions `cache_control` injector is OpenRouter-gated (`openai-completions.js:378`) → **zero cache breakpoints today**. Venice *does* return `cached_tokens` (`openai-completions.js:108`) → implicit caching is measurable.
- Prompt order is already ~80% cache-friendly: framework → bootstrap files (`system-prompt.ts:649`) → `## Runtime` last (`:693`). Wart: `APP_PROFILE.md` is appended **inside** the bootstrap block and rendered in `# Project Context` (`appendAppProfileBootstrapFile`, after hooks) — breaks prefix stability.
- `promptMode="minimal"` exists only for subagent/cron (`attempt.ts:491`); reusing it for app wrongly drops Reply-Tags/Voice → need a new **`"app"`** mode.
- `filterBootstrapFilesForSession` (`workspace.ts:475`) already scopes files per session; the `agent:bootstrap` hook (`bootstrap-hooks.ts:7`) can substitute/exclude files per session — the lever for app-only variants.
- Skills: always-on cost = `<available_skills>` **catalog (name+desc only)**; full body on demand via `load_skill` (≤24 KB), **app-session-only** (`appSkillLoad = appUserId && tools has load_skill`, `attempt.ts:385`). **Telegram/owner cannot `load_skill`** → they must keep the full inline exercise scripts in `SOUL.md`; only the app variant can rely on the skill.
- life's real skills: `summaryskill` (valid) + **`personal-vision-exercise`** (host + git-tracked life-only via #78) + an orphaned non-loadable `skills/SKILL.md` stub.
- `cache-trace.ts` (env `OPENCLAW_CACHE_TRACE`, wired `attempt.ts:671`) is the existing measurement harness — reuse it.

**Must NOT break:** APP_PROFILE name-on-message-1 (#68/#71); the `life-access-scope` jail + AGENTS §9 privacy; `save_user_section` + Graphiti; TAL Hebrew persona + SOUL 5-stage method; **Telegram/owner prompts byte-identical**; **other app agents' skill catalogs unchanged**.

## Recommended approach (phased)

### Phase 0 — Measure & answer the caching question (host env, zero-risk)
Set `OPENCLAW_CACHE_TRACE=1` for life, run a fixed **5-turn app-session script** against prod `life`; capture per-turn assembled-prompt **bytes/tokens**, **latency**, and **turn-2 `usage.cachedTokens`** (does Venice cache implicitly?). Also dump the actual app `<available_skills>` catalog size. Output: baseline table + implicit-caching yes/no (decides Phase 3).

### Phase 1 — App-only prompt slimming (openclaw PR → gateway image → roll life-only)
Every change here is **app-session-only**; shared on-disk files are never edited, so Telegram/owner prompts stay byte-identical.
1. **New `"app"` PromptMode** (`system-prompt.ts:15`; gated at `attempt.ts:491` on `isAppUserSession`): drop `## OpenClaw CLI Quick Reference`, `## OpenClaw Self-Update`, `## Silent Replies`, `## Heartbeats`, `## Model Aliases`, `## Documentation`; **keep** Safety/Tooling/Tool-Call-Style/Skills/Memory/Workspace/Reply-Tags/Messaging/Voice.
2. **App-variant bootstrap files via the `agent:bootstrap` hook** (`bootstrap-hooks.ts`), app sessions only: substitute **`AGENTS.app.md`** (lean: behavior §1 + app_profile/save_user_section §4–5 + privacy §9 + Graphiti §1–2) and **`SOUL.app.md`** (persona + 5-stage method summary; the detailed exercise scripts live in the `personal-vision-exercise` skill, loaded on demand); and **exclude** `TOOLS.md`/`MEMORY.md`/`HEARTBEAT.md`/`IDENTITY.md`/`USER.md`. The `.app.md` variants are **additive** host files — originals untouched, so Telegram keeps full `SOUL.md`/`AGENTS.md` + inline exercises.

### Phase 2 — Per-user placement, config-driven skills, memoization (same PR/roll)
1. **Dedicated APP_PROFILE render slot:** add an `appProfileContext` input to `buildAgentSystemPrompt`, rendered as its own section AFTER `# Project Context`, immediately before `## Runtime`; stop appending `APP_PROFILE.md` into the bootstrap-file list (so the shared `# Project Context` is byte-stable/cacheable and APP_PROFILE sits after the cached prefix). Preserve the #71 first-turn `appUserIdFromSessionKey` resolution.
2. **Config-driven app-skill allowlist:** add a per-agent allowlist (life `openclaw.json`, e.g. `skills.appAllowlist: ["summaryskill","personal-vision-exercise"]`) that the shared `limitAppSkills`/`buildAppSkillsPrompt` READS. No hardcoding; absent allowlist = current behavior → other app agents unaffected.
3. **Memoize shared bootstrap resolution per session** (`resolveBootstrapContextForRun`), keeping APP_PROFILE + scoped skills OUTSIDE the memoized span (name-on-message-1 preserved; memoized prefix stays byte-stable for caching).

### Phase 3 — Caching (gated on Phase 0; owner decision if needed)
- If Phase 0 shows Venice **already caches** the stable prefix → Phase 1–2's stable-prefix work captures the win automatically.
- If **not** (owner decision, privacy/cost): **Option A** — generalize pi-ai's openai-completions `cache_control` injector behind a per-model flag and test whether Venice honors it (keeps Venice). **Option B** — route `claude-opus-4-6` to an Anthropic-API endpoint so the existing `cacheRetention` path works (cost + data-routing sign-off).
- Either way: 2 breakpoints — after the shared prefix (framework + app-variant bootstrap, shared across all life app users) and after the per-user block (APP_PROFILE + scoped skills).

## Critical files
- `src/agents/system-prompt.ts` — new `"app"` PromptMode (`:15`), section gates, **dedicated app-profile render slot**, breakpoint ordering (`:416`, `:461–699`).
- `src/agents/pi-embedded-runner/run/attempt.ts` — promptMode gate `:491`, bootstrap resolve `:321`, app-skills `:385`, cache-trace `:671`.
- `src/agents/bootstrap-hooks.ts` + `src/agents/bootstrap-files.ts` — app-only variant substitution + file exclusion + per-session memoization; remove APP_PROFILE from the bootstrap-file list (move to the render slot).
- `src/agents/skills/workspace.ts` (`limitAppSkills`/`buildAppSkillsPrompt`) — read a per-agent config allowlist (default = unchanged).
- `src/agents/pi-embedded-runner/extra-params.ts` (`:60–117`) + `node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js` (`:378–428`) — cache-breakpoint enablement (Phase 3 Option A).
- Host (life, additive only): `workspace/SOUL.app.md`, `workspace/AGENTS.app.md`, `workspace/skills/personal-vision-exercise/` (exists); `openclaw.json` (`skills.appAllowlist`; Phase 3 Option B model/provider). **No edits to `SOUL.md`/`AGENTS.md`.**

## Expected impact
- App-session static prompt **~30–34 KB → ~12–16 KB** (lean app-variants + dropped framework sections + scoped skills + excluded empties). Telegram unchanged.
- With caching (Phase 3): stable prefix re-billed ~10% after turn 1 → large additional input-token + latency cut on multi-turn chats.

## Verification
- **Quantitative (cache-trace):** app-session prompt bytes/tokens before vs after on the fixed 5-turn script; `cachedTokens` > 0 on turn 2+ (if Phase 3); per-turn latency delta.
- **Behavior parity (app):** fresh-session first "Hi" greets by name (#71); jail intact; `summaryskill` + `personal-vision-exercise` load via `load_skill` and run end-to-end in Hebrew; `save_user_section` + Graphiti recall intact; TAL persona/method preserved.
- **APP_PROFILE placement:** assert `APP_PROFILE.md` is ABSENT from `# Project Context` and appears **exactly once**, after the shared prefix and before `## Runtime`.
- **Non-app byte-identical (mechanical gate):** byte-diff a Telegram/owner assembled prompt before vs after → identical (guaranteed: shared files + shared code paths unchanged for non-app).
- **Skill-scoping isolation:** a non-life app agent's `<available_skills>` catalog is unchanged when life's allowlist is set (config default path).
- **Compaction parity:** trigger compaction / manual-overflow on an app session, then re-assert — `"app"` PromptMode still applied, APP_PROFILE in its dedicated slot (appears once, no host-path leak), scoped skills intact, NO regression to full bootstrap (mirrors the #74 compaction fix).

## Decision gate
Phase 3 caching needs an owner call **only if** Phase 0 shows Venice doesn't cache implicitly: Option A (generalize the openai-completions injector, keep Venice) vs Option B (route Claude via Anthropic API — cost + data-routing trade-off). Phases 0–2 deliver most of the win and need no such decision.

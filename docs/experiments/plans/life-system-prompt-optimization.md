<!-- Status: design proposal — review-only (Codex). Not yet implemented; do NOT merge to deploy. Authored 2026-06-19. -->

# Plan: Optimize the `life` agent system prompt (latency + tokens, keep relevance)

## Context

Every turn of a Havaya app chat re-builds and re-sends `life`'s full system prompt — a **~30–34 KB static block** — to the model, with **no prompt caching**. ~90% of the bootstrap weight is two files (`AGENTS.md` 13.4 KB + `SOUL.md` 12.6 KB), and most of `AGENTS.md` is **irrelevant to app users** (Telegram memory lanes §3, group chats §2, projects/meta/temp §6–8). App sessions also receive framework sections they can't use (CLI quick-ref, self-update, heartbeats) and possibly the **full ~53-skill bundled catalog**. Several bootstrap files are empty boilerplate (`TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`). Net: we pay latency + tokens every turn for content the app user never needs, and re-pay it because nothing is cached.

Goal: cut per-turn latency and token cost for **app-user** sessions while preserving output quality — without changing Telegram/owner behavior.

## Verified ground truth (don't re-investigate)

- Prompt rebuilt + re-sent **every turn**; bootstrap resolved at `attempt.ts:321` (no memoization); sent via `applySystemPromptOverrideToSession` (`attempt.ts:657`) → `activeSession.prompt()` (`attempt.ts:1114`).
- **`life` model = `venice/claude-opus-4-6`**, set in the per-agent config `/root/.openclaw/agents/life/openclaw.json` (`agents.defaults.model.primary`). **Venice = OpenAI-completions provider** (`models-config.providers.ts:539`), so: the Anthropic `cacheRetention` path returns `undefined` for it (`extra-params.ts:111`), and pi-ai's openai-completions `cache_control` injector is gated to OpenRouter-only (`openai-completions.js:378`). **→ life gets zero cache breakpoints today.** Venice *does* read back `cached_tokens` (`openai-completions.js:108`), so implicit upstream caching is measurable.
- Prompt order is already ~80% cache-friendly: framework → bootstrap files (`system-prompt.ts:649`) → `## Runtime` (only per-turn-dynamic line) last (`:693`). The wart: `APP_PROFILE.md` is injected **mid-bootstrap**, breaking prefix stability.
- `promptMode="minimal"` exists only for subagent/cron (`attempt.ts:491`); reusing it for app would wrongly drop Reply-Tags/Voice. Need a **new `"app"` mode**.
- `filterBootstrapFilesForSession` (`workspace.ts:475`) already scopes bootstrap files per session (allowlist for subagent/cron) — precedent. The `agent:bootstrap` hook (`bootstrap-hooks.ts:7`) can substitute files per session — the clean lever for a lean app-`AGENTS.md`.
- Skills: always-on cost = `<available_skills>` **catalog (name+desc only)**; full body loaded on demand via `load_skill` (≤24 KB). App path = `buildAppSkillsPrompt`/`limitAppSkills` (`attempt.ts:385`). life's `skills` config is `{}` → actual catalog size unconfirmed (measure in Phase 0).
- life's real skills: `summaryskill` (valid) + **`personal-vision-exercise`** (created on host 2026-06-19) + an orphaned non-loadable `skills/SKILL.md` stub. `SOUL.md` still embeds the vision/avatar exercise scripts that now belong in that skill.
- `cache-trace.ts` (env `OPENCLAW_CACHE_TRACE`, wired `attempt.ts:671`) is the existing measurement harness — reuse it, build nothing.

**Must NOT break:** APP_PROFILE name-on-message-1 (#68/#71); the `life-access-scope` jail + AGENTS §9 privacy; `save_user_section` + Graphiti; the TAL Hebrew persona + SOUL 5-stage method; **Telegram/owner sessions must stay byte-identical**.

## Recommended approach (phased by ROI / risk / reversibility)

### Phase 0 — Measure & answer the caching question (host-only, immediate, zero-risk)
- Set `OPENCLAW_CACHE_TRACE=1` for life (host env), run a fixed **5-turn app-session script** against prod `life`, and capture: assembled prompt **bytes + tokens per turn**, per-turn **latency**, and **turn-2 `usage.cachedTokens`** (does Venice cache implicitly?). Also dump the actual app `<available_skills>` catalog size.
- Output: a baseline table + a yes/no on implicit Venice caching that decides Phase 3.

### Phase 1 — Content cuts on the host (reversible via `.bak`, no deploy)
Biggest, safest wins; effective next turn (bootstrap re-read each run):
1. **Slim `SOUL.md`** — move the detailed exercise scripts (4-question vision opener, avatar diagnostic sequence) into the existing `skills/personal-vision-exercise/SKILL.md`; keep persona + the 5-stage method summary always-on. *Largest single prefix shrink; aligns with the skill you're already building.*
2. **Prune dead files**: delete `TOOLS.md` (boilerplate), `MEMORY.md` (empty template), `HEARTBEAT.md` (empty). Drop `IDENTITY.md` (duplicated by auto-generated `BOOTSTRAP.md`).
3. **Remove the orphaned `skills/SKILL.md` stub** (non-loadable; see prior thread) so the catalog is clean.

### Phase 2 — Per-app-session trimming (openclaw PR → gateway image → roll life-only)
Code changes, shipped via the established `v2026.06.XX.N` build + single-agent recreate (rollback `docker.env.bak`):
1. **New `"app"` PromptMode** (`system-prompt.ts:15` + gate at `attempt.ts:491` on `isAppUserSession`): drop `## OpenClaw CLI Quick Reference`, `## OpenClaw Self-Update`, `## Silent Replies`, `## Heartbeats`, `## Model Aliases`, `## Documentation`; **keep** Safety/Tooling/Tool-Call-Style/Skills/Memory/Workspace/Reply-Tags/Messaging/Voice.
2. **Lean `AGENTS.md` for app sessions** via the `agent:bootstrap` hook (`bootstrap-hooks.ts`): substitute an app-only AGENTS (general behavior §1 + app_profile/save_user_section §4–5 + privacy §9 + Hebrew Graphiti §1–2), keep the **full** `AGENTS.md` for Telegram/owner. Also exclude empty `USER.md`/`IDENTITY.md` for app sessions. (Keeps the on-disk full file intact for non-app channels.)
3. **Scope the app skills catalog** to life-relevant skills (`summaryskill`, `personal-vision-exercise`) instead of the full merged/bundled set (`limitAppSkills` / `buildAppSkillsPrompt`, `attempt.ts:385`). Confirm magnitude from Phase 0.
4. **Reposition APP_PROFILE** injection to just before `## Runtime` (after the shared bootstrap block) so the shared prefix is **byte-stable across users** (cache prerequisite).
5. **Memoize shared bootstrap resolution per session** (`resolveBootstrapContextForRun`), keeping APP_PROFILE *outside* the memoized span so name-on-message-1 still works.

### Phase 3 — Caching (gated on Phase 0; owner decision if needed)
- If Phase 0 shows Venice **already caches** the stable prefix → Phase 2's reordering captures the win automatically; done.
- If **not**, choose (owner decision — privacy/cost):
  - **Option A (smaller change):** generalize pi-ai's openai-completions `cache_control` injector behind a per-model flag and test whether Venice honors `cache_control` (keeps Venice; no data-routing change).
  - **Option B (bigger change):** route `claude-opus-4-6` to an Anthropic-API endpoint so the existing `cacheRetention` path works (needs sign-off on cost + sending data to Anthropic directly).
- Either way: place **2 cache breakpoints** — after the shared prefix (framework + lean bootstrap, shared across all life users) and after the per-user block (APP_PROFILE + scoped skills).

## Critical files
- `src/agents/system-prompt.ts` — new `"app"` PromptMode + section gates + breakpoint ordering (`:15`, `:416`, `:461–699`).
- `src/agents/pi-embedded-runner/run/attempt.ts` — promptMode gate `:491`, bootstrap resolve `:321`, app-skills `:385`, cache-trace `:671`.
- `src/agents/bootstrap-hooks.ts` + `src/agents/bootstrap-files.ts` — app-AGENTS swap, app-session file exclusion, memoization.
- `src/agents/pi-embedded-runner/extra-params.ts` (`:60–117`) + `node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js` (`:378–428`) — cache-breakpoint enablement (Phase 3 Option A).
- Host (life, not in git): `/root/.openclaw/agents/life/workspace/{SOUL.md, AGENTS.md}` + `skills/personal-vision-exercise/SKILL.md`; prune `TOOLS.md`/`MEMORY.md`/`HEARTBEAT.md`/`IDENTITY.md`/`skills/SKILL.md`; `openclaw.json` (Phase 3 Option B).

## Expected impact
- Static app-session prompt **~30–34 KB → ~12–16 KB** (Phases 1–2): slim SOUL + lean AGENTS + dropped framework sections + scoped skills + pruned files.
- With caching (Phase 3): the stable prefix re-billed at ~10% after turn 1 → large additional input-token + latency cut on multi-turn chats.

## Verification
- **Quantitative (cache-trace harness):** assembled prompt bytes/tokens before vs after on the fixed 5-turn script; `cachedTokens` > 0 on turn 2+ (if Phase 3); per-turn latency delta.
- **Behavior parity:** fresh-session first "Hi" greets by name (#71); jail intact (app session still blocked from shell/enumeration/out-of-workspace reads); `summaryskill` **and** `personal-vision-exercise` load via `load_skill` and run end-to-end in Hebrew; `save_user_section` + Graphiti recall intact; TAL persona/method preserved.
- **No-regression for non-app:** byte-diff the assembled prompt for a Telegram/owner session before vs after → must be identical (only app sessions change).

## Decision gate
Phase 3 caching needs an owner call **only if** Phase 0 shows Venice doesn't cache implicitly: Option A (generalize the openai-completions injector, keep Venice) vs Option B (route Claude via Anthropic API — cost + data-routing trade-off). Phases 0–2 deliver most of the win and need no such decision.

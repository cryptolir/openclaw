# OpenClaw — Dev Status

> Claude and Codex read this at session start and update it at session end.
> Repo-root `STATUS.md` is the only live source of truth. Do not use the legacy copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless explicitly asked.

---

## Active Branches / PRs

> Claim your branch here BEFORE editing code (`MULTI_AGENT_PROTOCOL.md` §2).
> One branch = one owner. This table lists **claimed** branches only — for every
> open PR run `gh pr list --repo cryptolir/openclaw-dashboard`.

| Repo               | Branch                            | PR   | Status                                | Owner  | Files / Areas Touched                                                                                                                                                                          | Validation                                            | Next Concrete Step                                                                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------- | ---- | ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openclaw-dashboard | feat/dev-server-platform-only     | #480 | merged bead73f2, deployed v2026.9.2.3 | Claude | lib/servers.ts, app/api/agents/{route,import/route,server-status/route}.ts, agents/new + agents (Import modal) pages, lib/workspace-defaults-sync.ts, docs/TERMINOLOGY.md, lib/servers.test.ts | tsc clean, 1706 tests 0 fail, build exit 0            | owner: GET /api/platform/servers?seed=true once (health cron); openclaw follow-up: add dev to agents_server_diagnostic.sh ALL_HOSTS. Global Host on DevAgents in place (copied from 2ndClaw by owner 2026-09-02, sha prefix f03a0dd62dbd, mode 600) | DevAgents (204.168.223.245) as SERVERS.dev with platformOnly: true; one helper visibleServerIds(isPlatform) read by both pickers and the create/import/server-status routes, so members never see it. readWorkspaceProviderKeys intersects member-visible hosts only (a thin dev Global Host must not shrink every Org's model list). Host prep done: /opt/openclaw cloned at 18d8857, empty.env 444. Follow-up: openclaw diagnostic ALL_HOSTS="eu us" does not cover dev.                                                                                                                                                                                                                                                                           |
| openclaw-dashboard | docs/terminology-core-apis        | #429 | in review                             | Claude | docs/TERMINOLOGY.md, lib/agent-constants.ts, lib/core-package.ts(.test)                                                                                                                        | tsc clean, 1526 tests 0 fail, build exit 0            | owner merge                                                                                                                                                                                                                                         | Owner decision 2026-08-22: names **Core APIs** (six provider keys — dropped WALLET_PRIVATE_KEY, RAIN_API_KEY, HERE_NOW), **Catalog** (MCP + skills), **Global Host** (/opt/openclaw/.env); marks "Core Package" deprecated in place since it covered both. Records the rule that every Global Host carries the same Core APIs, flagged as target-not-current. Reverses the earlier "Q1: RAIN kept" decision.                                                                                                                                                                                                                                                                                                                                         |
| openclaw           | feat/compose-outreach-env         | —    | in review                             | Claude | docker-compose.yml (gateway env allowlist: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_REVIEWS_TOKEN, AIRTABLE_REVIEWS_BASE_ID, OUTREACH_ROLE, HUBSPOT_TOKEN), STATUS.md                        | docker compose config parses; values empty by default | owner merge, then hosts sync main and the Ceyo Agents can be provisioned (dashboard runbook docs/ops/ceyo-phase1-runbook.md)                                                                                                                        | Six per-agent env passthroughs for the Ceyo outreach Phase 1 Agents, same `${X:-}` allowlist rule as GMAIL\_\*. Needed because this compose has no env_file: a key in docker.env reaches the container only if listed here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| openclaw           | fix/diagnostic-host-global-checks | #131 | in review                             | Claude | scripts/ops/agents_server_diagnostic.sh, STATUS.md                                                                                                                                             | bash -n clean; ran --no-write against BOTH live hosts | owner merge, then decide on the 1stClaw containment remediation                                                                                                                                                                                     | **D2 has never run against prod.** It sat after the remote_probe heredoc, so it executed on DevAgents (zero gateway containers → loop body never ran) and its em() lines went to stdout after ISSUES was already built from $TMP → no containment finding has EVER reached bug_list. Moved inside the heredoc, no logic change. Doing so surfaced a live P1: 17/17 1stClaw containers read their own non-empty docker.env (2ndClaw 14/14 clean); compose there DOES carry the shadow line, so it is stale containers, not lost config. New D3 checks the Global Host: mode 600, all Core APIs present, nothing extra (names only, never values). Core APIs list is duplicated from the dashboard repo — no sync, comment says change both in one PR. |

---

## Last Session

- **Date**: 2026-09-01 → 09-02 (dashboard: hermes telegram card line — the surface C deferred and A2 never built; owner: Claude)
- **Repo**: openclaw-dashboard. Four PRs, each squash-merged bound to its reviewed head, each deployed by CI:
  - **#464** `feat(parity)`: the Telegram card on the hermes Config tab, under the A2 YAML editor. Same shape
    as the openclaw card; different write path — token is ENV (`TELEGRAM_BOT_TOKEN`, never config.yaml),
    access is the fail-closed `TELEGRAM_ALLOWED_USERS` allowlist. Reads `/channel-credentials` (token as a
    boolean, never the value), writes `/secrets` (CAS-fenced merge), then `control restart`.
  - **#465** `fix(secrets)`: a blank for a never-masked key is a **clear**, not a masked echo. Found on the
    live walk: the secrets route dropped `""` from every caller except `platform_admin`, so an ordinary Org
    owner emptying the allowlist got a success toast over an env that still authorized the old senders —
    bot open while the UI said nobody. `isMaskedEchoBlank()` in `lib/docker-env.ts` at both drop sites;
    `TELEGRAM_ALLOWED_USERS` joins `READABLE_KEYS` (identity list, already cleartext via
    `/channel-credentials`). Token stays masked — pinned by test. **#467** (other session) then renamed the
    two conflicting `canReveal` flags → `seesUnmaskedValues` / the Org rule; #469 (OB-50) touched the same
    route after — verified #465's fix intact on main.
  - **#468** `fix(parity)`: busy state. Every control is disabled for the whole save+restart, but the only
    indicator was on the Save Token button — a ✕ click mid-restart was swallowed silently (hit it myself).
    Amber `Applying…` pill in the card header + `opacity-50 pointer-events-none` + `aria-busy` on both sections.
  - **#472**: the pill said `~30s`; measured **~130s** twice (re-gate + force-recreate + health wait). Now
    "this can take a minute or two" — no number, it varies by agent.
- **Why the gap existed**: #457 (C) shipped the backend and a one-paragraph note inside `ConfigTab`'s
  capability-gated branch, deferring the card "to A2". #462 (A2) routed hermes to a NEW `HermesConfigTab`,
  so the note stopped rendering and the card was never built. Both green. A deferral in a PR body is
  invisible to CI — re-open the target phase's diff after it merges and grep for the deferred thing.
- **Validation**: typecheck/tests/build clean on every PR (1672 → 1694 tests); `api-map` + `build-support-skill`
  regenerated with no drift (no route changes). **Canary walked on hermes007 (EU) three times, hermi
  untouched**: card reads the real `docker.env`; add `999000111` → `TELEGRAM_ALLOWED_USERS=999000111`
  (sha `4542505e`); remove → `TELEGRAM_ALLOWED_USERS=` (sha `3f50855c`, the hash change IS the #465 proof);
  hermes' own gateway log after restart: "No env user allowlists configured … will deny unknown". All 10
  original keys survived every write. Pill confirmed on screen during a real restart; a click on the
  Open radio mid-save was inert and visibly so.
- **RESOLVED 09-02 (#484)**: that leftover empty `TELEGRAM_ALLOWED_USERS=` line is gone; hermes007's
  `docker.env` is byte-identical to its pre-session baseline (sha `8e75f783`, 10 keys, header intact).
  Removing it exposed a bigger gap — **the dashboard had no delete path for a secret at all**. The ✕
  calls `removeEntry()`, which only drops the row from React state; `saveSecrets()` posts truthy entries
  only, so a removed key is merely ABSENT; and `applySave()` merges, preserving anything the payload does
  not name. Proven on hermes007 first: ✕ + Save returned "Secrets saved. Restart the bot to apply." with
  the file unchanged (sha `3f50855c`, 11 keys, line still there). Third silent no-op of this shape after
  #465 and #468 — a UI reporting a write the route never performed.
  **#484** adds `removeKeys` to the POST, `applyEnvRemovals()` in `docker-env.ts` before the merge
  (comments always survive; removing an absent key is a no-op so two tabs cannot fail each other), and
  fails closed on `WALLET_PRIVATE_KEY` (rotation is fenced in that same route), core keys (refused, with
  a pointer to Reset to default) and the existing `GMAIL_*`/`GCAL_*`/`SALESFORCE_*` reservation.
  1714 pass, typecheck + build clean. Deployed vbuild 518, then used through the UI to do the removal.
  **Note**: hermes007's _running container_ still carries the stale empty var from an earlier restart —
  inert (empty = deny-everyone, and no bot token is set), and it clears on its next restart. Not restarted
  for this; the file is what deploys read.
- **Worktrees**: all four (`wt-hermes-tg`, `wt-tg-clear`, `wt-tg-busy`, `wt-tg-copy`) removed; remote
  branches deleted after verifying MERGED. Nothing of this line remains under `/root/AgentGlob_Apps/`.
- **Next concrete steps** (carried forward from the 08-31 handover, re-verified 09-02):
  1. `HERMES_GA` flip (Phase 6) — still `false` on main; one flag lifts wizard + server gates. **Owner
     decision, never flip unasked.**
  2. Reconcile scheduler job — one `gcloud` command in the key-rotation runbook (owner).
  3. **#444** non-core secrets — OPEN, Rev 9, 8 reviews, untouched since 08-28; Codex out of review
     credits since 08-26. Owner: top up or accept Rev 9, then Phases 1→2→3.
  4. Hermes token streaming — pinned 0.20.4 has no streaming endpoint (measured). New image = register as
     a hermes release, hermes007 first.
  5. Salesforce hermes port (runtime-tools §9).
  6. Cleanup: **#425** (superseded — close), **#426** (re-check), **#432** (owns deletion host cleanup;
     `hrms002` dir still on 2ndClaw) — all still OPEN as of 09-02. `ANTHROPIC_API_KEY` deliberately unseeded.
  7. **#449** Slack channel card still carries `writer-lock` — another session's; hands off.
- **Gotchas added to memory this line**: (a) deferred work dies when its target is rewritten (above);
  (b) a helper's _name_ is not its contract — `canReveal` meant `platform_admin` in one route and
  `canRevealOrgSecrets()` (owner, NOT platform_admin) one file over; I wrote a confident security comment
  off the wrong one and only a platform-admin account made the walk pass. Open the definition in the file
  that calls it. (c) the Chrome `type` action never reached a React-controlled input — `form_input` did.

- **Date**: 2026-08-23 (dashboard: core-key BYOK plan merged by owner call, owner: Claude)
- **Repo**: openclaw-dashboard, branch `plan/core-key-byok`, PR #430 squash-merged as `3995810`
- **What landed**: `docs/plans/core-key-byok.md` ONLY. No implementation code exists for this plan
  anywhere — not on main, not on a branch. The deploy workflow SKIPPED (docs-only path filter);
  nothing runtime changed.
- **How it ended**: 16 Codex rounds, ~40 findings folded. Merged on an explicit owner decision to
  stop the loop, NOT on a clean verdict. A round-17 review may exist that was never folded — treat
  its findings as open and raise them against the implementation PR, which gets its own adversarial
  review per the protocol.
- **Owner decisions recorded in the doc** (do not relitigate):
  - **Decision A** (Rev 8): no ordering protocol for concurrent core-key writes. Per-file CAS plus
    the existing daily reconcile. Same trade as the hermes downgrade machinery.
  - **K1** (Rev 14): a bounded keyless window is ACCEPTED for OPTIONAL core keys only (those with
    no Global Host default). K2 (removal-only fence) declined.
  - **S3** (Rev 15): an Org override replaces an agent-owned value permanently, but never silently —
    the Org SET previews the affected agents and writes only on a confirmation naming them. S1
    (store the displaced credential) and S2 (silent destruction) both declined.
  - **Fences are three, not one** (Rev 4 + Rev 8): issuance (`GMAIL_*`, `GCAL_*` — only the
    feature's own handler may write; Calendar is Org-level with per-agent enablement, NOT
    per-person), billing (`PINNED_BYOK_KEYS` — conditionally admissible via an owner-gated route),
    and plan (feature entitlement under BYOK — a decision surface, not a key list).
- **Next concrete step**: implement Phase 1 (hermes parity: preserve-merge in `buildHermesDockerEnv`,
  descriptor-driven env path, capability flip — WITH the agent-surface owner gate, which cannot be
  deferred to Phase 2). Phase 2 is the Org Core API Keys section PLUS the convergence engine.
  Phase 3 (pinned billing keys) gates on #426.
- **Still open elsewhere**: #426 (venice-byok plan) sits at its own round-4 escalation, unresolved.
  #425 (hermes-credential-policy Revs 12-15) plan-only after the split; its implementation — the
  `HERMES_VENICE_API_KEY` scoping — has never been built.

- **Date**: 2026-08-10 (dashboard: plan-review-verdict logic hardened + merged, owner: Claude)
- **Repo**: openclaw-dashboard (branch docs/review-verdict-fail-closed, squash-merged)
- **What changed**:
  - **PR #306** (`docs(protocol): treat an unsignalled Codex review as no-verdict, not approval`,
    merged `bc44ebe`): closed a hole in `docs/PLAN_REVIEW_PROTOCOL.md` §3/§5 where a Codex app
    review with no inline findings was treated as `approved` — indistinguishable from a review
    that started and never finished, since the app's review body is identical boilerplate either
    way. Verified the app's real approval signal is a content-matched 👍 (`+1`) reaction on the PR
    (`issues/<n>/reactions`), never the review body itself. Rewrote both
    `docs/PLAN_REVIEW_PROTOCOL.md` and the `claude.yml` automation prompt (kept in sync) to: (1)
    require that 👍, bound to the specific review whose `Reviewed commit` stamp is a **prefix** of
    current head (never full-SHA equality — Codex stamps ~10 chars); (2) add an explicit
    `no-clear-verdict` outcome that stops and escalates to the owner with a status report instead
    of resolving ambiguity as approval; (3) give contradictory signals (👍 + unresolved findings)
    priority over folding.
  - **4 rounds of Codex adversarial review folded on the review-logic itself** (Rev 2-5, all on
    PR #306): F1/F2 reaction-to-commit binding + fail-closed stamp parsing; F3 contradictory-signal
    ordering (also caught my own bug: staleness was blocking folding, not just approval — fixed,
    folding can't merge anything so a stale finding is still a finding); F6/F7 a stale command
    block reintroducing F1's exact hole, and a retry that couldn't actually sleep
    (`--allowedTools` had no `sleep`); F8 abbreviated-vs-full SHA comparison — fixing this example
    surfaced the same "equals head" assumption load-bearing in the `claude.yml` prompt itself,
    where literal equality would have made `APPROVED` unreachable forever. Findings per round:
    3 → 2 → 2 → 1, zero P1s in the final round — merged at the round-4 circuit-breaker bound per
    owner decision rather than requesting a 5th.
  - **The `CLAUDE_CODE_OAUTH_TOKEN` outage is FIXED** (owner, 2026-08-08 19:16). Root cause is
    worth keeping: `claude setup-token` prints ANSI colour codes, and a terminal narrower than the
    108-char token wraps it — either one embeds bytes that are illegal in an HTTP header, so
    `claude.yml` died 100ms into every run with `API Error: Header 'Authorization' has invalid
value` from 2026-08-08 09:42. Use `NO_COLOR=1`, widen past 200 columns, and assert length 108
    on one unbroken line. Two traps documented in `claude.yml`'s header: the local CLI **cannot**
    verify a token (with a saved login it ignores the env var entirely, so "works locally" is
    always false), and the real test is curling `api.anthropic.com/v1/messages` — 401 = bad token,
    429 rate_limit = auth OK.
  - **Cost of not re-checking**: a later session in this same conversation kept reporting the loop
    as broken for hours after it was fixed, from one stale timestamp plus reading `skipped` and
    `cancelled` runs as failures. `skipped` is BY DESIGN on non-plan PRs and `cancelled` is the
    concurrency group — `PLAN_REVIEW_PROTOCOL.md` §5 says so explicitly. Re-read the secret's
    `updated_at` and look for `success` before ever calling that lane down.
  - **`claude.yml` re-requests review through a connected identity now** (dashboard PR #318,
    merged `4574170`). Once folding worked, every autonomous fold still ended with a self-written
    `@codex review` that Codex bounced ("create a Codex account and connect to github" — bot
    mentions always are, §5), so the owner re-posted by hand three times on PR #316. `claude.yml`
    now snapshots the PR head, forbids Claude from writing the mention, and re-requests via
    `CODEX_REVIEW_PAT` **only when the head actually moved**. Head unchanged is exactly the
    escalate / no-clear-verdict / circuit-breaker paths, and a closed PR is the approved-and-merged
    path — all explicit no-ops. Also corrected `plan-review-request.yml`, which still told Codex
    the pre-#306 rule that a finding-free review means approved.
  - **`openclaw` PR #112 merged** (`07c55fa`): 45 dead `/root/projects/openclaw*` references fixed
    across 9 files — the real checkout is `/root/AgentGlob_Apps/`. Added the `Active Branches / PRs`
    table `MULTI_AGENT_PROTOCOL.md` §2 tells agents to use but that never existed.
- **Validation**: PR #306: `npx tsc --noEmit` clean on every Rev; `claude.yml` re-validated as
  parseable YAML after every edit; grepped for leftover "EQUALS" after the Rev 5 fix to confirm
  none remained; `terminology` CI check passing pre-merge. Doc-only change, no source touched, so
  build/tests are unaffected.
- **Follow-ups**: the automated lane is **live** — `claude[bot]` folded Rev 3 and Rev 4 on PR #316
  unattended and tripped its own round-4 circuit-breaker correctly. PR #318's re-request step is
  **unproven**: §6 forbids exercising a workflow from a branch, so the real test is the next plan
  PR — if Codex reviews a fold without the owner re-posting, it works. Remaining: this server's
  `~/.bashrc` line 100 still holds a 92-byte non-token value (manual DevAgents fallback only,
  nothing depends on it, but treat that value as burned — it was pasted into a session transcript
  while being diagnosed); a stale `.next/types` cache dated 2026-07-24 in the dashboard checkout
  fails `tsc` on files absent from current branches, so clear it before trusting a red typecheck;
  PR #284 (`plan: AgentGlob MCP`) is a separate session's branch at its own round-4 bound as of
  2026-08-08, untouched here.

## Last Session (prev)

- **Date**: 2026-07-11 (dashboard: team-invite flow SHIPPED — plan #188 + impl #189, owner: Claude)
- **Repo**: openclaw-dashboard (branches plan/team-invite-flow + feat/team-invite-flow, both squash-merged)
- **What changed**:
  - **Plan #188** (docs/plans/team-invite-flow.md, Rev 5): 4 Codex adversarial rounds folded (invite throttles, ?plan/?ref landing, HTML-escape, ref-only test split, sender-scoped quota); owner decision (b) at the round-4 bound.
  - **Impl #189** (merged 0695b52): C1 invite email on genuinely-new member add (pure renderTeamInviteEmail, all fields escaped, recipient invite: throttle + sender invite-sender: quota cooldown0/cap30, response { ok, emailSent }); C2 signInGateAction pure gate — pre-invited NEW users no longer get an auto personal org, so first sign-in lands in the inviter org (root cause of "member can not see agents"); C2b ?plan/?ref landing creates the personal org on demand (planRefLanding); C3 add-member info icon + instructions + emailSent feedback; C4 label-only Members→Team. Impl Codex round 1 folded (I3 guard around the whole invite pipeline). Codex then STALLED (2 manual mentions, no response) — owner chose merge-now.
  - **Rev 6 amendment #190** (merged d9b330b, same day, after owner prod-verified #189 on v2026.7.11.2 — invite email + inviter-org landing both confirmed working): owner reversed the org-suppression half — invited users ALSO keep a personal org like any signup. signInGateAction now ensures an owned org for every allowed non-platform user (idempotent; backfills Rev 5-window invitees on next sign-in); landing determinism moved to pure plainLandingSlug (newest invitedBy!=null membership → inviter org, else owned, else [0]; joinedAt→createdAt fallback + slug tie-break for legacy rows, T14). listUserWorkspaces exposes invitedBy/joinedAt. 2 Codex rounds folded on #190, then CLEAN PASS ("Didn't find any major issues") — Codex was intermittently stalled all session (manual @codex re-mentions needed; anchor poll timestamps with date -u, NOT estimates).
- **Validation**: #189: tsc clean, 296 tests, deploy run 29147449823 SUCCESS → v2026.7.11.2, owner prod-verified. #190: 297 tests green (T14), Codex clean pass, deploy run 29149995529 — verified at session end.
- **Follow-ups**: fresh invitee should sign in again to receive their auto-created personal org (backfill); Codex GitHub connection flaky — reconnect at chatgpt.com/codex/cloud/settings; AGENTS.md §4 still describes a limited "member" role that does not exist in WORKSPACE_CAPABILITIES (admin is near-co-owner) — decide whether to build a viewer role or fix the doc.

## Last Session (prev)

- **Date**: 2026-06-30 (deterministic durable-memory recall LIVE on `life` v2026.06.30.1, after a defective-build incident on v2026.06.27.1)
- **What changed**:
  - **Gateway PR #90** (`feat/app-memory-recall-injection`): fixes QA 4A — a goal saved in one app chat wasn't recalled in a new chat. Root cause (verified): saving works (Graphiti `add_episode` succeeds; a live `search_memory_facts` returns the fact), but recall was **discretionary** — the slim app prompt often skipped `search_memory_facts` at the start of a new chat. New `src/agents/graphiti-recall-client.ts` (read-only `search_memory_facts` over streamable-HTTP MCP, mirrors the graphiti-proxy scope boundary: server-derived `groupId` only, unsafe-id fail-closed, `group_ids:[groupId]`, no caller `group_id`/`group_ids`/`center_node_uuid`) + `src/agents/memory-recall-context.ts` (`appendMemoryRecallBootstrapFile` — group id byte-identical to the `life-memory-scope` hook, ~2.5s timebox + fail-open, **no cross-turn cache** per codex P2) chained after `appendAppProfileBootstrapFile` in `bootstrap-files.ts`. Injects the top facts as a synthetic `MEMORY_RECALL.md` every app turn. Folded a codex review round (P1 scope boundary + P2 stale-cache). 27 vitest; `pnpm check` green.
  - **Gateway image `v2026.06.30.1`** (sourceSha `999c4aee9`): pinned to **`life` only** on 2ndClaw via single-agent recreate. Rollback ref `v2026.06.20.3` (`docker.env.bak.pre-v2026.06.30.1`).
  - **⚠️ INCIDENT — defective build `v2026.06.27.1`** (sourceSha `ed9f2a5c8`): first roll broke **app chat** (Telegram unaffected). The gateway `chat.send` validator rejected the app's `appUserId` param → `502 invalid chat.send params: at root: unexpected property 'appUserId'`. Root cause was NOT code — `src/gateway/` is byte-identical to the good `v2026.06.20.3` source and the schema (`logs-chat.ts` `ChatSendParamsSchema`) declares `appUserId`; the image was a **corrupted/inconsistent build artifact** from `build-and-push.sh`'s Docker layer cache (its compiled validator didn't match the source). Fix: rolled back to `v2026.06.20.3` (restored app immediately), then `docker build --no-cache` from the same `main` → `v2026.06.30.1`, which validates `appUserId` correctly. **My smoke missed it because the test payloads lacked `appUserId` (the real app always sends it).**
  - **`life` `workspace/AGENTS.app.md`**: one-line note in §3 that the top durable facts are pre-injected as `MEMORY_RECALL.md` (lean on it first, `search_memory_facts` only for more). Host-only, effective next turn (`AGENTS.app.md.bak.pre-memory-recall`); source mirrored in `ops/graphiti-life/agents-md-memory-section.md`.
  - **Companion app fix**: `app.havaya` #28 (summary-method parser keeps custom output — QA 4C — + QA-guide doc fixes) merged/auto-deploys via Coolify.
- **Validation**:
  - `pnpm check` green on #90 (tsgo + lint + oxfmt); 27 vitest incl. wire/scope/timebox + hook group-id parity + fail-open + no-stale-cache.
  - Prod smoke on **`v2026.06.30.1`**: boots healthy (gateway `:18789`, graphiti mcp ready: 4 tools, restarts=0). Basic coherence OK. **App path (the regression) verified**: the real payload WITH `appUserId` → `200` (was `502` on the bad build). **Memory-recall E2E confirmed**: a brand-new app session for the QA test user asking "מה המטרה שלי החודש?" replies the saved goal "לבסס שגרת כתיבה יומית" on the FIRST message.
- **Follow-ups**: register release `v2026.06.30.1` (owner/dashboard `POST /api/platform/releases`); **delete the defective `v2026.06.27.1` tag** (registry + hosts) so it can't be rolled; **harden `build-and-push.sh`** (add `--no-cache` or a post-build `appUserId` validation gate — a cached layer produced a bad image from good source); the daily `bug_list` autoscan cron re-drifts `scripts/ops/bug_list.md` under oxfmt 0.33 — make the cron format or ignore it; periodic US-host image prune.

## Last Session (prev)

- **Date**: 2026-06-18 (load_skill app-session tool shipped to prod: v2026.06.18.1; US disk cleanup)
- **What changed**:
  - **Gateway PR #74** (`feat/load-skill-app-sessions`): read-only, name-scoped `load_skill` tool so Havaya app-user sessions (jailed by `tools.fs.workspaceOnly`) can load + apply the live dashboard skills they could previously see but not read. Allowlist = the prompt-limited filtered `resolvedSkills` (no side channel, no drift with the prompt); confined to each matched entry's own `baseDir`; gated on a resolved app user (turn-1-safe via the #71 fallback); 24 KB cap. The app skills prompt is path-free (`load_skill(name)`, no `<location>` leak) and mirrored into compaction. Folded two codex rounds (4519976882 tool-filter/compaction/limits + 4520156223 doc nit). Merged clean (no `--admin`).
  - **Gateway image `v2026.06.18.1`** (sourceSha `09a99e476`): built from `main`, pinned to **`life` only** on 2ndClaw (single-agent recreate). Ships the FULL per-user stack to prod (writer #65/#66 + injection #68 + first-turn #71 + load_skill #74). Rollback ref `v2026.06.17.2` (`docker.env.bak.pre-v2026.06.18.1`).
  - **US-host disk cleanup**: the v2026.06.18.1 pre-pull hit "no space left" (2ndClaw at 97% from gateway-image drift). Freed 22 GB (97% to 67%) by `docker rmi` of 8 unused registry gateway tags — verified unreferenced by any container, all re-pullable from Artifact Registry; in-use tags kept. Recurring: each roll adds ~8.5 GB, so prune unused tags when rolling.
- **Validation**:
  - `pnpm check` green on #74 (tsgo + lint); vitest load-skill 11 + system-prompt.skills 8 + overflow-compaction; oxfmt.
  - Prod smoke: `life` recreated on `v2026.06.18.1`, boots healthy (gateway `:18789`, graphiti mcp ready, telegram up); public-chat smoke returned a coherent in-persona reply.
- **Follow-ups**: optional `AGENTS.md` prose (reinforcing; the system prompt already instructs `load_skill`); register release `v2026.06.18.1` (owner/dashboard); retire the Havaya Drive "embedded" summary method -> load the live `tal-meeting-summary` skill; periodic US-host image prune.

## Last Session (prev)

- **Date**: 2026-06-17 (Per-user profile Phase 3 shipped to prod: app_profile injection + CI gate; **first-turn fix #71** rolled the same day)
- **What changed**:
  - **Gateway PR #68** (`feat/app-profile-context`): inject each app-user's `app_profile` section into the agent context every turn as a synthetic `APP_PROFILE.md` bootstrap file, so `life` always knows the user without being reminded. New `src/agents/app-profile-context.ts` (fail-closed marker extractor, UTF-8 byte-safe 2 KB clamp, app-session-only via `isAppUserSession` + `resolveAppUserId`); 3-line wire in `src/agents/bootstrap-files.ts` (after hook overrides, before the context-file budget clamp; compaction-safe). 14/14 vitest; resolved per-run so no cross-user leak.
  - **Gateway PR #69** (`fix/tsgo-type-errors`): greened the `check` (tsgo + oxlint) and `check-docs` (markdownlint + link-check) CI gates so openclaw PRs stop needing `--admin`. `chat.ts` typed to the real `AssistantContentBlock[]` union (one commented boundary cast, no `any`); 3 test-mock fixes; unused import + 3 redundant type-args dropped; doc lint/link fixes.
  - **Gateway image `v2026.06.17.1`** (sourceSha `50f6c2d6f`): built from `main`, pushed to Artifact Registry, pinned to **`life` only** on 2ndClaw via single-agent recreate (fleet untouched per the staged-boot rule). Rollback ref `v2026.06.13.1` (`docker.env.bak.pre-v2026.06.17.1`).
  - **`life` `workspace/AGENTS.md`**: added the `app_profile` writable section + maintenance rules (sections 4/5) so the agent keeps a concise running brief (`name` / `call_them` / `summary`). Host-only, effective next turn (`AGENTS.md.bak.pre-app-profile-prose`).
  - **Phase 2 (`app.havaya` #24)**: confirmed already auto-deployed on merge (Coolify webhook); the home greeting reads the name from the per-user file.
  - **Gateway PR #71** (`fix/app-profile-first-turn`): the injection missed the FIRST turn of every new session. `appUserId` is read from the persisted session entry, but `chat.send` only writes it onto an EXISTING entry (`updateSessionStoreEntry` no-ops when missing), so a brand-new session's first message ran with no `APP_PROFILE.md` and the agent asked the user's name (every page refresh / new chat hit this; from turn 2 on it worked). Added `appUserIdFromSessionKey()` fallback in `app-profile-context.ts` (derives the id from the session key — second-to-last `:`-segment after `:app:` — when the entry lacks it; read-only, same-user, leaves the shared `resolveAppUserId` / workspace-jail / writer untouched). Also braced this file's guard-returns → repo-wide `pnpm lint` now green (it was the only lint-dirty file). 22/22 vitest; merged without `--admin`.
  - **Gateway image `v2026.06.17.2`** (sourceSha `d4ae21509`): built from `main`, pinned to **`life` only** on 2ndClaw via single-agent recreate (fleet untouched). Rollback ref `v2026.06.17.1` (`docker.env.bak.pre-v2026.06.17.2`).
- **Validation**:
  - `pnpm check` + `pnpm check:docs` green on #69; `app-profile-context` 14/14 vitest; image build compiled clean.
  - Prod smoke: `life` recreated on `v2026.06.17.1`, boots healthy (gateway `:18789`, graphiti mcp ready, telegram up); public-chat smoke returned a coherent in-persona reply. 2 of 4 live user files already carry a seeded `app_profile` `name:` marker.
  - **#71 fix prod-verified**: reproduced the bug (fresh-session first "Hi" → "what's your name?"), then after rolling `v2026.06.17.2` a fresh-session first "Hi" greeted "היי לירן" (by name) without asking; `life` re-verified healthy on `v2026.06.17.2`.
- **Follow-ups**: register releases `v2026.06.17.1` (`50f6c2d6f`) and `v2026.06.17.2` (`d4ae21509`) via the dashboard `/api/platform/releases` (bookkeeping; optional dashboard step, prior rolls skipped it without harm).

## Last Session (prev 2)

- **Date**: 2026-06-01 / 2026-06-02 (Havaya per-user integration — writer + reader + parity)
- **What changed**:
  - **Gateway PR #49** (`feat/save-user-section-tool`): new `save_user_section` agent tool writing allowlisted sections (`User_D_Prompt`, `app_note`) to `workspace/users/<appUserId>.md` with HTML-comment markers and fail-closed upsert. Added `appUserId?: string` to `SessionEntry` (`src/config/sessions/types.ts`), `ChatSendParamsSchema` (`src/gateway/protocol/schema/logs-chat.ts`), and `chat.send` handler (`src/gateway/server-methods/chat.ts`) — persists `appUserId` from the incoming RPC onto the session entry before dispatch so the tool can resolve identity server-side without the model passing a user id. Registered in `src/agents/openclaw-tools.ts` (only when `appUserId` resolves). 9 vitest unit tests (`src/agents/tools/save-user-section.test.ts`).
  - **Dashboard PR #107**: per-user workspace-file reader endpoint `GET /api/public/chat/[agentName]/user-file?userId=&section=`. Single module `lib/user-file-core.ts` (pure helpers + DI orchestrator). Route glue: timing-safe app-key auth (`AGENTGLOB_APP_API_KEY`), SSH stat-first + read via `lib/ssh-client.ts`, in-memory TTL cache, per-key rate limit, ETag/304/Vary validation. 30 unit tests (node:test). Section allowlist: `User_D_Prompt`, `app_note`.
  - **Dashboard PR #108**: threads `appUserId` from the public chat POST body through `chatSendAndWait` into gateway `chat.send` params (`lib/gateway-client.ts` + `app/api/public/chat/[agentName]/route.ts`).
  - **Dashboard PR #110**: parity — `chatSendStream` and the `/stream` route also forward `appUserId` (prevents silent identity drop if a consumer switches to the streaming/voice UI).
  - **Gateway image `v2026.06.01.1`**: built from `origin/main` (SHA `ef5cdc992`) via fresh detached worktree (skipped dirty main checkout). Deployed to **`life` only** on 2ndClaw; all other agents remain on `v2026.05.24.x`.
  - **`life` `workspace/AGENTS.md`**: added **App Profile Sections (Havaya web app)** guidance block (backup at `AGENTS.md.bak.20260601`). No redeploy needed — read on next agent turn.
  - **Docs PRs**: openclaw #51 (`docs/tools/save-user-section.md` + `docs.json` nav); openclaw-dashboard #109 (as-built + plan SHIPPED banner); app.havaya #3 (consumer), #4 (as-built status), #6 (key redaction).
  - **Security remediation**: a parallel-session PR committed the live `AGENTGLOB_APP_API_KEY` in plaintext. Key rotated on both the dashboard (Cloud Run) and Havaya (Coolify). Havaya `main` history rewritten (narrow 2-commit filter-branch); `feat/ui-tweaks` rebased onto clean main. All repos verified 0 reachable key occurrences.
- **Validation**:
  - Gateway: `pnpm check` (tsgo + oxfmt + oxlint) — pre-existing red CI (format drift + unrelated test errors); admin-merged per owner decision. `save-user-section.test.ts` 9/9 vitest pass.
  - Dashboard: `npx tsc --noEmit` clean; `npm run build` exit 0 for PRs #107, #108, #110.
  - Runtime smoke (prod): `GET /api/public/chat/life/user-file` — no key→401, valid key + missing file→404, non-allowlist→404, wrong key→401 ✅. Real user write confirmed: `users/user_3erjup5l2qciurikq1buqtxlglj.md` written by the `life` agent with correct marker format. Post-rotation smoke: old key→401, new key→200 ✅.

---

## Last Session (prev 2)

- **Date**: 2026-05-12 (projectmanager wallet chat access)
- **What changed**:
  - Gateway branch `codex/fix-wallet-chat-access`: added `skills/wallet/SKILL.md` so deployed agents can use the AgentGlob wallet runtime from chat.
  - Dashboard branch `codex/fix-wallet-chat-access`: deploy now syncs selected/platform-native skills on every redeploy, not only first bootstrap; Wallet tab now warns that redeploy is required for chat access after setting/replacing the key.
  - Built and deployed gateway tag `v2026.05.12.1` from SHA `4f88a87d5`; rollout completed on 1stClaw (14/14) and 2ndClaw (13/13).
  - Live repair completed for `projectmanager` on 2ndClaw: `AGENTGLOB_RUNTIME_URL`, `AGENTGLOB_RUNTIME_TOKEN`, and `workspace/skills/wallet/SKILL.md` are present, and only `projectmanager` was recreated after the env/skill repair.
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`
  - Dashboard Cloud Run deploy: GitHub Actions run `25730530962` completed successfully for SHA `a2e7867`
  - Gateway: `pnpm build`, `pnpm check:docs`, `/opt/openclaw-ops/scripts/build-and-push.sh v2026.05.12.1`, `/opt/openclaw-ops/scripts/deploy.sh v2026.05.12.1`
  - Runtime: `projectmanager` wallet balance endpoint returned HTTP 200 on Ethereum, Arbitrum, Polygon, and Base; Arbitrum balance returned `0.000561686456576002 ETH`, other native balances returned `0`.

---

## Last Session (prev)

- **Date**: 2026-05-05 (handover note)
- **What changed**:
  - Added repo-root `HANDOVER.md` as the front-door handoff note for future Claude/Codex sessions
  - The note includes SSH instructions, required files to read before starting, branch/PR protocol, dashboard and gateway deploy protocols, relevant NVIDIA/model files, runtime paths, smoke tests, and the end-of-session checklist
- **Validation**:
  - Documentation-only change; reviewed rendered markdown content on DevAgents

---

## Last Session (prev)

- **Date**: 2026-05-04 (Jojo PM NVIDIA fallback hotfix)
- **What changed**:
  - **Jojo PM / projectmanager (2ndClaw)**: repaired existing config by adding the dashboard-supported NVIDIA model definitions, changing primary back to `nvidia/z-ai/glm-5.1`, and placing `venice/claude-opus-4-6` first in fallbacks
  - **Dashboard PR #62** (`hotfix/nvidia-existing-agent-models`): backfills NVIDIA model definitions on existing-agent config saves, normalizes the old GLM runtime id, and retries public chat on Claude Opus 4.6 when a selected NVIDIA model fails
  - **Dashboard PR #63** (`hotfix/public-chat-default-fallback`): extends the public-chat Claude fallback retry to stale/no-explicit-model clients when the gateway default NVIDIA model fails
  - **Production deploys**: CI/CD deployed Cloud Run revisions `openclaw-dashboard-00238-4s6` and `openclaw-dashboard-00239-bl9`; latest tag `v2026.5.4.2`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`, GitHub Actions runs `25341349408` and `25344858302`
  - Runtime: Jojo PM selected DeepSeek-R1 public chat returned `jojo-deepseek-fallback-live-ok` via fallback; Jojo PM no-explicit-model public chat returned `jojo-default-fallback-live-ok`

---

## Last Session (prev 2)

- **Date**: 2026-05-03 (dashboard NVIDIA public-chat hotfix)
- **What changed**:
  - **Dashboard PR #61** (`hotfix/nvidia-designer-chat`): fixed the agent config dropdown/landing-page model split, registered the requested NVIDIA models in generated `openclaw.json`, corrected NVIDIA GLM-5 runtime id to `nvidia/z-ai/glm-5.1` while displaying `GLM-5`, sent the selected landing-page model through public chat, limited public Venice choices to the requested set, and sanitized invalid `channels.defaults`/`accessMode`/`groupEnabled` fields before saving configs
  - **Gateway PR #10** (`hotfix/nvidia-compose-env`): passed `NVIDIA_API_KEY` into gateway/CLI containers and documented it in `.env.example`
  - **Runtime repair**: migrated the existing Jojo/projectmanager NVIDIA secret from legacy `NVIDIA` to `NVIDIA_API_KEY` on both prod servers, repaired `designer` config, added the NVIDIA model provider definitions, applied the compose env passthrough on EU/US, and restarted `designer`
  - **Production deploy**: CI/CD deployed Cloud Run revision `openclaw-dashboard-00237-6tr` (100% traffic) and pushed tag `v2026.5.3.2`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`, GitHub Actions run `25282456664`
  - Runtime: `https://app.agentglob.com/api/public/chat/designer/models` returns NVIDIA-first model list; selected-model public chat smoke test returned `deployed-ok`; login returned `HTTP/2 200`

---

## Last Session (prev 3)

- **Date**: 2026-05-03 (dashboard NVIDIA model defaults)
- **What changed**:
  - **Dashboard PR #60** (`feat/nvidia-model-management`): added `NVIDIA_API_KEY` as a core API key, defaulted new agent configs to NVIDIA GLM-5.1 with Venice Claude Opus 4.6 fallback, narrowed the model picker to the requested NVIDIA/Venice model set, added model-picker help text, and bootstrapped NVIDIA auth profiles during deploy; PR #61 later corrected the runtime ID to `nvidia/z-ai/glm-5.1`
  - **Production deploy**: CI/CD deployed Cloud Run revision `openclaw-dashboard-00236-fxz` (100% traffic) and pushed tag `v2026.5.3.1`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`, GitHub Actions run `25273177168`
  - Runtime: `https://app.agentglob.com/login` returned `HTTP/2 200`

---

## Last Session (prev 4)

- **Date**: 2026-04-30 (dashboard GitHub MCP hotfix)
- **What changed**:
  - **vcode1bot (2ndclaw)**: fixed Telegram outage by removing the Docker-based `github` MCP entry that was crash-looping the gateway with `spawn docker EACCES`; `filesystem` and `brave-search` remain active
  - **Dashboard PR #59** (`hotfix/github-mcp-dashboard`): added a safe GitHub MCP quick setup preset, blocks Docker MCP commands, rejects token-looking args, installs the official GitHub MCP binary for agents, and maps saved `GITHUB_TOKEN` to `GITHUB_PERSONAL_ACCESS_TOKEN`
  - **Production deploy**: manually deployed hotfix to Cloud Run revision `openclaw-dashboard-00234-xh7` (100% traffic), then squash-merged PR #59 back to `main` and pushed tag `v2026.4.30.hotfix-github-mcp.1`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`
  - Runtime: `vcode1bot-openclaw-gateway-1` stayed `Up`; `https://app.agentglob.com/login` returned `HTTP/2 200`

---

## Last Session (prev 4)

- **Date**: 2026-04-20 (vcode1bot coding upgrade)
- **What changed**:
  - **vcode1bot (2ndclaw)**: upgraded to `venice/qwen3-coder-480b-a35b-instruct-turbo` (primary), added `filesystem` MCP (workspace r/w) and `brave-search` MCP (web search), added coding soul
  - **Dashboard PR #57** (`feat/coding-capability-template`): config template now uses coding model + MCP servers when `coding=true` capability flag is set — open for review/merge
  - Dashboard PR #53 `fix/control-deploy-infra` confirmed merged (commit `fix(agents): robust restart...` on main)

---

## Last Session (prev 4)

- **Date**: 2026-04-16 (CI runner fix)
- **What changed**:
  - **CI fix**: replaced Blacksmith third-party runners (`blacksmith-16vcpu-*`) with GitHub-hosted runners (`ubuntu-24.04`, `windows-latest`) across all 8 workflow files — Blacksmith integration was broken, leaving every workflow stuck in `queued` for 23+ hours
  - arm64 Docker build now uses QEMU emulation via `docker/setup-qemu-action` instead of a native arm runner
  - Added memory rule: always ask before integrating third-party CI/CD services
  - (prior in this session) Fixed Telegram group access, added `latest` GHCR tags, `deploy.sh` image-overwrite warning
- **Sync state**: re-check `STATUS.md` before creating a branch; one branch = one owner

---

## Currently In Progress

- Codex owns `openclaw` branch `codex/feat-rain-agent-skills` / PR #19 for the Rain skill scaffold. Scope: `skills/rain/SKILL.md`, `STATUS.md`. This intentionally avoids dashboard wallet/RPC files while Claude owns the AgentGlob wallet integration.
- Claude owns `openclaw` branch `feat/rain-skill-split` for the Rain skill rewrite + create-market split per the plan in `docs/plans/rain-skill-rewrite.md` (merged via PR #44). Scope: `skills/rain/SKILL.md` (expanded — adds portfolio, analytics, trade-history, utility, diagnostics sections; removes create-market flow), `skills/rain-create/SKILL.md` (new), `STATUS.md`. No code or MCP changes.
- Claude owns `openclaw` branch `fix/skills-bundled-empty-env-fallback` — small follow-up to PR #47 fixing the `buildEnvOr` empty-string handling so `OPENCLAW_IMAGE_*` env vars default to `"unknown"` when the build-arg is unset (Dockerfile defaults to `""`, and `??` doesn't fall back on `""`). Scope: `src/gateway/routes/skills-bundled.ts`, `src/gateway/routes/skills-bundled.test.ts`, `STATUS.md`.
- Ops change applied on DevAgents (2026-05-24): `/opt/openclaw-ops/scripts/build-and-push.sh` now passes `--build-arg OPENCLAW_IMAGE_TAG="${TAG}"` and `--build-arg OPENCLAW_SOURCE_SHA="${SOURCE_SHA}"`. Backup at `build-and-push.sh.bak.<ts>`. `OPENCLAW_IMAGE_SHA` intentionally not passed — the registry digest isn't known inside a single-pass `docker build` (per Codex's nuance note on PR #47); release-record join in Phase 3 will populate it. Until then the gateway reports `"imageSha": "unknown"`.

---

## Next Up

1. Take control of the AgentGlob repo

> Full roadmap → [ROADMAP.md](ROADMAP.md)

---

## Blockers / Open Questions

- Gateway: Venice model discovery still times out during startup and falls back to the static catalog
- CI: arm64 Docker builds now use QEMU emulation (slower than native) — if build times are a problem, consider GitHub's `ubuntu-24.04-arm` runner (requires Team/Enterprise plan)
- Coordination: confirm ownership before touching any branch or file area the other agent is actively editing
- Branch hygiene: `chore/staging-deploy-gcp` is still listed as open and stale; verify before reuse or cleanup

---

## Active Branches / PRs

| Repo               | Branch                              | PR  | Status          | Owner   | Files / Areas Touched                                                                                               | Validation             | Next Concrete Step                                             | Notes                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------- | --- | --------------- | ------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openclaw-dashboard | codex/feat-widget-chat-v1           | #52 | merged+deployed | Codex   | Widget Chat V1 (widget tab, chat API/UI)                                                                            | npm run build + CI     | Monitor production behavior                                    | Merged to main; Cloud Run deploy run 24422489602 succeeded                                                                                                                                                              |
| openclaw-dashboard | codex/fix-port-allocation-drift     | #55 | merged+deployed | Codex   | agent creation, port allocation                                                                                     | npm run build + CI     | Monitor new-agent deploy behavior                              | skips ports already claimed in live server state before allocation                                                                                                                                                      |
| openclaw-dashboard | codex/fix-deploy-port-repair        | #56 | merged+deployed | Codex   | deploy route, port reservation repair                                                                               | npm run build + CI     | Monitor first-deploy conflict recovery                         | auto-repairs stale reserved ports for never-deployed agents                                                                                                                                                             |
| openclaw-dashboard | feat/ci-cd-pipeline                 | #51 | merged          | Claude  | GitHub Actions, Cloud Run pipeline                                                                                  | merged                 | None                                                           | CI/CD auto-deploy live                                                                                                                                                                                                  |
| openclaw           | fix/deploy-and-control-infra        | #7  | merged          | Claude  | docker-compose.yml                                                                                                  | n/a                    | None                                                           | Adds OPENCLAW_SKIP_BROWSER_CONTROL_SERVER env passthrough; merged Apr 15                                                                                                                                                |
| openclaw-dashboard | fix/control-deploy-infra            | #53 | merged          | Claude  | control, logs, deploy routes                                                                                        | merged                 | None                                                           | Merged Apr 20                                                                                                                                                                                                           |
| openclaw-dashboard | feat/coding-capability-template     | #57 | merged+deployed | Claude  | lib/agent-config-template.ts                                                                                        | npm run build + CI     | None                                                           | Merged Apr 20; coding=true previously used qwen3-coder + filesystem + brave-search MCPs                                                                                                                                 |
| openclaw-dashboard | hotfix/github-mcp-dashboard         | #59 | merged+deployed | Codex   | Tools MCP UI, MCP API route                                                                                         | tsc + npm build        | Rotate leaked GitHub PAT; monitor setup                        | Prod revision `openclaw-dashboard-00234-xh7`; tag `v2026.4.30.hotfix-github-mcp.1`                                                                                                                                      |
| openclaw-dashboard | feat/nvidia-model-management        | #60 | merged+deployed | Codex   | model config, secrets UI, deploy route                                                                              | tsc + npm build        | Superseded by #61 runtime-id hotfix                            | Prod revision `openclaw-dashboard-00236-fxz`; tag `v2026.5.3.1`; initial default corrected to `nvidia/z-ai/glm-5.1` by #61                                                                                              |
| openclaw-dashboard | hotfix/nvidia-designer-chat         | #61 | merged+deployed | Codex   | public chat models, config template                                                                                 | tsc + npm build        | Monitor designer/GLM-5 landing behavior                        | Prod revision `openclaw-dashboard-00237-6tr`; tag `v2026.5.3.2`; default `nvidia/z-ai/glm-5.1`                                                                                                                          |
| openclaw-dashboard | hotfix/nvidia-existing-agent-models | #62 | merged+deployed | Codex   | config save, public chat fallback                                                                                   | tsc + npm build        | Monitor Jojo PM fallback behavior                              | Prod revision `openclaw-dashboard-00238-4s6`; tag `v2026.5.4.1`; backfills existing configs                                                                                                                             |
| openclaw-dashboard | hotfix/public-chat-default-fallback | #63 | merged+deployed | Codex   | public chat fallback                                                                                                | tsc                    | Monitor stale/no-model clients                                 | Prod revision `openclaw-dashboard-00239-bl9`; tag `v2026.5.4.2`; default NVIDIA failures retry Claude                                                                                                                   |
| openclaw           | hotfix/nvidia-compose-env           | #10 | merged          | Codex   | docker-compose.yml, .env.example                                                                                    | runtime smoke          | Include in next gateway image deploy                           | Runtime compose file patched on EU/US so containers receive `NVIDIA_API_KEY`                                                                                                                                            |
| openclaw           | codex/feat-rain-agent-skills        | #19 | open            | Codex   | skills/rain/SKILL.md, STATUS.md                                                                                     | tests + format         | Review PR #19; merge after wallet/RPC path is ready if desired | Depends on AgentGlob wallet runtime/Alchemy RPC work for wallet-backed execution; no dashboard wallet files touched                                                                                                     |
| openclaw           | feat/rain-skill-split               | TBD | in progress     | Claude  | skills/rain/SKILL.md, skills/rain-create/SKILL.md, STATUS.md                                                        | docs-only              | Open PR, request Codex review                                  | Implements plan from PR #44 (`docs/plans/rain-skill-rewrite.md`). No code changes. Wallet-level create-market gate is a separate follow-up.                                                                             |
| openclaw           | feat/skill-registry-manifest        | TBD | in progress     | Claude  | scripts/generate-skills-manifest.ts, src/gateway/routes/skills-bundled.ts, skills/manifest.json, Dockerfile, ci.yml | pnpm build + pnpm test | Open PR                                                        | Phase 1 worker side of canonical skill registry plan (PR #46 / SHA 8686c48df). Adds manifest generator, bundled endpoints, pre-commit hook, CI check. Dashboard side is a separate PR (feat/skill-registry-install-ui). |
| unknown            | chore/staging-deploy-gcp            | #1  | open, stale     | unknown | GCP deploy workflow                                                                                                 | unknown                | Verify ownership before reuse or cleanup                       | Treat as active until verified                                                                                                                                                                                          |

---

## Validation Commands

- Gateway: `cd /root/AgentGlob_Apps/openclaw && pnpm install && pnpm build && pnpm test && pnpm check`
- Dashboard: `cd /root/AgentGlob_Apps/openclaw-dashboard && npm run build`

---

## Deploy Rules

- Dashboard: normal path is merge to `main`; no routine manual deploys
- Gateway/runtime: run from DevAgents with `/opt/openclaw-ops/scripts/build-and-push.sh <tag>` then `/opt/openclaw-ops/scripts/deploy.sh <tag>`
- `deploy.sh` warns when overwriting a running agent's image with a different tag — review the warning before confirming

---

## Quick Reminders

- **DevAgents**: `204.168.223.245` — dev server (repos, builds, deploy orchestration)
- EU prod (1stClaw): `89.167.70.46` — 12 agents
- US standby (2ndClaw): `5.161.84.219` — 4 agents
- Gateway repo on DevAgents: `/root/AgentGlob_Apps/openclaw`
- Dashboard repo on DevAgents: `/root/AgentGlob_Apps/openclaw-dashboard`
- Dashboard prod URL: `https://app.agentglob.com`
- Always resolve agent server from Firestore before SSH/RPC — never hardcode EU
- Always use `getAllDashboardOrigins()` not `getDashboardOrigin()` for allowedOrigins
- Canonical terms: Agent = full deployment, Bot = channel inside Agent, Org = dashboard unit, Workspace = per-Agent local dir on Hetzner

---

## Recovered session history (2026-08-26 → 2026-08-30)

These entries were written during the sessions that shipped
openclaw-dashboard#451–openclaw-dashboard#457 but were never committed. They sat
as an uncommitted `STATUS.md` edit on the DevAgents checkout and were parked in a
stash on 2026-09-01 to unblock the `v2026.9.1.1` build. Recovered here as history
— the newer `Last Session` block above is left untouched, so this section is
deliberately older than the top of the file.

PR numbers are qualified as `openclaw-dashboard#NNN`. This repo tops out at about
`#143`, so a bare `#451` here would render as a dead link to a gateway PR that
does not exist.

- **Date**: 2026-08-26 (dashboard: core-key parity + non-core secrets sweep, owner: Claude)
- **Merged today**: openclaw-dashboard#388 (per-agent-only key fence, by shape), openclaw-dashboard#438 (hermes core-key parity D1/D2 + owner gate, core-key-byok Phase 1), openclaw-dashboard#443 (ANTHROPIC_API_KEY joins the Core API list — owner chose to keep the host value EMPTY, slot exists, no key seeded), openclaw-dashboard#444's Phase 0 unblocked by openclaw-dashboard#388.
- **In review**: openclaw-dashboard#444 (plan: non-core secrets — fence, host cleanup, fleet migration). 7 Codex rounds folded (Rev 8 at head 21321fe), converged 4→3→3→2→1→4→1 with an owner-directed Rev 7 simplification (no digest store; strip-before-cleanup; host-file-only stateless daily scan). Standing owner authorization: fold to clean, escalate only on new obligations/divergence/approval. BLOCKED at round 8 on Codex usage limits — hourly re-request retries armed.
- **Owner rulings recorded on openclaw-dashboard#444**: fence provision-agent.sh in the gateway repo (Phase 1 deliverable); natural restarts (no forced wave); no durable convergence store (ephemeral in-run verification + stateless daily scan); deliberate re-adds out of scope.
- **Superseded direction**: openclaw-dashboard#425's C15 per-runtime HERMES_VENICE_API_KEY rename — owner reviewed and rejected the per-runtime axis (2026-08-24): single shared core keys + provider-side caps + per-agent isolation (quarantine/BYOK) instead. openclaw-dashboard#425 still open and needs a superseding Rev or closure.
- **Still open**: openclaw-dashboard#426 (venice-byok plan, round-4 escalation unresolved); openclaw-dashboard#444 implementation Phases 1-3 after approval; ANTHROPIC_API_KEY host seeding deliberately deferred (owner keeps it empty for now).

### Previous session

## 2026-08-28 — default model fixed, parity plan merged, round-8/round-6 folds, A1a shipped (Claude session)

- **openclaw-dashboard#451 MERGED**: platform default -> `nvidia/nemotron-3.5-lightning` (PAID, $0.10/$0.25 per M). Owner decision: the :free ultra shipped in openclaw-dashboard#448 is account-metered by OpenRouter (50 req/day fleet-wide, measured exhausted same day). Serving verified by live completion BEFORE merge this time. The :free ref stays catalog-resolvable + public-chat-accepted (never advertised) until redeploys rewrite 2026-08-27 primaries. hermi NOT redeployed (only live hermes agent — owner OK needed).
- **openclaw-dashboard#404 MERGED at Rev 15** (round 6 = 1 finding, folded: openclaw no-selection public sends actively reset to the configured primary — never skip /model; OD-3 marked superseded by openclaw-dashboard#451). Owner decision recorded on the PR. Build order live: **A1a -> A0+P18 -> E -> A3/A4 -> C -> D -> A2**.
- **openclaw-dashboard#444 Rev 9 pushed** (hand-written; bot fold run had crashed): final pass matches name+VALUE via host values read into process memory before cleanup (R8-F1), and verifies + recreates LIVE containers, not just files (R8-F2). Both threads resolved; writer-lock released; round 9 auto-triggers under the standing round-7+ authorization.
- **openclaw-dashboard#452 OPEN (A1a)**: hermes secrets with no per-agent env file refuse 400 — never GLOBAL_ENV_PATH (P7), one decision point `resolveSecretsEnvPath()` + the owed §4 missing-file test. CI running; awaiting owner merge word.
- Hosting note: EU (1stClaw) has ZERO hermes containers — provision-hermes-host.sh (§8.4) is the gap before hermes can deploy there. US (2ndClaw) runs the sole hermes agent hermi.

### 2026-08-28 later — hermi redeploy ATTEMPTED, ROLLED BACK: the OpenRouter account is out of credits

- **openclaw-dashboard#452 MERGED** (A1a / P7). Main = 789b572.
- **hermi redeploy: config path VERIFIED, model call FAILED, rolled back.** New config.yaml (`provider: openrouter`, `model: nvidia/nemotron-3.5-lightning`, no base_url) wrote cleanly and hermes routed to it exactly as designed (`runtime: {provider: openrouter, model: nvidia/nemotron-3.5-lightning, route_source: global}`). The CHAT then returned HTTP 402: "requires more credits... requested up to 65536 tokens, can only afford 58512".
- **ROOT CAUSE — the OpenRouter account has no credit left**: `/api/v1/credits` = total_credits 5, total_usage 5.1415. This single fact explains BOTH failures: `:free` refs hit the 50/day free-tier cap (lifts only with credits), and PAID refs 402 because OpenRouter pre-authorizes the FULL max_tokens and hermes requests 65536.
- **Verification lesson (my error, twice): a max_tokens=20 curl proves the MODEL serves, not that the ACCOUNT can fund a real agent request.** Verify at the workload's real max_tokens.
- **ROLLED BACK**: hermi restored to `claude-sonnet-5` / `provider: custom` / Venice base_url (backup `/root/.hermes/agents/hermi/backups/config.yaml.2026-08-28.bak`, sha e8b047434448cf46 — byte-identical restore), container recreated, **verified serving** (200, "SERVING"), secrets containment intact.
- **VENICE IS HEALTHY**: balance DIEM 12.478 (USD ~0 — DIEM is what pays); `claude-sonnet-5` AND `deepseek-v4-flash` both serve at max_tokens 65536.
- **LIVE ISSUE**: openclaw-dashboard#451 is merged+deployed, so every NEW agent deploy (both runtimes) now injects an OpenRouter default that 402s. Fix = revert default to `venice/deepseek-v4-flash` (pre-#448, verified serving) OR fund OpenRouter. OWNER DECISION PENDING.
- **openclaw-dashboard#453 MERGED — platform default reverted to Venice.** `PLATFORM_DEFAULT_MODEL` = `venice/deepseek-v4-flash`; hermes back to `claude-sonnet-5` / `provider: custom` / Venice base_url. `buildConfig()` output is byte-identical to hermi's live verified-serving config (sha e8b047434448cf46), so hermi needs NO redeploy — it already matches. Both nemotron refs stay defined+accepted (nothing pinned to them breaks) but are advertised nowhere. No agent was deployed in the broken window (12:02–13:0xZ) — nothing to repair.
- **New regression pin** (`lib/default-model-coherence.test.ts`): the forced default may not be an `openrouter` ref; the failure message names the check (`/api/v1/credits`) and the workload size (`max_tokens 65536`) that a token-sized probe missed twice. Deliberately editable — fund the account, verify at 65536, update the test in the same PR.
- **To re-enable OpenRouter later**: add credits, then a $5 balance also lifts `:free` refs to 1000 req/day, making the owner's original free-Nemotron choice viable.

### 2026-08-30 — openclaw-dashboard#454 (A0+P18) and openclaw-dashboard#455 (E) merged; EU provisioning re-measured (Claude session)

- **openclaw-dashboard#454 MERGED (A0+P18)**: fleet-global name claim in createAgent's transaction (covers create+import), owner-checked release in deleteAgent, all 11 public first-match lookups replaced with the shared resolver (ambiguous name -> 409), user-file routes refuse non-openclaw agents at all FOUR handler entry points before any SSH.
- **openclaw-dashboard#455 MERGED (E)**: releases runtime-scoped (legacy docs read as openclaw); stable unique PER runtime; promoteRelease is one transaction archiving same-runtime priors only; per-agent upgrade route descriptor-driven (imageEnvVar, dockerEnvPath, composePrefix, per-runtime health probe) with P10 checks at both resolution points; pull moved BEFORE the env write (a failed pull used to leave docker.env poisoned); **platform fleet walk gained the runtime filter it was missing — it was live-eligible to "upgrade" hermi with openclaw machinery**; upgrade flips hermes:true (gate+row kept, P21). A hermes upgrade 404s until a hermes release is registered (register route now takes runtime + explicit image for hermes).
- **EU (1stClaw) provisioning CORRECTION**: earlier session claim "EU was never hermes-provisioned" was WRONG. Measured 2026-08-30: /opt/hermes/docker-compose.yml present since Aug 20 AND hermes-agent:v1 image present. Host compose vs script: **functionally byte-identical; header comments only** differ (both hosts predate a comment-only script rewording). EU merely has zero hermes agents (/root/.hermes absent — created on first deploy). Remaining EU step: deploy a scratch hermes agent via the dashboard (owner action or owner OK); optional: re-run provision-hermes-host.sh on both hosts to sync the comment header.

### 2026-08-30 later — hermes007 EU canary verified; A3/A4 shipped (openclaw-dashboard#456)

- **hermes007 deployed by owner on 1stClaw (EU), verified end-to-end**: container up (hermes-agent:v1); config byte-identical to hermi's verified pin (sha e8b0474344); real chat 200/"SERVING" via claude-sonnet-5/Venice; NO env file visible anywhere in the container (allowlisted interpolation only); zero openclaw-dashboard#388-fenced keys in the agent env; ANTHROPIC_API_KEY present-but-empty in the container via compose default (flows automatically once the host key is seeded + redeploy). First hermes agent serving from EU; hermi is no longer a fleet of one.
- **openclaw-dashboard#456 MERGED (A3+A4)**: descriptor soulPath (openclaw workspace/SOUL.md; hermes home-root SOUL.md, in-mount); soul GET/POST + supercharge write + backup read all descriptor-driven; oracle consult + cooldown untouched; soul writes chown 1000:1000. Backup keeps the four-file projection (P8) with comment-stripped source pins (four addFile calls; addLocalFolder/tar/find/sessions can never enter the route unnoticed). soul + backup flip hermes:true, gates + rows kept (P21). 1616 tests.
- Parity order state: A1a ✓ (openclaw-dashboard#452) → A0+P18 ✓ (openclaw-dashboard#454) → E ✓ (openclaw-dashboard#455) → **A3/A4 ✓ (openclaw-dashboard#456)** → next C (telegram, openclaw-dashboard#337 Phase 5) → D (public chat) → A2 (config; still blocked on openclaw-dashboard#419 implementation).
- Verification owed on the canary: owner saves a soul via the dashboard tab on hermes007 → check /root/.hermes/agents/hermes007/home/SOUL.md exists, uid 1000; download a backup → confirm 4 files, masked env, no sessions.

### 2026-08-30 later — C shipped (openclaw-dashboard#457): hermes telegram channel

- **openclaw-dashboard#457 MERGED (C)**: measured from pinned hermes source — TELEGRAM_BOT_TOKEN is ENV (never config.yaml; custody rule), TELEGRAM_ALLOWED_USERS is a fail-closed CSV allowlist (empty=deny, \*=all). Both ride the per-agent docker.env via the Secrets tab. provision-hermes-host.sh gains the two compose passthrough vars (class d). channel-credentials answers hermes from the per-agent env (ids + tokenSet boolean, value never leaves host); pairing/resend/admins refuse hermes explicitly before SSH. telegram flips hermes:true; coupling test pins flip↔compose. Named deviation: the Phase-0 "token via hermes config" guess was wrong — measured env mechanism used instead.
- **PENDING OWNER OK (class d, §8.4)**: re-run provision-hermes-host.sh on 1stClaw + 2ndClaw so the vars reach containers. Both hosts' compose pre-backed-up as /opt/hermes/docker-compose.yml.pre-telegram.bak (sha 1654f8385940 both). Until re-run, the flip is honest-but-inert. Existing containers unaffected until their next recreate.
- Parity order: A1a ✓ → A0+P18 ✓ → E ✓ → A3/A4 ✓ → **C ✓ (openclaw-dashboard#457)** → D (public chat) → A2 (config, blocked on openclaw-dashboard#419 impl).
- **PROVISIONED (owner OK 2026-08-30)**: provision-hermes-host.sh re-run on BOTH hosts. Compose files now identical (sha cecf67df634cb5cd), both carry the two telegram passthrough vars, dry `docker compose config` parses and interpolates cleanly (empty values until keys are set). Live agents untouched (hermes007, hermi). Backups remain at /opt/hermes/docker-compose.yml.pre-telegram.bak on both hosts. Hermes telegram is now fully live end to end: Secrets tab (2 keys) + restart = bot online, deny-by-default.

### 2026-08-30 later — D shipped (openclaw-dashboard#458) and LIVE-VERIFIED: hermes public chat works

- **openclaw-dashboard#458 MERGED (D)**: every public chat op (send buffered+SSE, abort, threads, history, models, authenticateMember) dispatches via publicChatTarget -> runtime descriptor with the Invariant-2 credential. Model policy in resolveModelSwitch: hermes NEVER gets /model (C4 discard; models route advertises only config.yaml's default); openclaw keeps F5b + gains the Rev 15 OD-2 active reset (no selection -> configured primary via the same reader the models route uses). P14: hermes attachments 400 explicitly. P15/P22 scan test walks app/api/public and fails on unclassified routes (20 classified: 6 dispatch / 3 refuse / 2 guarded-shared / 5 store-only / 4 agentless); bot-member-gateway-sync RPC helpers carry runtime guards. authenticateMember also lost its first-match lookup (the P18 straggler openclaw-dashboard#454's route-only sweep missed). public-chat flips hermes:true. NAMED DEVIATION: hermes chatStream = single final delta (pinned hermes API has no chat streaming endpoint); token-level SSE follow-up needs live delta fixtures.
- **LIVE-VERIFIED on production (app.agentglob.com, hermes007/EU)**: agent card 200; models route = single "claude-sonnet-5"; chat WITH body.model=claude-opus-4.8 -> 200 "SERVING" (discarded, served the config default — C4 measured live); attachment send -> 400 with the P14 message. Verified at the real surface, not a probe.
- Parity: A1a ✓ A0+P18 ✓ E ✓ A3/A4 ✓ C ✓ **D ✓ (openclaw-dashboard#458)**. Remaining: A2 (config tab — blocked on openclaw-dashboard#419's unbuilt C1/C3 gates), hermes SSE follow-up, Salesforce port (B-remainder), Phase 6 GA flag.

### 2026-08-30 later — openclaw-dashboard#419 Phase 0+1 shipped (openclaw-dashboard#459): the hermes model gate exists

- **openclaw-dashboard#459 MERGED**: Phase 0 — scripts/extract-hermes-model-paths.py AST-walks the pinned v37 schema; committed artifact lib/agent-runtime/hermes-model-paths.ts (22 tuple sections incl 18 auxiliary sub-agents, 22 scalars, 10 catalogs). Schema surprise handled: top-level `model` is a plain STRING in the schema, mapping in our estate — both shapes gate; a bare string = provider inference (P20) and re-gates. Phase 1 — pure gateHermesConfigDoc: C9 tuple authorization (fail closed on unknown routes, always on `auto`); disallowed main model re-gated to entitled default; aux/scalar/catalog stripped to schema defaults; wired into the MCP writer (C1, injectable owner-plan loader C7) and deploy (C6 loud drift assert); C5 drift guard on HERMES_CONFIG_VERSION. Constants moved to leaf hermes-model-route.ts (broke a real hermes<->tools cycle). 1646 tests.
- **A2 remains blocked by C2**: Phase 2 (downgrade inline apply + start/restart re-gate + daily reconcile + regateFailingSince/quarantinedFromKeys escalation + key-rotation runbook) must land first — or A2+Phase2 ship in one release. That is the next big build.

### 2026-08-30 later — openclaw-dashboard#419 Phase 2 shipped (openclaw-dashboard#460 + openclaw-dashboard#461): A2 IS UNBLOCKED

- **openclaw-dashboard#460 MERGED (Phase 2)**: one engine regateHermesAgent (owner-plan re-read, gate, rewrite+restart, confirm — under the deploy lock with a post-write workspace updateTime CAS, C14) wired into four surfaces: plan-route inline downgrade apply (C3; Stripe webhook stays store-only), control start/restart before compose (C8), stateless daily reconcile GET /api/cron/hermes-regate (C11), audited quarantine clear on the agent PATCH route (C12 recovery, re-gate-first, audit agent.key_quarantine_cleared). Escalation: regateFailingSince → 48h window (pure, regate-core.ts) → quarantinedFromKeys; both fields immutable to generic updates + withheld from the serialized payload; quarantine denies ALL key-distribution paths (deploy core-key merge, deploy-time Org secrets, sync propagation via shared partition) independent of excludeFromOrgSecrets (C13). State-based P1 email + docs/ops/hermes-key-rotation-runbook.md (old-key→401 step). Named deviation: P1 rides the dashboard cron family, not the host diagnostic (no Firestore on hosts). 1656 tests.
- **PROCESS MISS, owned**: openclaw-dashboard#460's terminology check FAILED (new route, no TERMINOLOGY.md entry) but my merge guard piped `gh pr checks --watch` through `tail`, masking the exit code — the merge landed on a red check. Fixed forward in **openclaw-dashboard#461 MERGED** (Re-gate + Key quarantine defined; check green) and all merge chains now run under pipefail with the check's own exit code guarded.
- **C2 SATISFIED: parity A2 (hermes config tab) is UNBLOCKED** — Phases 1 (openclaw-dashboard#459) + 2 (openclaw-dashboard#460) both landed.
- **OWNER STEP**: create the reconcile scheduler job (documented in the runbook): gcloud scheduler jobs create http hermes-regate --schedule="50 5 \* \* \*" --uri=.../api/cron/hermes-regate --headers="Authorization=Bearer $CRON_SECRET". Until then convergence = deploy/start re-gates + the plan-route inline apply (the reconcile route works when called; it is just not yet called daily).

### 2026-08-31 — A2 shipped (openclaw-dashboard#462): THE HERMES PARITY GAP LIST IS EMPTY

- **openclaw-dashboard#462 MERGED (A2, the final parity phase)**: same Configuration tab (P6), format per runtime — openclaw's rich JSON editor untouched; hermes gets a validated YAML text editor (HermesConfigTab, call-site branch). Pure save validator (P5 before any SSH: malformed/multi-doc/non-mapping/stampless → 400; P20 auto refused with its own message; openclaw-dashboard#419 gate REFUSES a disallowed save — editor contract: never silently rewrite; convergence surfaces rewrite). Write under the deploy lock + in-lock plan re-read + post-write updateTime CAS (C14; cross-write plan change re-gates the written doc). GET = raw YAML via descriptor, never the shared openclaw.json (P2). verify-model + capability flags refuse hermes explicitly. config flips hermes:true. 1665 tests.
- **All sixteen original hermes gap-list capabilities are now supported or deliberately out of scope** (wallet/rain/hyperliquid per P4; salesforce per its own plan §9). Live verification path: open hermes007 -> Configuration -> YAML editor; save restarts + re-gates.
- Remaining estate loose ends: Phase 6 GA flag (HERMES_GA — owner decision when ready to let ordinary Orgs create hermes agents); reconcile scheduler job (owner, runbook has the command); hermes token-streaming follow-up; Salesforce hermes port; openclaw-dashboard#444 awaiting review (Codex credits); openclaw-dashboard#425 superseded (close), openclaw-dashboard#426 re-check.

## HANDOVER — continuing the hermes / openclaw-dashboard#404 line (written 2026-08-31, session end)

Read this after the `agentglob-session-start` orientation block. It is the
single continuation point for the hermes parity work.

### Where things stand

**openclaw-dashboard#404 (hermes-feature-parity) is MERGED and FULLY BUILT.** All seven phases
shipped and live, in order: A1a openclaw-dashboard#452 → A0+P18 openclaw-dashboard#454 → E openclaw-dashboard#455 → A3/A4 openclaw-dashboard#456 →
C openclaw-dashboard#457 → D openclaw-dashboard#458 → A2 openclaw-dashboard#462. The openclaw-dashboard#419 credential plan it depended on is also
fully built: Phase 0+1 openclaw-dashboard#459 (schema-enumerated model gate), Phase 2 openclaw-dashboard#460
(downgrade re-gate, start backstop, daily reconcile, key quarantine), plus
the openclaw-dashboard#461 terminology entry. The hermes gap list is EMPTY — every capability
is supported or deliberately out of scope (wallet/rain/hyperliquid per P4;
salesforce per its own plan §9).

**Live fleet**: hermi (2ndClaw/US) and hermes007 (1stClaw/EU — the canary;
owner-verified the A2 YAML editor renders there). Both serve
claude-sonnet-5 via the explicit Venice pin. Platform default =
venice/deepseek-v4-flash (openclaw-dashboard#453) — the OpenRouter account is UNFUNDED (free
429s account-wide, paid 402s at max_tokens 65536); a coherence test refuses
an openrouter default until someone funds the account and verifies at the
real workload size.

### Key modules this line created (all under the dashboard repo)

- lib/agent-identity.ts — P18 unique resolution + fleet-global name claim
  (in createAgent/deleteAgent transactions); A0 user-file refusals.
- lib/agent-runtime/hermes-model-{paths,route,gate}.ts + hermes-config-save.ts
  — the openclaw-dashboard#419 gate: committed v37 schema enumeration (regenerate with
  scripts/extract-hermes-model-paths.py against /root/AgentGlob_Apps/hermes-agent),
  C9 tuple authorization, P20 never-auto, the pure A2 save validator.
- lib/hermes-regate.ts + lib/agent-runtime/regate-core.ts — the re-gate
  engine (deploy lock + owner-plan re-read + post-write updateTime CAS) and
  the 48h quarantine window. Wired into: plan-route downgrade apply,
  control start/restart, GET /api/cron/hermes-regate, the audited
  quarantine clear on the agent PATCH route.
- lib/public-chat-runtime.ts — D's dispatch seam (publicChatTarget,
  resolveModelSwitch: hermes never gets /model; openclaw OD-2 active reset).
- lib/agent-runtime/hermes-telegram.ts — C's env-based channel
  (TELEGRAM_BOT_TOKEN + fail-closed TELEGRAM_ALLOWED_USERS via Secrets tab;
  compose passthrough re-provisioned on BOTH hosts 2026-08-30).

### Follow-ups, in suggested order

1. **HERMES_GA (Phase 6, docs/plans/hermes-runtime-support.md §6)** — flip
   the single flag in lib/agent-runtime/capabilities.ts, which lifts the
   wizard isPlatform condition AND the POST /api/agents role gate together;
   the §4 GA test toggles it. OWNER DECISION — do not flip unasked.
2. **Reconcile scheduler job (owner)** — the route exists and works; the
   daily call does not. gcloud command in
   docs/ops/hermes-key-rotation-runbook.md. Until then convergence =
   deploy/start re-gates + plan-route inline apply.
3. **openclaw-dashboard#444 (non-core-secrets)** — Rev 9 pushed, 0 open threads, but the Rev
   is UNREVIEWED: Codex ran out of review credits 2026-08-26. Owner either
   tops up Codex or owner-accepts Rev 9. After merge: Phase 1 build (host
   prefix fence + named-empty wallet slot), Phase 2 host cleanup (OWNER,
   values touched), Phase 3 sha-guarded fleet sweep (final pass matches
   name+VALUE via in-memory host values and verifies LIVE containers).
4. **Hermes token streaming** — named deviation in openclaw-dashboard#458: chatStream emits
   one final delta; the pinned 0.20.4 API has no chat-streaming endpoint
   (measured). Needs either an upstream endpoint (new image tag → register
   as a hermes RELEASE via the runtime-scoped store, then upgrade hermes007
   FIRST — E gives rollback) or live-recorded delta fixtures.
5. **Salesforce hermes port** — runtime-tools plan §9; catalog shipped,
   port not built.
6. **Cleanup**: close openclaw-dashboard#425 (superseded by shared-core-keys ruling);
   re-check openclaw-dashboard#426 (Venice BYOK) against the post-#453 default; openclaw-dashboard#432 owns the
   hermes host-artifact deletion cleanup (hrms002's dir still sits on
   2ndClaw — evidence); ANTHROPIC_API_KEY still deliberately unseeded on
   both hosts (owner).

### Hard-won gotchas (memory has the full versions)

- Verify at the REAL workload size (a max_tokens=20 probe passed while the
  65536-token request 402d) and check the provider ACCOUNT, not the price page.
- Guard on `gh pr checks`' own exit code — `| tail` masked a red check once
  and a merge landed on it. Use `if gh pr checks …; then merge; fi`.
- The node test runner needs explicit .ts extensions on relative lib imports,
  and lib/firestore cannot load under it — lazy-import workspace-store et al
  from any module the tests reach (see loadOwnerPlanModels for the pattern).
- A NEW route or skill fails the terminology check without a TERMINOLOGY.md
  entry (or the terminology-exempt label) in the same PR.
- ENDPOINT_MAP.md + assets/skills/support/SKILL.md are generated — route or
  capability changes must re-run scripts/api-map.mts and
  scripts/build-support-skill.mts in the same PR.
- Canary discipline: try hermes changes on hermes007 (EU) first, never
  hermi-first. Scope claims need a second reader — count the files.

## 2026-09-04 — Dependabot switched on for both repos; reachable dependency alerts fixed and rolled (Claude session)

Owner-run end-to-end: alerts on → config fixed → Dependabot's first run → hand-picked fixes → deploy → fleet roll → promote.

### Why nothing had ever happened

- Dependabot **alerts** and **security updates** were OFF on both repos (404 from `GET /repos/…/vulnerability-alerts`). Enabled via the API (`PUT …/vulnerability-alerts`, `PUT …/automated-security-fixes`) — both repos, same minute.
- `cryptolir/openclaw` is a **fork**, and GitHub keeps Dependabot _version updates_ off on forks until enabled by hand (Insights → Dependency graph → Dependabot → Enable; no API). Owner clicked it 2026-09-04. The existing `dependabot.yml` was never the problem — except one entry pointing at `apps/shared/MoltbotKit`, which does not exist in the fork (openclaw#145 removed it).
- `cryptolir/openclaw-dashboard` had **no `dependabot.yml` at all** (openclaw-dashboard#499 added one: npm `/`, github-actions `/`, docker `/`; plus a `deploy.yml` paths line so a dependabot.yml edit does not cut a prod revision).

First alert counts once enabled: dashboard **98** (5 critical, 54 high), gateway **253** (13 critical, 91 high). Dependabot's own first run opened 6 dashboard PRs and 3 gateway PRs, all minor (`/ui` vite/vitest, a Go module in a docs script, dev deps).

### Dashboard — shipped and on prod (Cloud Run revision `openclaw-dashboard-00531-n9h`)

- **openclaw-dashboard#506** — `next-auth` 5.0.0-beta.30 → beta.32, `@auth/core` → 0.41.3. The two criticals, both in the login layer: malformed `Bearer` now yields `null` (middleware sends `/login` instead of a 500 — verified on prod with a bad header), OAuth check cookies bound to their provider, NFKC email normalisation. Build exit 0, 1733/1734 tests (same as main).
- **openclaw-dashboard#507** — `npm audit fix --omit=dev` (no majors) + `js-yaml` 4.1.1 → 4.3.2. `next` 15.5.12 → 15.5.25, `protobufjs`, `websocket-driver`, `ws` (via `ethers`/`viem`), `lodash`, `sharp`, `nanoid`, `socket.io-parser`, `fast-xml-*`, `form-data`, `@grpc/grpc-js`; `node-forge` dropped from the tree. `npm audit --omit=dev` 31 → 11 (0 critical). Dependabot auto-closed its superseded openclaw-dashboard#500/#501/#503/#505.
- Alerts after: 98 → **25** (0 critical). Remaining highs: `adm-zip` (needs 0.6.0, semver-major, direct dep) and `postcss` (only fixable by `next` 16) — both **deliberately skipped: majors need code work**; the rest are dev-only (`brace-expansion`, `browserslist`, `picomatch`, `flatted`).
- Not verified by me: a real Google sign-in on prod (needs a browser + the owner's account). Owner to click through `/dashboard/platform` once.

### Gateway — shipped, built, rolled

- **openclaw#149** — `tar` 7.5.9 → 7.5.21 (dep + pnpm override), `undici` 7.22.0 → 7.29.1 (root range **and** `extensions/zalo`'s exact pin, which had kept the old copy in the lockfile), `simple-git` → 3.36.0 and `basic-ftp` → 5.3.1 via pnpm overrides. 4 critical + 12 high alerts closed. `pnpm tsgo`/`lint` clean; full `pnpm test` with `--max-old-space-size=12288` = 782/783 files, the one failure (`plugins/discovery` uid-mismatch) fails identically on clean main because the suite runs as root.
- **openclaw#145** — dropped the MoltbotKit entry; also carried the `oxfmt STATUS.md` fix that had been failing `check` on every PR since openclaw#144 (md-only pushes skip `check` on main, so it surfaced one PR late and blocked `checks (node, test)` via `needs: [check]`).
- Alerts after: 253 → **198**. Remaining criticals, **deliberately skipped**: `protobufjs` (transitive via `@mariozechner/pi-ai`, lark, baileys — `7.6.5` clears every 7.x advisory as a single override, but it touches the coding-agent core, own PR), `@whiskeysockets/baileys` rc9 → rc12 (a channel SDK, own verification), and `vitest`/`@vitest/browser` (dev only).
- **Image `v2026.9.4.1`**, sourceSha `4010452f789`, digest `50ba5000da5b`, built with the builder cache pruned first (the `v2026.06.27.1` incident). Verified inside the image before rolling: app tree has exactly `tar` 7.5.21 / `undici` 7.29.1 / `simple-git` 3.36.0 / `basic-ftp` 5.3.1 (older `tar` copies exist only inside the base image's bundled npm CLI).
- **2ndclaw (US)**: 14 rolled, 0 failed, all on the digest above, 0 restarts, containment 0 bytes in every container. 45-min soak: clean — passes at 22:44 (boot noise only: 8 agents still 1–5 min into boot), 23:00, 23:15, 23:30 all 0 down / 0 restarts / 0 unhealthy / 0 SSRF blocks / 0 error lines / containment 0 bytes.
- **1stclaw (EU)**: **not rolled yet** — awaiting owner go. 15 agents on `v2026.9.1.1`, all running, disk 81%.
- **Promote**: **not done.** `v2026.9.4.1` is registered `staging`; stable is still `v2026.9.1.1`. Promote only after EU is rolled and soaked, then `POST /api/platform/releases/v2026.9.4.1/promote`.

### Two things learned the hard way

- **The Sept 1 roll had been partly undone.** Four US agents (`projectmanager`, `social-bob`, `support`, `vcode1bot`) were re-created on 2026-09-02 06:49–06:52 by a dashboard deploy, which writes `OPENCLAW_IMAGE=openclaw:<latest **stable** tag>` (`app/api/agents/deploy/route.ts:749`). Stable was still `v2026.8.19.1` that morning, so they went back to pre-security-port code and stayed there until today. **Promotion is not optional: any dashboard redeploy resets an agent to whatever is marked stable.**
- `scripts/ops/deploy.sh` has no exec bit; `./deploy.sh` fails with "Permission denied", and a `| tee | grep` pipeline reported exit 0 while the fleet had not moved. Run it as `bash scripts/ops/deploy.sh <tag> <host>` with `pipefail`, and census the containers before soaking.

### Follow-ups (not started, unclaimed)

- openclaw: `protobufjs` override → 7.6.5 (one line, clears a critical); `baileys` rc12; then the next-to-reachable set (`ws`, `axios`, `sharp`, `hono`, `minimatch`, `form-data`).
- openclaw-dashboard: `adm-zip` 0.6.0 and `next` 16 are code changes, not bumps. Dependabot's 3 open dev-dep PRs (openclaw-dashboard#502, #504, #508) can be batched with the next weekly run.
- deploy.sh: add `chmod +x` or document `bash`; consider promoting from `deploy.sh` itself once both hosts are rolled, so stable can no longer lag the fleet.

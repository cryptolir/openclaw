# Live skill access for Havaya app-user sessions — Option A (`load_skill` tool)

> **Status:** PROPOSED 2026-06-17 · review-only (not for merge) · **Author:** agentglob ops
>
> **Rev 2 (2026-06-17):** folded codex review `4517821566` — the `load_skill`
> allowlist now derives from the same filtered, prompt-visible skill snapshot
> (no hidden-skill side channel), confinement is against each matched entry's own
> trusted root (not a hardcoded path), the tool is gated on a _resolved_ app user
> (turn-1-safe via the #71 fallback), and `files` is dropped from v1. See §9.
>
> **Context:** App-user chats on the `life` agent run sandboxed
> (`tools.fs.workspaceOnly: true`). They already _see_ the live dashboard skills in
> their system prompt, but cannot `read` the skill files to apply them — which is why
> the Havaya Drive summary method had to be hard-embedded in the prompt. This plan adds
> a narrow, read-only `load_skill` tool so app sessions can load and apply the live
> skills **without** weakening the per-user file isolation.

---

## 1. Problem

The dashboard syncs an agent's selected skills into `workspace/skills/<name>/SKILL.md`
(highest-precedence skill root). For a normal session (Telegram / owner / webchat) the
agent reads those files on demand and applies the skill. For a **Havaya app-user
session** it cannot — and the failure is subtle:

- The skills _awareness_ block is built from the **shared** workspace home, so the app
  agent's system prompt already lists every live skill (`name` + `description` +
  absolute `SKILL.md` path) and is told "use the read tool to load a skill's file."
- But the app session's file tools are **jailed** to a per-user directory, so the
  `read` of that shared `SKILL.md` path is denied.

Net effect: the app agent is told it has skills and then cannot open them. The current
workaround is to **embed** a copy of the method text into the prompt (the Havaya admin
"Live skill vs embedded copy" toggle exists precisely because of this gap). Embedding
is manual, drifts from the live skill, and does not generalise to other skills.

## 2. Goals / non-goals

**Goals**

- App-user sessions can **load and apply** the live `workspace/skills/` skills (the
  same ones the dashboard syncs), always current.
- **Zero** new reachability into private data: other users' files
  (`users/<id>.md`), other per-user workspaces, group/project files, or host secrets
  (`docker.env`) must remain unreachable.
- Keep progressive disclosure (a small index in-prompt, full content on demand) so the
  context budget is not blown by inlining every skill.

**Non-goals**

- Changing how skills are _authored_ — that stays a one-way dashboard → agent sync; the
  agent never writes skills.
- Letting app sessions **execute** skill scripts (shell stays blocked for app sessions).
- Relaxing the per-user file jail for anything other than skills.

## 3. Current architecture (verified against `main`)

Enforcement and skill surfacing today, with code anchors (line numbers approximate):

- **Two enforcement layers for app sessions:**
  1. `life-access-scope` host hook (`before_tool_call`) blocks enumeration/shell/
     subagent tools and confines `read`/`write`/`edit` to the workspace. It already
     contains a (now-dead) skills carve-out, `isWorkspaceSkillRead`, that allowed
     `read` of any `/workspace/skills/` path.
  2. `tools.fs.workspaceOnly: true` (set on `life`) — the **base file-tool jail**.
     This is the load-bearing boundary and it supersedes the hook: even when the hook
     abstains, the base tool denies any path outside the session's tool root.

- **The run path splits the two workspaces** — `src/agents/pi-embedded-runner/run/attempt.ts`:
  - `resolveAppToolWorkspace({ workspaceHome: effectiveWorkspace, sessionKey, denyKey: sessionId })`
    returns the **tool** root: `shared` for normal/admin, a jailed
    `user-workspaces/<appUserId>/` for app users, or a throwaway `_no-app-user/<sessionId>/`
    when no `appUserId` resolves (fail-closed). `toolWorkspace` is then `chdir`-ed and
    passed to the file tools as `workspaceDir`.
  - The **skills prompt** is built from the **shared** home, not the jail:
    `resolveSkillsPromptForRun({ workspaceDir: effectiveWorkspace })`.
  - So the model **sees** the shared skill list but its file tools are rooted in the
    per-user jail. The `SKILL.md` paths in the prompt point _outside_ the jail.

- **App-session detection in code** — `src/agents/app-user-workspace.ts`:
  `isAppUserSession(sessionKey)` (`:app:` marker) and `resolveAppUserId(sessionKey)`.
  Already used to branch gateway behaviour (app_profile injection, workspace re-rooting).

- **First-turn `appUserId` caveat (PR #71, just shipped).** `resolveAppUserId` reads the
  **persisted session-entry** `appUserId`, which `chat.send` writes only after the entry
  exists — so it is `null` on the **first** turn of a new session. PR #71 added
  `appUserIdFromSessionKey(sessionKey)` (`src/agents/app-profile-context.ts:114`) and the
  app_profile injector now resolves `resolveAppUserId(...) ?? appUserIdFromSessionKey(...)`
  (`:156`) so it works on turn 1. Any app-session gating in this plan must use the same
  fallback, or skills would be unavailable on the first message (the exact bug #71 fixed).

- **Reusable server-side skill enumerator** — `src/agents/skills/workspace.ts`:
  `loadWorkspaceSkillEntries(workspaceDir)` returns
  `{ skill: { name, description, filePath, baseDir }, … }[]` for the **merged** skill
  roots — `extra` < bundled < managed (`~/.openclaw/skills`) < personal
  (`~/.agents/skills`) < project (`<workspace>/.agents/skills`) < workspace
  (`<workspace>/skills`, highest precedence). Pure gateway code, **not** subject to the
  jail. `buildWorkspaceSkillsPrompt` / `buildWorkspaceSkillSnapshot` apply the config
  filters (`shouldIncludeSkill`, `skillFilter`, eligibility, `disableModelInvocation`)
  and limits (`DEFAULT_MAX_SKILLS_IN_PROMPT = 150`, `DEFAULT_MAX_SKILLS_PROMPT_CHARS =
30000`) — i.e. the _raw_ entry list is a superset of what the prompt actually shows.
  `syncSkillsToWorkspace(src, dst)` exists (the copy path used by sandbox mirroring).

- **The skills-awareness block** — `src/agents/system-prompt.ts` `buildSkillsSection`
  wraps the vendored pi `formatSkillsForPrompt`, which emits, per skill, a `<name>` /
  `<description>` / `<location>` (the absolute `SKILL.md` path) and the instruction to
  `read` that location. Gated only by `isMinimal` (subagents), **not** by app-vs-normal.

- **Precedent to mirror** — `src/agents/app-profile-context.ts` +
  `appendAppProfileBootstrapFile` in `src/agents/bootstrap-files.ts` already branch on
  `isAppUserSession` and inject synthetic, byte-capped content for app sessions only.

## 4. Options considered

| Option                                        | Mechanism                                                                                                                                                 | Isolation blast radius                                                                              | Cost                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **A. `load_skill` tool (chosen)**             | Name-scoped, read-only gateway tool resolves a prompt-visible skill name to its `SKILL.md` content server-side; app prompt instructs the model to call it | Smallest — jail untouched; additive, app-scoped, no path input                                      | One tool + an app-prompt branch                                                                        |
| **B. Mirror skills into the jail**            | `syncSkillsToWorkspace(shared → toolWorkspace)` per run; build the prompt from `toolWorkspace` so the model reads within its jail                         | Small — only skills copied in                                                                       | Disk per user (incl. ephemeral `_no-app-user` dirs) + per-run copy/sync; symlinks rejected by the jail |
| **C. Read-only skills exception in the jail** | Teach `workspaceOnly` to permit `read` of `<home>/skills/**`                                                                                              | Largest — edits core file-tool jail for **every** agent using `workspaceOnly`; must be config-gated | Touches the most sensitive code                                                                        |

**Why A.** It best satisfies "do not risk the sandbox / private data": the jail stays
exactly as-is and skills arrive through a separate, name-validated, read-only channel.
It is additive and app-scoped (smallest blast radius), keeps progressive disclosure, and
generalises the "embedded copy" workaround into a live mechanism. (Option C is the most
architecturally "honest" — skills _are_ a shared read-only library — but it changes the
core jail for all agents; deferred.)

## 5. Design — Option A

### 5.1 The `load_skill` tool

New `src/agents/tools/load-skill.ts`. Shape:

```ts
// load_skill({ name }) -> { name, description, content, truncated }
//   name        exact (trimmed) skill name from the app-visible skill set
//   content     the SKILL.md text, UTF-8 byte-capped (see §6)
//   truncated   true if content was clamped; the model is told a truncated skill
//               may be incomplete
// Reads from the matched entry's trusted source root, server-side. The gateway
// process is not jailed; only the model's file tools are — so this never widens
// the model's FS reach.
```

Resolution (fail-closed):

1. Take the **app-visible skill set** — the _same_ filtered snapshot used to render the
   app prompt (§5.3), **not** raw `loadWorkspaceSkillEntries`. This guarantees the tool
   can only load skills the model can already see, so it is never a side channel to
   filtered / `disableModelInvocation` / ineligible skills (codex finding 2).
2. `name = name.trim()`; match by **exact** name against that set. The snapshot is
   already precedence-merged and de-duplicated by name, so collisions across roots are
   resolved there (no case-insensitive matching — codex open-question answer). No match
   → structured "unknown skill" result listing available **names** only (never paths).
3. Resolve the file from the **matched entry** (`skill.filePath`), `realpath` it, and
   assert it is contained under the **matched entry's own trusted root**
   (`realpath(skill.baseDir) + path.sep`) — not a hardcoded `<home>/skills/`, because a
   legitimately prompt-visible skill may live under bundled/managed/personal roots
   (codex finding 1). Reject `..`, symlink escape, or any resolution outside that root.
4. Read the file; clamp to the byte cap; set `truncated` accordingly.
5. Return `name`, `description`, `content`, `truncated`. **No `files` list in v1**
   (codex finding 4) — sibling filenames can leak skill-dir detail; add a guarded
   `file` parameter only once a skill demonstrably needs helper-file contents.

The tool **never accepts a path** — only a name, matched against the app-visible set.
There is no model-controlled path, so there is no traversal surface.

### 5.2 Registration and wiring

- `createOpenClawCodingTools(...)` (called in `attempt.ts`) gains the tool. Because the
  existing `workspaceDir` passed to tools is the **jailed** `toolWorkspace`, the tool is
  seeded with the app-visible skill set (names → trusted `filePath`/`baseDir`) computed
  from the **shared** `effectiveWorkspace` at the call site (both are in scope).
- **Gate on a _resolved_ app user, not bare `:app:`** (codex finding 3). Resolve with the
  #71 fallback — `resolveAppUserId(sessionKey) ?? appUserIdFromSessionKey(sessionKey)` —
  so a well-formed app session gets the tool on **turn 1**, while a session that resolves
  to neither (the jailed `_no-app-user` case) does **not** get it. Note: skills are
  non-private, so excluding `_no-app-user` is a deliberate consistency/defence-in-depth
  choice (match the workspace-jail's fail-closed posture), not a data-leak fix.

### 5.3 App-session skills prompt

Drive the app prompt and the tool allowlist from **one** filtered snapshot so they
cannot drift (codex finding 2 / open-question answer). Pass an app-skill-loading mode
into the same skills prompt builder/snapshot path; for app sessions it:

- renders the index as `name` + `description` **without** the absolute `<location>`
  (no host-path disclosure), and
- replaces the "use the read tool to load a skill's file at `<location>`" instruction
  with "call `load_skill` with the skill's `name`".

Normal sessions are unchanged (keep the existing read-by-location behaviour).

### 5.4 Dead carve-out cleanup + provenance

`isWorkspaceSkillRead` in the `life-access-scope` hook is now dead (the `workspaceOnly`
jail denies the shared-skills read regardless of the hook's allow). With Option A the
model loads skills via the tool, never via `read`, so the carve-out stays unused —
**remove it** (host-side edit, backup first). Separately, **commit `life-access-scope`
source to git** under `ops/graphiti-life/extensions/` before more host-only edits
accumulate (codex elevated this from "consider" to "do"): it is host-only today, which
violates the deploy protocol.

## 6. Security model

- **Jail unchanged.** App `read`/`write`/`edit` stay confined to the per-user dir. This
  plan adds no path-taking capability.
- **`load_skill` is name-only + read-only.** The server resolves the path from the
  app-visible snapshot's matched entry and realpath-confines it under that entry's own
  trusted root. No model input reaches the filesystem as a path.
- **No side channel.** The tool's allowlist is exactly the filtered, prompt-visible set,
  so it cannot reach filtered / `disableModelInvocation` / ineligible skills.
- **`_no-app-user` excluded.** Only sessions with a resolved app user get the tool.
- **Unreachable, as before:** other users' `users/<id>.md`, other per-user workspaces,
  `groups/` / `projects/`, host secrets (`docker.env`), and agent IP outside the skill
  roots (`SOUL.md`, `MEMORY.md`, …).
- **Subagents:** app sessions cannot spawn them (blocked by the hook); even if reachable,
  the tool only reads skills.
- **Byte cap + `truncated` flag** on returned content (defence-in-depth + context
  budget), mirroring `APP_PROFILE_MAX_BYTES`.
- **No path disclosure** in the app-facing prompt (the absolute `<location>` is dropped).

## 7. Testing

`vitest`, alongside the existing skill/app-profile suites:

- name → content for a prompt-visible skill; trim handling; exact match only.
- a skill that is filtered out / `disableModelInvocation` is **not** loadable (side-channel
  guard).
- unknown name → structured error listing available names, no paths.
- reject path-like input (`../x`, `/etc/passwd`, `a/b`, leading `~`/`@`).
- a skill under a non-workspace root (bundled/managed) resolves and is confined to **its**
  root; symlink-escape rejected.
- byte-cap and `truncated` flag.
- gating: a resolved-app-user session gets the tool on turn 1 (via the #71 fallback); a
  `_no-app-user` session does not.
- **regression:** a byte-for-byte prompt snapshot test proving the **normal-session**
  skills prompt is unchanged.

## 8. Deploy and rollout

Same mechanics as the v2026.06.17.x rolls:

1. Land the gateway PR on `main` (CI green; no `--admin` now that the gate is fixed).
2. Build + push a gateway image; **pin `life` only** (single-agent recreate; fleet
   untouched per the staged-boot rule); keep a `docker.env` rollback backup.
3. Update `life` `AGENTS.md` (host, backup first): in app chats, skills load via
   `load_skill`; when to reach for the live skills.
4. Verify end-to-end on a real app session: skill `read` denied before, `load_skill`
   works after.

## 9. Resolutions (codex review `4517821566`)

1. **[P1] Multi-root confinement** — confine each load against the **matched entry's own
   trusted root** (`skill.baseDir`), not a hardcoded `<home>/skills/`, so legitimately
   prompt-visible bundled/managed skills resolve correctly. (§5.1 step 3.)
2. **[P1] No hidden-skill side channel** — the tool's allowlist is the **same filtered
   snapshot** that renders the app prompt, never raw `loadWorkspaceSkillEntries`. (§5.1
   step 1, §5.3.)
3. **[P2] `_no-app-user` gating** — gate on a _resolved_ app user via the #71
   `resolveAppUserId ?? appUserIdFromSessionKey` fallback (turn-1-safe); unresolved
   sessions are excluded. (§5.2.)
4. **[P2] Sibling files** — `files` dropped from v1; a guarded `file` param added only if
   a skill needs helper contents. (§5.1 step 5.)

- **Name matching:** trim + exact match against the de-duplicated snapshot; no
  case-insensitive matching. (§5.1 step 2.)
- **Content cap:** 24 KB, truncate with `truncated: true` + a "may be incomplete" hint to
  the model. (§5.1, §6.)
- **Carve-out / provenance:** remove the dead `isWorkspaceSkillRead`; commit
  `life-access-scope` to git. (§5.4.)
- **Regression:** byte-for-byte normal-session prompt snapshot test. (§7.)

## 10. Follow-ups (out of scope here)

- Retire the Havaya Drive **embedded** summary method: load the live
  `tal-meeting-summary` skill via `load_skill` instead, and default the admin
  "Live vs embedded" toggle to **live**.
- Per-app curation of which live skills an app user sees (if the global list grows).

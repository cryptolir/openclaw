# Live skill access for Havaya app-user sessions — Option A (`load_skill` tool)

> **Status:** PROPOSED 2026-06-17 · review-only (not for merge) · **Author:** agentglob ops
>
> **Context:** App-user chats on the `life` agent run sandboxed
> (`tools.fs.workspaceOnly: true`). They already _see_ the live dashboard skills in
> their system prompt, but cannot `read` the skill files to apply them — which is why
> the Havaya Drive summary method had to be hard-embedded in the prompt. This plan adds
> a narrow, read-only `load_skill` tool so app sessions can load and apply the live
> skills **without** weakening the per-user file isolation. Codex review requested on
> the design and the security model before any code.

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

- **Reusable server-side skill enumerator** — `src/agents/skills/workspace.ts`:
  `loadWorkspaceSkillEntries(workspaceDir)` returns
  `{ skill: { name, description, filePath, baseDir }, … }[]` for the merged skill roots
  (bundled < managed < `<workspace>/skills`). Pure gateway code, no model tool, **not
  subject to the jail**. `buildWorkspaceSkillsPrompt` formats it; limits are
  `DEFAULT_MAX_SKILLS_IN_PROMPT = 150` / `DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30000`.
  `syncSkillsToWorkspace(src, dst)` exists (the copy path used by sandbox mirroring).

- **The skills-awareness block** — `src/agents/system-prompt.ts` `buildSkillsSection`
  wraps the vendored pi `formatSkillsForPrompt`, which emits, per skill, a `<name>` /
  `<description>` / `<location>` (the absolute `SKILL.md` path) and the instruction to
  `read` that location. Gated only by `isMinimal` (subagents), **not** by app-vs-normal.

- **Precedent to mirror** — `src/agents/app-profile-context.ts` +
  `appendAppProfileBootstrapFile` in `src/agents/bootstrap-files.ts` already branch on
  `isAppUserSession` and inject synthetic, byte-capped content for app sessions only.

## 4. Options considered

| Option                                        | Mechanism                                                                                                                                  | Isolation blast radius                                                                              | Cost                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **A. `load_skill` tool (chosen)**             | Name-scoped, read-only gateway tool resolves a skill name to its `SKILL.md` content server-side; app prompt instructs the model to call it | Smallest — jail untouched; additive, app-scoped, no path input                                      | One tool + an app-prompt branch                                                                        |
| **B. Mirror skills into the jail**            | `syncSkillsToWorkspace(shared → toolWorkspace)` per run; build the prompt from `toolWorkspace` so the model reads within its jail          | Small — only skills copied in                                                                       | Disk per user (incl. ephemeral `_no-app-user` dirs) + per-run copy/sync; symlinks rejected by the jail |
| **C. Read-only skills exception in the jail** | Teach `workspaceOnly` to permit `read` of `<home>/skills/**`                                                                               | Largest — edits core file-tool jail for **every** agent using `workspaceOnly`; must be config-gated | Touches the most sensitive code                                                                        |

**Why A.** It best satisfies "do not risk the sandbox / private data": the jail stays
exactly as-is and skills arrive through a separate, name-validated, read-only channel
that can only ever read a `SKILL.md` under `<home>/skills/`. It is additive and
app-scoped (smallest blast radius), keeps progressive disclosure, and generalises the
"embedded copy" workaround into a live mechanism. (Option C is the most architecturally
"honest" — skills _are_ a shared read-only library — but it changes the core jail for
all agents; deferred.)

## 5. Design — Option A

### 5.1 The `load_skill` tool

New `src/agents/tools/load-skill.ts`. Shape:

```ts
// load_skill({ name }) -> { name, description, content, files }
//   name        exact skill name (matches SkillEntry.skill.name)
//   content     the SKILL.md text, UTF-8 byte-capped (see §6)
//   files       sibling filenames in the skill dir (names only, for awareness)
// Reads from the SHARED workspace home, server-side. The gateway process is not
// jailed; only the model's file tools are — so this never widens the model's FS reach.
```

Resolution (fail-closed):

1. `entries = loadWorkspaceSkillEntries(skillsHome)` where `skillsHome` is the **shared**
   `effectiveWorkspace` (not the jailed `toolWorkspace`).
2. `match = entries.find(e => e.skill.name === name)`. No match → return a structured
   "unknown skill" result that lists the available **names** (never paths).
3. Resolve `filePath = match.skill.filePath`, `realpath` it, and assert it is contained
   under `realpath(<skillsHome>/skills/) + path.sep`. Reject `..`, symlink escape, or any
   path that resolves outside that subtree.
4. Read the file; clamp to the byte cap; flag truncation.
5. Return `name`, `description`, `content`, and the sibling filenames.

The tool **never accepts a path** — only a name, matched against the enumerator. There
is no model-controlled path, so there is no traversal surface.

### 5.2 Registration and wiring

- `createOpenClawCodingTools(...)` (called in `attempt.ts`) gains the tool. Because the
  existing `workspaceDir` passed to tools is the **jailed** `toolWorkspace`, the new tool
  needs the **shared** home separately — thread a new `skillsSourceDir = effectiveWorkspace`
  param (both values are already in scope at the call site).
- Register `load_skill` **only when `isAppUserSession(sessionKey)`** (open question §9:
  app-only vs always). Normal sessions can already read skill files, so the tool is just
  for the jailed case.

### 5.3 App-session skills prompt

For app sessions, change `buildSkillsSection` (`system-prompt.ts`) so the block:

- renders the index from `loadWorkspaceSkillEntries` as `name` + `description` **without
  the absolute `<location>`** (no host-path disclosure), and
- replaces the "use the read tool to load a skill's file at `<location>`" instruction
  with "call `load_skill` with the skill's `name`".

Normal sessions are unchanged (keep the existing read-by-location behaviour). Open
question §9 covers the cleanest branch point given the prompt can come from a
precomputed `skillsSnapshot`.

### 5.4 Dead carve-out cleanup

`isWorkspaceSkillRead` in the `life-access-scope` hook is now dead (the `workspaceOnly`
jail denies the shared-skills read regardless of the hook's allow). With Option A the
model loads skills via the tool, never via `read`, so the carve-out stays unused. Remove
it for clarity (host-side edit, backup first), and — separately — consider finally
committing `life-access-scope` to git under `ops/graphiti-life/extensions/` (known gap:
it is host-only today). Not load-bearing for this plan.

## 6. Security model

- **Jail unchanged.** App `read`/`write`/`edit` stay confined to the per-user dir. This
  plan adds no path-taking capability.
- **`load_skill` is name-only + read-only.** The server resolves the path from the
  enumerator's matched entry and realpath-confines it under `<home>/skills/`. No model
  input reaches the filesystem as a path.
- **Unreachable, as before:** other users' `users/<id>.md`, other per-user workspaces,
  `groups/` / `projects/`, host secrets (`docker.env`), and agent IP outside `skills/`
  (`SOUL.md`, `MEMORY.md`, …).
- **Subagents:** app sessions cannot spawn them (blocked by the hook); even if reachable,
  the tool only reads skills.
- **Byte cap** on returned content (defence-in-depth + context budget), mirroring
  `APP_PROFILE_MAX_BYTES`.
- **No path disclosure** in the app-facing prompt (the absolute `<location>` is dropped).

## 7. Testing

`vitest`, alongside the existing skill/app-profile suites:

- name → content for a known skill; case/trim handling per §9.
- unknown name → structured error listing available names, no paths.
- reject path-like input (`../x`, `/etc/passwd`, `a/b`, leading `~`/`@`).
- resolved path confined under `<home>/skills/`; symlink-escape rejected.
- byte-cap and truncation flag.
- app-session prompt variant emits the `load_skill` instruction and **no** absolute path;
  normal-session prompt is byte-for-byte unchanged.

## 8. Deploy and rollout

Same mechanics as the v2026.06.17.1 roll:

1. Land the gateway PR on `main` (CI green; no `--admin` now that the gate is fixed).
2. Build + push a gateway image; **pin `life` only** (single-agent recreate; fleet
   untouched per the staged-boot rule); keep a `docker.env` rollback backup.
3. Update `life` `AGENTS.md` (host, backup first): in app chats, skills load via
   `load_skill`; when to reach for the live skills.
4. Verify end-to-end on a real app session: skill `read` denied before, `load_skill`
   works after.

## 9. Open questions for codex

1. **Tool scope** — register `load_skill` for app sessions only, or all sessions
   (harmless redundancy for normal sessions, simpler wiring)? Leaning app-only.
2. **Prompt branch point** — cleanest place to render the app variant given the prompt
   may come from a precomputed `skillsSnapshot`: inside `buildWorkspaceSkillsPrompt`,
   `buildSkillsSection`, or a post-process? Avoid drift with pi `formatSkillsForPrompt`.
3. **Name matching** — exact only, or case-insensitive/trim? Behaviour on name
   collisions across skill roots (bundled vs workspace precedence).
4. **Sibling files** — v1 returns sibling **names** only. Do any target methodology
   skills (`tal-meeting-summary`, `personal-vision-exercise`) need their helper files'
   _contents_? If so, add a guarded `load_skill({ name, file })` that confines `file`
   to the matched skill dir — or keep v1 strict.
5. **Content cap** — value (≈24 KB?) and truncation semantics (truncate-with-flag vs
   error), and interaction with the 30 KB skills-prompt budget.
6. **Carve-out / provenance** — remove the dead `isWorkspaceSkillRead`, and should
   `life-access-scope` be committed to git now (it is host-only)?
7. **Regression surface** — confirm no non-app path depends on the model reading
   `SKILL.md` by absolute path in a way the prompt change could regress (normal sessions
   should be untouched).

## 10. Follow-ups (out of scope here)

- Retire the Havaya Drive **embedded** summary method: load the live
  `tal-meeting-summary` skill via `load_skill` instead, and default the admin
  "Live vs embedded" toggle to **live**.
- Per-app curation of which live skills an app user sees (if the global list grows).

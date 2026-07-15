# Graphiti per-user memory for the Plusim app (`onlyclaw`, EU host)

**Rev 1** · 2026-07-15 · status: **draft, for adversarial review**

Give Plusim (https://plusim.xyz) app users durable, per-user memory — the same
capability `life`/Havaya has — by standing up a Graphiti stack on the EU host and
wiring the agent `onlyclaw` to it.

**Scope (owner decision, 2026-07-15): app users ONLY.** No Telegram memory, and
therefore **no `session.dmScope` change** — onlyclaw's existing Telegram DM
behaviour is untouched by this plan.

Prior art: `docs/experiments/plans/life-per-user-memory.md` (Phases 1–3) and
`ops/graphiti-life/` (compose, proxy, hook, CUTOVER). This plan reuses that work
rather than rebuilding it.

---

## 1. What already exists — do NOT rebuild

| Component                                            | Location                                                                                                                    | Reusable for Plusim?                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Compose stack (falkordb + graphiti-mcp)              | `ops/graphiti-life/docker-compose.yml`                                                                                      | Yes — re-parameterise, new project name      |
| stdio↔HTTP proxy, allowlist + hard-pinned `group_id` | `ops/graphiti-life/proxy/graphiti-proxy.js`                                                                                 | **Yes, unchanged**                           |
| `before_tool_call` scope hook                        | `ops/graphiti-life/extensions/life-memory-scope/index.js`                                                                   | Yes — logic is agent-generic (see §3.3)      |
| Gateway-native recall injection                      | `src/agents/memory-recall-context.ts` + `src/agents/graphiti-recall-client.ts`, wired at `src/agents/bootstrap-files.ts:72` | **Yes — already in the image onlyclaw runs** |
| Session-key → appUserId parser                       | `src/agents/app-profile-context.ts:114-134`                                                                                 | Yes — source of the §3.3 fix                 |
| Memory protocol prose                                | `ops/graphiti-life/agents-md-memory-section.md`                                                                             | Template only — Plusim needs its own voice   |

Two facts worth stating loudly, because they shrink this plan:

**(a) The proxy and the hook are already agent-generic.** `graphiti-proxy.js:31-32`
takes its target from env (`GRAPHITI_URL`, `GRAPHITI_HOST_HEADER`); the hook's
`resolveGroupId()` derives identity from the session alone. Nothing in either is
life-specific except the _name_ `life-memory-scope`.

**(b) Recall is no longer discretionary and is already shipped.** Since
`memory-recall-context.ts`, the gateway itself fetches the user's top facts
server-side and injects them as a synthetic `MEMORY_RECALL.md` bootstrap file
every turn (`MEMORY_RECALL_MAX_FACTS = 8`, `MEMORY_RECALL_TIMEOUT_MS = 2500`,
fail-open). `onlyclaw` runs `gateway:v2026.07.10.1` — the same image as `life` —
so this code is **already present and inert**, defaulting to
`http://graphiti-mcp:8000/mcp` (`graphiti-recall-client.ts:26-27`), a name that
does not resolve on EU today. Standing up the stack activates it; no image
rebuild, no source change, no redeploy of the fleet.

**Plusim's app side is already correct** and needs no change:

- `src/lib/agentglob.ts` → `makeSessionKey()` mints `app:plusim:<userId>:<conversationId>`.
- `src/app/api/chat/route.ts:98` → `callAgent({ ..., appUserId: userId })` forwards the Clerk id.
- `openclaw-dashboard` `app/api/public/chat/[agentName]/route.ts:71,149,178` parses and forwards
  `appUserId` into `chatSendAndWait(..., appUserId)` (`lib/gateway-client.ts:496-504`).

---

## 2. Findings — measured on live hosts, 2026-07-15

**F1 — No Graphiti on EU; the US stack is unreachable by design.**
`graphiti-mcp` + `graphiti-falkordb` run only on the US host (`5.161.84.219`,
`/opt/graphiti`, compose project `graphiti-life`), healthy 4–5 weeks. `docker port
graphiti-mcp` → `172.17.0.1:8000` — the docker0 bridge, host-internal, no route
from EU. `onlyclaw` is on EU (`89.167.70.46`). Measured footprint:

```
graphiti-mcp       | MEM 47.44MiB | CPU 0.22%   (VmSwap 13568 kB)
graphiti-falkordb  | MEM 26.11MiB | CPU 0.40%   (VmSwap 13300 kB)
/opt/graphiti      | 60K on disk  | db0: keys=18
```

⇒ ~74 MiB for a second stack. EU has 1660 MiB available. This is noise, **not**
an OB-9 rescale trigger (but see §9).

**F2 — Turn-1 memory writes fail closed. Measured, reproducible, and the one real
defect in this plan.**

The hook resolves identity from the persisted session entry only
(`life-memory-scope/index.js`, `resolveGroupId()`): `entry.appUserId` → else
telegram peer → else `return null` → `{block:true}`. But `chat.send` persists
`appUserId` by _patching an existing entry_:

```ts
// src/gateway/server-methods/chat.ts:809-821
if (typeof p.appUserId === "string" && p.appUserId.trim() && sessionStorePath) {
  const appUserId = p.appUserId.trim();
  if (entry?.appUserId !== appUserId) {
    try {
      await updateSessionStoreEntry({ storePath: sessionStorePath, sessionKey,
        update: async () => ({ appUserId }) });
```

On turn 1 of a brand-new conversation the entry does not exist yet, so the id is
not persisted until turn 2+. `src/agents/app-profile-context.ts:98-113` documents
exactly this and compensates on the **read** path with a session-key fallback. The
**write** hook has no such fallback.

Proved live against prod `onlyclaw` on the current image:

```
POST /api/public/chat/onlyclaw  sessionKey=app:plusim:user_memsmoke01:diag-graphiti
                                appUserId=user_memsmoke01
turn 1 → reply "smoke-ok"    → entry.appUserId: None     ← hook would BLOCK the write
turn 2 → reply "smoke-ok-2"  → entry.appUserId: 'user_memsmoke01'
```

Consequence if shipped unfixed: recall works from turn 1 (it has the fallback),
writes silently drop on turn 1 of every conversation. Corroborating evidence —
`onlyclaw`'s live store has 6 app sessions, **0** with `appUserId`; `life`'s has
175 app sessions, 64 with. The 111 without are turn-1-only conversations. This is
a pre-existing `life` bug too; §3.3 fixes it once, at the source.

**F3 — `onlyclaw` is unconfigured for memory.**
`session: {}` · `hooks: {}` · `plugins.allow: null` · `plugins.entries: {mcp-bridge,
telegram}` · `tools.fs: {}` · `extensions/` contains only `mcp-bridge` ·
`workspace/user-workspaces/` contains only `_no-app-user` (confirming app users
have been running with no resolved identity) · `OPENAI_API_KEY` present
(`docker.env:99`).

**F4 — `onlyclaw`'s `docker.env` has no trailing newline** (last byte is `2`).
A naive `>>` append concatenates onto the `OPENAI_API_KEY` line and corrupts it.
This plan does not append to `docker.env`; recorded so the deploy step never does.

---

## 3. Design

### 3.1 EU Graphiti stack — reuse the existing compose, don't fork it

**No new compose file.** `ops/graphiti-life/docker-compose.yml` is already
env-driven except for two lines; parameterising them lets one file serve both
hosts, with defaults that keep the US/`life` stack byte-identical in behaviour:

```yaml
name: ${GRAPHITI_STACK_NAME:-graphiti-life} # was: name: graphiti-life  (line 21)
...
agent_net:
  name: ${AGENT_NETWORK:-life_default} # was: name: life_default   (line 71)
  external: true
```

EU's `/opt/graphiti/.env` then sets `GRAPHITI_STACK_NAME=graphiti-plusim` and
`AGENT_NETWORK=onlyclaw_default`; US's `.env` sets neither and is unchanged.

Verified with `docker compose config` **on the EU host** before writing this
(interpolation in a top-level `name:` and in an external network name is not
obviously supported, so it was probed rather than assumed):

```
defaults   → name: graphiti-life    / network name: life_default    (US unchanged)
overridden → name: graphiti-plusim  / network name: onlyclaw_default
```

The `onlyclaw_default` network already exists on EU (`docker network ls`), so the
external join has its prerequisite.
Everything else — images, the `172.17.0.1:8000` bind, the unpublished falkordb,
`REDIS_ARGS=--requirepass`, healthchecks — is inherited as-is. Container names
(`graphiti-mcp`, `graphiti-falkordb`) stay fixed and do not collide: the stacks are
on different hosts. If a second stack ever lands on one host, those two
`container_name:` lines are the thing that breaks — recorded here, not pre-solved.

Carried over from the existing file and load-bearing:

- `graphiti-mcp` publishes to **`172.17.0.1:8000` only** — docker0, host-internal,
  **never `0.0.0.0`**. The Graphiti surface is unauthenticated and exposes
  destructive tools.
- **The external-network join is declarative.** An imperative `docker network
connect` does not survive container recreation and silently broke `life`'s memory
  on 2026-06-10 (fixed by PR #59). EU inherits the fixed shape for free.
- EU `.env` (host-only, never committed): `FALKORDB_PASSWORD` = fresh
  `openssl rand -hex 24` (**not** the US password); `OPENAI_API_KEY` copied from
  `onlyclaw`'s `docker.env:99`. Extractor `gpt-4o-mini` + embedder
  `text-embedding-3-small`, as US.

**A separate graph per host is deliberate, not a workaround.** The alternative —
pointing EU at the US stack — would require exposing an unauthenticated
`graphiti-mcp` across datacenters (its only protection today is the docker0 bind)
and would commingle Plusim's _financial_ data with Havaya's personal graph.
Separate stacks keep the blast radius per app and add no new trust boundary.

### 3.2 Extensions on `onlyclaw`

Deploy to `/root/.openclaw/agents/onlyclaw/extensions/`:

- `graphiti-proxy/graphiti-proxy.js` — byte-identical copy, no edits.
- `memory-scope/` — the hook, with the §3.3 fix.

Both: `chmod 0755` on the directory, `chown -R 1000:1000` (a silent "plugin not
found" otherwise), and `openclaw.plugin.json` **must** carry a `configSchema` key
or the gateway crash-loops with "Invalid config". Both gotchas are from
`ops/graphiti-life/CUTOVER.md` and cost hours the first time.

### 3.3 The F2 fix — one line, in the existing file, fixing the root cause

**No new plugin, no fork.** The bug is in
`ops/graphiti-life/extensions/life-memory-scope/index.js` and it is the _same_ bug
for both agents — `life` has been dropping turn-1 memory writes for weeks (64 of
175 app sessions carry `appUserId`; the other 111 are turn-1-only). Fixing it
where both callers route through is both the correct fix and the smaller diff.

Add to `resolveGroupId()`, **after** the persisted-entry attempt and **before**
the fail-closed return:

```js
// Fallback: derive the appUserId from the session KEY when chat.send has not
// persisted it yet (turn 1 of a new conversation — see chat.ts:809-821).
// Mirrors src/agents/app-profile-context.ts:114-134 so the write path resolves
// the SAME id the read path already does. Same-user and read-only: the id comes
// from this very session's key, so it can never surface another user's memory.
const fromKey = appUserIdFromSessionKey(sessionKey);
if (fromKey) return "app_" + sanitize(fromKey);
```

`appUserIdFromSessionKey` is ported verbatim in behaviour from
`app-profile-context.ts:114-134`: take the tail after the last `:app:`, split on
`:`, take the **second-to-last** segment, validate against `/^[a-z0-9_-]+$/`.

**Why second-to-last and not "the segment after `:app:`":** Plusim's key is the
namespaced 4-part form `app:plusim:<userId>:<conversationId>`. A naive
"first segment after `:app:`" parser returns `plusim` — which would put **every
Plusim user into one shared `app_plusim` graph**: a total cross-user memory leak
in a financial-guidance app. The conversationId is always the final colon-free
segment, so second-to-last is correct for both the 4-part namespaced form and the
legacy 3-part `app:<userId>:<conversationId>`. This is the single most important
line in the plan and T1/T2 exist to pin it.

**Byte-identity invariant, verified before writing this plan.** The hook's
`sanitize()` lowercases then maps non-`[A-Za-z0-9_]` to `_`; the read client's
`appGroupIdFromUserId()` (`memory-recall-context.ts:46-48`) does **not** lowercase,
relying on its resolvers having done so (`app-user-workspace.ts:55`,
`app-profile-context.ts:132`). The two converge because the hook lowercases the raw
entry value itself, and the gateway lowercases the canonical session key. Checked
against a real mixed-case Clerk id:

```
write(hook) : app_user_3gaz4rid6bzjjykh0sdfusxgpza
read(recall): app_user_3gaz4rid6bzjjykh0sdfusxgpza   → identical
```

If these ever diverge the agent writes to one graph and reads from another — a
silent, total memory failure with no error. T3 pins it.

**`onlyclaw` loads this plugin under its existing id, `life-memory-scope`.** The
name is a wart on a financial app, but the id is internal, the code is
agent-generic, and a rename would touch `life`'s working prod config for cosmetic
gain. Renaming — and the staler `ops/graphiti-life/` directory name now that it
serves two agents — is deliberately deferred; a comment in onlyclaw's config
explains the name. Deploying the fixed file to `life` is a **separate, ask-first
step** (§7): git leading the host is normal, and one prod agent per change is the
point.

### 3.4 `onlyclaw/openclaw.json`

Backup `openclaw.json.bak.pre-graphiti` first. Add:

- `plugins.entries.mcp-bridge.config.servers.graphiti` → `node
/home/node/.openclaw/extensions/graphiti-proxy/graphiti-proxy.js`, env
  `GRAPHITI_URL=http://graphiti-mcp:8000/mcp`,
  `GRAPHITI_HOST_HEADER=localhost:8000` (Graphiti 421s any non-localhost `Host`).
- `plugins.entries.life-memory-scope.enabled = true` (name explained in §3.3).
- `plugins.allow = ["telegram", "mcp-bridge", "life-memory-scope"]` — currently
  `null`; pins trust for local extension code the loader otherwise warns about.
- `hooks.internal.enabled = true` — **hooks do not run without it.**
- **No `session.dmScope` change** (§Scope).

### 3.5 Memory protocol prose

Append a memory section to `onlyclaw`'s `workspace/AGENTS.md` in Plusim's
financial-guidance voice, modelled on `ops/graphiti-life/agents-md-memory-section.md`
(which is Hebrew/TAL and must not be copied verbatim). Backup
`AGENTS.md.bak.pre-graphiti`.

---

## 4. Invariants — please attack these

- **I1 — Cross-user isolation.** A Plusim user can never read or write another
  user's memory. `group_id` derives only from server-side session identity; the
  model never supplies it; the proxy fails closed when `__group_id` is absent.
- **I2 — Write/read group_id identity.** The hook's `group_id` is byte-identical to
  `appGroupIdFromUserId()`'s for the same user, on turn 1 and turn N.
- **I3 — Namespace is not identity.** `app:plusim:<userId>:<conv>` resolves to
  `app_<userId>`, never `app_plusim`.
- **I4 — Telegram unaffected.** No `dmScope` change; onlyclaw's Telegram sessions
  behave exactly as today, and memory tools fail closed for them (app-only scope).
- **I5 — No destructive surface.** `clear_graph`, `delete_entity_edge`,
  `delete_episode`, `get_entity_edge` are never exposed to the model.
- **I6 — Memory never breaks chat.** Recall is fail-open and timeboxed; a blocked
  write surfaces as a tool error, never a failed turn.
- **I7 — No public exposure.** EU `graphiti-mcp` binds `172.17.0.1` only; falkordb
  is unpublished.
- **I8 — Graph separation.** Plusim's graph is physically separate from Havaya's.

## 5. Test list — every review finding must land here as a named test

Pure/unit (`node:test`, shipped with PR2 — no host, no SDK):

- **T1 (I3)** `appUserIdFromSessionKey("agent:main:app:plusim:user_abc:conv1")` === `"user_abc"` — explicitly **not** `"plusim"`.
- **T2 (I3)** legacy 3-part `"agent:main:app:user_abc:conv1"` === `"user_abc"`.
- **T3 (I2)** hook `group_id` === `appGroupIdFromUserId(resolved)` for a mixed-case Clerk id (`user_3GAZ4rId6bZjJykh0sDFuSXgPZa`) — pins the lowercase asymmetry.
- **T4 (I3)** a key whose userId segment fails `/^[a-z0-9_-]+$/` resolves to null (fail closed), not to a coerced group.

Live smoke (deploy gate, mirrors `ops/graphiti-life/recall2.sh`):

- **T5 (F2/I2)** turn 1 of a brand-new session writes memory successfully — the measured regression.
- **T6 (I1)** two users' writes land in different groups; user A's search never returns user B's fact.
- **T7 (I5)** `tools/list` through the proxy exposes only `add_memory`, `search_memory_facts`, `search_nodes`, `get_episodes`.
- **T8 (I1)** a model-supplied `group_id`/`group_ids` argument is overridden by the pinned value.
- **T9 (I1)** a proxy call with no `__group_id` is refused.
- **T10 (I4)** a Telegram session's `mcp__graphiti__*` call is blocked.
- **T11 (I6)** with graphiti-mcp stopped, a chat turn still completes.
- **T12 (I7)** `ss -lntp` shows `:8000` bound to `172.17.0.1` only; falkordb unpublished.
- **T13** after `docker compose up -d --force-recreate` of `onlyclaw`, it still resolves `graphiti-mcp` — the PR #59 network-join regression.

## 6. Deliberately NOT building

- Telegram memory / any `dmScope` change (owner decision).
- A second compose file, a renamed plugin, or a renamed `ops/graphiti-life/`
  directory — all cosmetic (§3.1, §3.3).
- Cross-host or public exposure of graphiti-mcp.
- Recall caching — `memory-recall-context.ts` documents why (stale "no memories" on a fresh chat).
- A `tools.fs.workspaceOnly` jail for `onlyclaw` — real, but a separate concern (§9).
- Erasure UI; per-group `clear_graph` stays manual/admin-only.

## 7. Sequencing

1. **PR1 (this doc)** — plan only.
2. **PR2** — three edits, no host changes: the §3.3 fallback in
   `life-memory-scope/index.js`; the two interpolated vars in
   `ops/graphiti-life/docker-compose.yml` + `.env.example`; T1–T4 as `node:test`.
3. **Deploy to `onlyclaw` (ask-first — infra, §Act-vs-ask)** — stack up on EU →
   copy proxy + hook, perms → `openclaw.json` → `AGENTS.md` → smoke T5–T13. Per the
   deploy protocol, host changes land in git in the same task, with
   `.bak.pre-graphiti` backups.
4. **Deploy the same fix to `life` (ask-first, separate)** — closes life's turn-1
   gap. Deliberately not bundled: one prod agent per change.

## 8. Rollback

- Config: restore `openclaw.json.bak.pre-graphiti`, recreate `onlyclaw`.
- Stack: `docker compose -p graphiti-plusim down` on EU.
- Memory is additive and app-scoped; there is no data migration to reverse.

## 9. Open risks (surfaced, not hidden)

- **EU memory pressure.** 1660 MiB available but **1887 MiB of swap already in
  use**. +74 MiB is noise today, but FalkorDB grows with the graph, and the OB-9
  rescale decision is already flagged DUE with the owner. This plan does not
  resolve OB-9; it adds a small, bounded consumer to a host that is already thin.
- **`onlyclaw` has no filesystem jail** (`tools.fs: {}`). This is the same class of
  leak that `life` closed via per-user workspaces (gateway PR #62,
  `tools.fs.workspaceOnly: true`): Plusim app users may be able to read the agent
  workspace. **Out of scope here — memory does not create this and cannot fix it —
  but it should be tracked as a follow-up**, and it is arguably more urgent than
  memory for a financial app.
- **`_no-app-user/` already exists in onlyclaw's workspace**, confirming app users
  have been running with unresolved identity. After the §3.3 fix, new per-user
  directories should appear; the stale `_no-app-user` tree is inert and left alone.
- **A diagnostic smoke session** (`app:plusim:user_memsmoke01:diag-graphiti`) was
  created on prod `onlyclaw` while measuring F2. It is inert and sits alongside
  pre-existing `app:plusim:smoke:*` keys; not hand-removed, because editing a live
  `sessions.json` races the gateway's own writes.

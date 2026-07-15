# Graphiti per-user memory for the Plusim app (`onlyclaw`, EU host)

**Rev 4** · 2026-07-16 · status: **draft — BLOCKED, see F6**

> **Rev 4 (folds Codex round 3).** Three findings, all landed.
>
> **P1 (T2 contradicted the design) — the sharpest catch of the loop.** Rev 3
> made legacy 3-part keys fail closed but left **T2 still asserting they
> resolve**. Implementing T2 as written would have forced re-accepting the
> ambiguous 2-segment tail — **reopening F7-A**, the exact leak Rev 3 existed to
> close. A test can re-open a hole the design just shut; T2 is now inverted.
>
> **P2 (charset conflation) → F8, confirmed by execution.** Rev 3's
> validate-don't-coerce used `SAFE_APP_USER_ID = /^[a-z0-9_-]+$/` — the
> **path-safe** charset for `users/<id>.md` _filenames_. Graphiti group ids are
> **RediSearch-safe**, `[A-Za-z0-9_]`, no hyphen (graphiti-proxy.js:102,
> `SAFE_GROUP_ID`, README §3). Two different constraints; I used the wrong one.
> Rev 4 uses the group-id charset on both paths.
>
> **P1 (repeat, line 342) — a false positive I caused.** Codex re-flagged the
> superseded Rev 2 parser, still sitting inline under a live heading. "Supersede,
> don't delete" is right for _reasoning_ and wrong for _code_: a stale code block
> reads as the spec. Deleted, with the reasoning kept in the Rev headers.

**Rev 3** · 2026-07-15 · status: superseded by Rev 4

> **Rev 3 (folds Codex round 2).** Round 2's P1 found **two holes in Rev 2's own
> "strict" parser** — both confirmed by execution (**F7**): a namespaced key
> missing its conversationId (`…:app:plusim:user_abc`) was accepted as the legacy
> 2-segment form and returned **`app_plusim`**, the very shared bucket Rev 2
> claimed to close; and `lastIndexOf(":app:")` let an appended marker
> (`…:conv:app:user_victim:x`) return **`app_user_victim`** — a victim's group,
> by string-crafting alone.
>
> The lesson, and why round 2 landed at all: Rev 2 still **inferred** structure
> from an untrusted string, just more carefully. Rev 3 stops inferring and
> **validates against a known expected shape** — one anchored regex with the
> namespace pinned from plugin config (§3.3). The 2-vs-3-segment ambiguity is not
> resolvable structurally; only the expected namespace resolves it. Legacy 3-part
> keys now fail **closed** — deliberate, and called out below. Same
> validate-don't-coerce fix applied to the persisted-entry path. T5–T8 → T5–T11.

**Rev 2** · 2026-07-15 · status: superseded by Rev 3

> **Rev 2 (folds Codex round 1).** Codex P1 → **F5** (verified: the parser buckets
> malformed keys into `app_plusim`/`app_thread` instead of failing closed) → §3.3
> now specifies exact key-shape validation, and T1–T4 grew to T1–T8. Codex P2 →
> tests move from `node:test` to **Vitest** (§5), the repo's actual validation path.
> Chasing P1's premise past the malformed case surfaced **F6**: the public chat
> endpoint is unauthenticated and takes `sessionKey`/`appUserId` from the request
> body, so a **well-formed crafted key** defeats I1 outright — strict parsing does
> not touch it. **This plan is now blocked on F6**, which is also a live issue for
> `life`/Havaya today (§9). Rev 1 text is superseded inline, not deleted.

**Rev 1** · 2026-07-15 · status: draft, for adversarial review

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

**F5 — The parser buckets malformed keys instead of failing closed.**
_(Codex round 1, P1 — confirmed by execution, not by reading.)_ Rev 1 said to port
`appUserIdFromSessionKey` (`src/agents/app-profile-context.ts:114-134`) verbatim.
That helper does `split(":").filter(Boolean)` and takes the second-to-last
segment. `filter(Boolean)` **silently drops empty segments**, which shifts the
index — so a malformed key does not fail closed, it lands in a shared bucket:

```
agent:main:app:plusim:user_abc:conv-uuid  → app_user_abc     (legit)
agent:main:app:plusim:user_abc:           → app_plusim       ← every Plusim user, one graph
agent:main:app:plusim:user_abc:thread:1   → app_thread       ← shared across users
agent:main:app:user_abc:conv1             → app_user_abc     (legacy 3-part, legit)
```

Both bad rows pass the `/^[a-z0-9_-]+$/` check. The exact leak Rev 1 claimed to
have designed out, reachable through a _different_ door than the one it guarded.
§3.3 replaces "port verbatim" with exact key-shape validation.

**F6 — Identity is client-supplied: the public chat endpoint has no auth.**
_(Found by chasing P1's premise — "can a session key be shaped to write into
another user's group?" — past the malformed case.)_ Strict parsing (F5) fixes
_accidental_ collisions. It does nothing about a **well-formed** crafted key:

```
agent:main:app:plusim:user_victim:x  → app_user_victim   ← well-formed, strict-parser-clean
```

That only matters if a caller can choose the key. **It can.** In
`openclaw-dashboard` `app/api/public/chat/[agentName]/route.ts`:

```ts
// line 17
// Public endpoint — no auth required. Returns only safe display fields.
...
const sessionKey = body.sessionKey?.trim() || `anon:${agentName}:main`;      // line 70
const appUserId = typeof body.appUserId === "string" ? body.appUserId.trim() : undefined;  // line 71
```

The only gates are: agent exists, workspace not suspended, agent running, no
slash commands, and model plan-gating. **No caller identity of any kind.** This
was verified inadvertently while measuring F2 — the smoke test that proved the
turn-1 bug was an unauthenticated `curl` supplying both `sessionKey` and
`appUserId`, and it worked.

So anyone who knows a Clerk userId can POST as that user and have the agent
recall their memories back (`memory-recall-context.ts` injects
`MEMORY_RECALL.md` from exactly this id) or write poisoned facts into their graph.
Clerk ids are 27 random chars and not enumerable — a real mitigation — but they
are **identifiers, not secrets**, and leak through URLs, logs, and support flows.

The platform has already made the opposite call one endpoint over: the
**user-file** route (`app/api/public/chat/[agentName]/user-file/route.ts:5,40,48`)
requires `Authorization: Bearer {AGENTGLOB_APP_API_KEY}` to read a user's file.
Reading a user's file needs a key; driving a chat that injects that same user's
memories needs nothing. Plusim **already holds** `AGENTGLOB_APP_API_KEY`.

**This blocks the plan.** Per-user memory whose identity is attacker-supplied is
not per-user memory; shipping §3 on top of F6 would ship I1 as a fiction. The fix
lives in `openclaw-dashboard`, not here — see §7 and §9.

**F7 — Rev 2's "strict" parser was still inference, and leaked two ways.**
_(Codex round 2, P1 — both confirmed by execution.)_

```
F7-A  agent:main:app:plusim:user_abc                        → app_user_abc? no: app_plusim
F7-B  agent:main:app:plusim:user_abc:conv:app:user_victim:x → app_user_victim
```

**F7-A:** a namespaced key missing its conversationId has a 2-segment tail
(`plusim:user_abc`), which Rev 2 accepted as the _legacy_ `<userId>:<conv>` form
and resolved to `plusim` — reopening the exact shared bucket Rev 2 was written to
close. **F7-B:** `lastIndexOf(":app:")` scans from the **right**, so appending
`:app:user_victim:x` to any key hands the parser a tail of the attacker's
choosing — a victim's group by string-crafting alone, no auth bug required.

The pattern across F5 and F7 is one mistake, twice: **inferring structure from an
untrusted string**. Rev 1 inferred by position; Rev 2 inferred more carefully by
segment count; both leaked. Rev 3 stops inferring — it asserts one anchored shape
with the namespace pinned out-of-band (§3.3). This is also why F7-A is not fixable
by parsing alone: the ambiguity is real, and only the expected namespace resolves
it.

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

**Rev 2 (F5 fix) — ❌ REJECTED by Rev 3. Code deleted deliberately, see below.**
Rev 2 replaced "port verbatim" with a segment-count check
(`split(":")` without `filter(Boolean)`, exactly 2 or 3 segments, non-empty
conversationId). **It leaked twice anyway (F7)** and must not be implemented.
The code is removed rather than left inline: Codex re-flagged the stale block on
round 3 as if it were the spec, which is exactly what a reader — human or bot —
would do with a plausible-looking code block sitting under a live heading. The
reasoning is preserved in the Rev 2 header note and in F5/F7; the _artefact_ is
not, because a superseded parser is not history, it is a trap.

**Rev 3: the block above was still inference, and F7 killed it. Replaced by:**

```js
// The agent knows exactly ONE legal key shape. Anchored ^...$ so an appended
// ":app:" cannot shift the match (F7-B); namespace pinned so a missing
// conversationId cannot masquerade as the legacy form (F7-A); [^:]+ so extra
// segments cannot exist. Everything else → null → the hook blocks.
//   agent:<agentId>:app:<namespace>:<userId>:<conversationId>
// Rev 4/F8: the userId charset here is the GROUP-ID charset [a-z0-9_] (RediSearch-
// safe, graphiti-proxy.js:102), NOT the path-safe [a-z0-9_-] used for users/<id>.md
// filenames. A hyphen is legal in a filename and illegal in a group id.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const appKeyRe = (ns) => new RegExp(`^agent:[^:]+:app:${escapeRe(ns)}:([a-z0-9_]+):[^:]+$`);

function appUserIdFromSessionKey(sessionKey, ns) {
  if (typeof sessionKey !== "string" || !ns) return null;
  const m = sessionKey.match(appKeyRe(ns));
  return m ? m[1].toLowerCase() : null;
}
```

Verified against every known bad shape — executed, not reasoned:

```
agent:main:app:plusim:user_abc:conv-uuid              → app_user_abc  (legit)
agent:main:app:plusim:user_abc                        → null ✓  (F7-A: was app_plusim)
agent:main:app:plusim:user_abc:conv:app:user_victim:x → null ✓  (F7-B: was app_user_victim)
agent:main:app:plusim:user_abc:                       → null ✓
agent:main:app:plusim:user_abc:thread:1               → null ✓
agent:main:app:user_abc:conv1                         → null ✓  (legacy — now fails CLOSED)
```

**Why the namespace must come from config, not from the key.** A 2-segment tail
`plusim:user_abc` is structurally identical to a legacy `<userId>:<conversationId>`
— nothing _in the key_ separates "namespaced, conversationId missing" from
"legacy, conversationId present". No parser resolves that; only knowing the
expected namespace does. So `plugins.entries.life-memory-scope.config.appNamespace`
= `"plusim"` for onlyclaw (§3.4), carried in the `configSchema` the plugin must
have anyway. Not speculative flexibility — the minimum fact needed to parse
unambiguously.

**Legacy 3-part keys now fail closed — deliberate.** `life` has 111 legacy-form
sessions. They lose only the _turn-1_ fallback (their entries carry `appUserId`
from turn 2 on, the primary path), and they fail **closed**: a blocked write, never
a wrong group. For Plusim it is moot — every key `makeSessionKey()` mints is
namespaced.

**Same fix on the persisted-entry path (Rev 3).** `sanitize()` _coerces_: it maps
every non-`[A-Za-z0-9_]` char to `_`, so `a:b` and `a_b` collapse into one group.
Coercion invents an identity; validation refuses one. The entry path now validates
after lowercasing, else null, instead of sanitising, matching the key path. T11
pins the collision.

**Rev 4 / F8 — validate against the GROUP-ID charset `/^[a-z0-9_]+$/`, not the
path-safe one.** Rev 3 used `SAFE_APP_USER_ID = /^[a-z0-9_-]+$/`
(`app-profile-context.ts:96`), which exists to make `users/<id>.md` **filenames**
safe. Graphiti group ids answer to a different authority — RediSearch — where
`[A-Za-z0-9_]` is the whole alphabet and a hyphen is a syntax error
(`graphiti-proxy.js:102`; `SAFE_GROUP_ID` at `graphiti-recall-client.ts:30`;
README §3: _"Hyphens/colons break search"_). Dropping `sanitize()` without
tightening the charset left the hyphen live. Executed:

```
user_abc   write=app_user_abc   proxy=accepts   read=app_user_abc    agree
user-abc   write=app_user-abc   proxy=REJECTS   read=app_user_abc    ◀ DIVERGE
```

A hyphenated id therefore either fails at the proxy or writes one group and reads
another — silently, which is the whole F8 failure mode. Worse, the read path's
coercion is itself a collision: `appGroupIdFromUserId("user-abc")` and
`…("user_abc")` both return **`app_user_abc`** — two distinct users, one graph.
**PR2 therefore also stops `appGroupIdFromUserId()` coercing** (validate → null),
so read and write reject the same inputs instead of inventing a shared bucket.

With `/^[a-z0-9_]+$/` on both paths, hyphens fail closed everywhere and nothing
real breaks: every live Clerk id is `user_` + alphanumerics — checked against the
actual session stores (`user_3eodvckhcp3ivzlkerr03lddxde`,
`user_3gaz4rid6bzjjykh0sdfusxgpza`, `user_3fdbitm00f5nkadidkurq2rv13b` all pass).
T3 and T11 carry the hyphen cases.

**Why the hook carries its own copy rather than importing the gateway's.** The
hook already lazily imports `/app/src/gateway/session-utils.js`, so importing
`app-profile-context.js` and calling the real helper would be the obvious
de-duplication — and it would be wrong here: `onlyclaw` runs `v2026.07.10.1`,
whose helper **is** the loose one. Importing it would inherit F5 until a fleet
image rebuild. The hook's copy is strict today, with no rebuild.

The same F5 looseness still sits in the **source** helper, which feeds the read
path (`app-profile-context` and `memory-recall-context`). PR2 fixes it there too,
shipping on the next image — **sequenced, not blocking**: with a strict write
hook, no wrong-group write ever happens, so a loose read of `app_plusim` returns
an empty graph. T8 asserts the two copies agree, so the duplication cannot drift.

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
- `plugins.entries.life-memory-scope.config.appNamespace = "plusim"` — **(Rev 3,
  F7-A)** the pinned namespace §3.3's parser validates against. Without it the
  hook cannot tell a namespaced key missing its conversationId from a legacy key,
  so it must fail closed: **no `appNamespace` ⇒ no session-key fallback at all**
  (the persisted-entry path still works). Declared in the plugin's `configSchema`.
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
  `app_<userId>`, never `app_plusim`. **(Rev 2)** And a malformed key resolves to
  **nothing** — never to a shared bucket (`app_plusim`, `app_thread`). Exactly two
  key shapes are legal; every other shape fails closed.
- **I9 — Identity is server-authenticated, not client-asserted. (Rev 2, F6 — the
  one that currently fails.)** No unauthenticated caller may choose the
  `appUserId` or the `app:` session key that scopes memory. Any request carrying
  either must prove it speaks for the app (`AGENTGLOB_APP_API_KEY`, as the
  user-file route already requires). Without this, I1 is decorative: a
  well-formed crafted key is indistinguishable from a real one, and no amount of
  parser strictness helps.
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

Pure/unit — **Vitest, not `node:test` (Rev 2, Codex P2).** `pnpm test` runs
`scripts/test-parallel.mjs`, which invokes the Vitest configs; `node:test` files
are invisible to it. Since these are the **only** automated guard on the
namespace/leak boundary, landing them outside the standard suite would let the
parser regress with CI green — the failure mode the tests exist to prevent.

- **T1 (I3)** `"agent:main:app:plusim:user_abc:conv-uuid"` → `"user_abc"` — explicitly **not** `"plusim"`.
- **T2 (I3, F7-A) — INVERTED in Rev 4.** legacy 3-part `"agent:main:app:user_abc:conv1"` → **null**, NOT `"user_abc"`.
  _Rev 3 changed the design to fail legacy keys closed but left this test asserting the old behaviour. Implementing T2 as written would force the parser to re-accept the ambiguous 2-segment tail — reopening F7-A. A stale test can re-open the hole its own revision just shut; that is what this row now guards against._
- **T3 (I2)** hook `group_id` === `appGroupIdFromUserId(resolved)` for a mixed-case Clerk id (`user_3GAZ4rId6bZjJykh0sDFuSXgPZa`) — pins the lowercase asymmetry. **(Rev 4/F8)** plus a hyphen case: `"user-abc"` → **null on both paths**, never `app_user-abc` (proxy-rejected) or `app_user_abc` (diverged).
- **T4 (I3)** a userId segment failing `/^[a-z0-9_]+$/` → null (fail closed), not a coerced group.
- **T5 (I3, F5)** trailing colon `"agent:main:app:plusim:user_abc:"` → **null**, not `"plusim"`.
- **T6 (I3, F5)** extra segment `"agent:main:app:plusim:user_abc:thread:1"` → **null**, not `"thread"`.
- **T7 (I3, F5)** empty interior segment (`"…:app:plusim::conv"`) → **null**.
- **T8 (I3, F7-A)** missing conversationId `"agent:main:app:plusim:user_abc"` → **null**, not `"plusim"`. _Rev 2 returned the shared bucket here._
- **T9 (I3, F7-B)** appended marker `"agent:main:app:plusim:user_abc:conv:app:user_victim:x"` → **null**, not `"user_victim"`. _The crafted-impersonation case; must hold even with F6 fixed._
- **T10 (I3, F7-A)** a key with the **wrong** namespace (`"agent:main:app:havaya:user_abc:conv"` on an agent pinned to `plusim`) → **null**. Pins that the namespace is checked, not merely skipped over.
- **T11 (I1, Rev 3 + F8)** the persisted-entry path **validates and does not coerce**: `appUserId` values `"a:b"` and `"a_b"` must not collapse to the same group — the unsafe one resolves to **null**, not `app_a_b`. **(Rev 4)** same for `"user-abc"` vs `"user_abc"`, and `appGroupIdFromUserId()` itself must return **null** for a hyphenated id rather than coercing it into another user's group.
- **T12 (F5 drift guard)** the hook's copy and the source helper agree on every row of T1–T11 — the duplication in §3.3 cannot silently diverge.
- **T12b (I2, F8)** every id accepted by the write path is accepted by the proxy's `/^[A-Za-z0-9_]+$/` (graphiti-proxy.js:102) — no id can pass validation and then be rejected at the wire. _(Suffixed rather than renumbering T13–T22 again: the last renumber silently dropped a row, and churning stable ids to satisfy tidiness is how that happens.)_

Live smoke (deploy gate, mirrors `ops/graphiti-life/recall2.sh`):

- **T13 (F2/I2)** turn 1 of a brand-new session writes memory successfully — the measured regression.
- **T14 (I1)** two users' writes land in different groups; user A's search never returns user B's fact.
- **T15 (I5)** `tools/list` through the proxy exposes only `add_memory`, `search_memory_facts`, `search_nodes`, `get_episodes`.
- **T16 (I1)** a model-supplied `group_id`/`group_ids` argument is overridden by the pinned value.
- **T17 (I1)** a proxy call with no `__group_id` is refused.
- **T18 (I4)** a Telegram session's `mcp__graphiti__*` call is blocked.
- **T19 (I6)** with graphiti-mcp stopped, a chat turn still completes.
- **T20 (I7)** `ss -lntp` shows `:8000` bound to `172.17.0.1` only; falkordb unpublished.
- **T21** after `docker compose up -d --force-recreate` of `onlyclaw`, it still resolves `graphiti-mcp` — the PR #59 network-join regression.
- **T22 (I9, F6 — the deploy gate)** an **unauthenticated** POST to
  `/api/public/chat/onlyclaw` carrying `appUserId` or an `app:` session key is
  **rejected**. This is the exact `curl` that succeeded while measuring F2; it
  must fail before memory is enabled. Its counterpart: the same request **with**
  a valid `AGENTGLOB_APP_API_KEY` still succeeds, so Plusim keeps working.

## 6. Deliberately NOT building

- Telegram memory / any `dmScope` change (owner decision).
- A second compose file, a renamed plugin, or a renamed `ops/graphiti-life/`
  directory — all cosmetic (§3.1, §3.3).
- Cross-host or public exposure of graphiti-mcp.
- Recall caching — `memory-recall-context.ts` documents why (stale "no memories" on a fresh chat).
- A `tools.fs.workspaceOnly` jail for `onlyclaw` — real, but a separate concern (§9).
- Erasure UI; per-group `clear_graph` stays manual/admin-only.

## 7. Sequencing

**Rev 2: step 0 is new and is a hard gate.** Everything below it is inert until
F6 is closed — sequencing, not preference (§9).

0. **BLOCKER — close F6 in `openclaw-dashboard` (owner call; separate plan/PR in
   that repo).** Require `AGENTGLOB_APP_API_KEY` on any `/api/public/chat/*`
   request carrying `appUserId` or an `app:` session key, mirroring the user-file
   route's existing bearer check. This is a **public-surface authorization
   change**, so it earns its own plan-review loop rather than riding this one —
   and it needs a compatibility decision the owner owns: which callers other than
   Plusim/Havaya post `appUserId` today, and does requiring a key break them?
1. **PR1 (this doc)** — plan only.
2. **PR2** — no host changes: the §3.3 **strict** parser + fallback in
   `life-memory-scope/index.js`; the same strictness in the source helper
   (`app-profile-context.ts`, rides the next image); the two interpolated vars in
   `ops/graphiti-life/docker-compose.yml` + `.env.example`; T1–T12 as **Vitest**.
3. **Deploy to `onlyclaw` (ask-first — infra, §Act-vs-ask)** — gated on step 0,
   verified by **T22**. Stack up on EU → copy proxy + hook, perms →
   `openclaw.json` → `AGENTS.md` → smoke T13–T21. Per the deploy protocol, host
   changes land in git in the same task, with `.bak.pre-graphiti` backups.
4. **Deploy the same fix to `life` (ask-first, separate)** — closes life's turn-1
   gap. Deliberately not bundled: one prod agent per change.

## 8. Rollback

- Config: restore `openclaw.json.bak.pre-graphiti`, recreate `onlyclaw`.
- Stack: `docker compose -p graphiti-plusim down` on EU.
- Memory is additive and app-scoped; there is no data migration to reverse.

## 9. Open risks (surfaced, not hidden)

- **F6 is not hypothetical for `life` — it is live today. (Rev 2, owner
  escalation.)** This plan can simply wait. `life`/Havaya cannot: it has durable
  per-user memory **and** server-side recall injection running in production right
  now, behind the same unauthenticated endpoint. Anyone holding a Havaya user's
  Clerk id can POST as them and have the agent read that user's memories back —
  no key, no session, no allowlist. The route is shared, so the exposure is a
  property of the endpoint, not of `onlyclaw`.
  **Confidence and its limits:** the mechanism is confirmed from the route source
  (`route.ts:17,70,71`) and from an unauthenticated `curl` against **`onlyclaw`**
  that returned a reply while supplying both `sessionKey` and `appUserId`. It has
  **deliberately not been demonstrated against `life`** — doing so means reading a
  real person's memories, which is the breach, not a test. If the owner wants
  proof before acting, the safe form is a POST with a **synthetic** appUserId that
  belongs to nobody: a reply confirms reachability without touching anyone's data.
  **Mitigating:** Clerk ids are 27 random chars, not enumerable. **Aggravating:**
  they are identifiers, not secrets, and the platform already treats this exact id
  as needing a bearer key one route over (user-file).
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

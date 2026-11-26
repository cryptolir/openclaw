# life-access-scope

A `before_tool_call` capability-boundary plugin for the `life` (Havaya.me / TAL) agent
that denies file/exfil tools to **app-user sessions**.

## Why

The `life` agent runs in **one shared per-agent workspace**
(`/root/.openclaw/agents/life/workspace/`). Its built-in file/shell tools
(`read`/`write`/`edit`/`exec`/`find`/`grep`/`browser`/…) are rooted there with the
sandbox jail **off** (`tools.fs.workspaceOnly` unset). So an app user who asks "show me
the workspace files" gets the whole directory — including agent IP (`SOUL.md`, the TAL
method files), other users' files (`users/<id>.md`), and `sec001.md`. The per-user work
already shipped (Graphiti memory + the user-file API) never constrained these tools.

This plugin is the **stopgap** that removes the easy exposure while the durable fix
(per-user workspace isolation — see below) is built.

## What it does

Acts **only** on app-user sessions (sessionKey contains an `:app:` segment, e.g.
`agent:<id>:app:havaya:<userId>:<conv>`). Telegram, webchat, owner, cron and internal
sessions are untouched. For app users it:

- **Blocks** `exec`, `process`, `apply_patch`, `find`, `grep`, `ls`, `glob`, `browser`,
  `sessions_spawn` — shell, enumeration, content-search, and the subagent-identity
  bypass (a spawned child's sessionKey drops the `app:` marker, so it would run
  unguarded).
- **Confines** `read`/`write`/`edit` to relative in-workspace paths — denies absolute /
  `~` / `@` / `..` targets, closing reads of secrets (`docker.env`), other agents'
  dirs, and the host filesystem.
- Leaves `read`/`write`/`edit` (relative), `message`, `web_search`, `cron`, `image`
  working so the coach still functions.

Registered via `api.on("before_tool_call", …)` (the typed-hook path —
`api.registerHook` would NOT fire on tool calls). Returns `{ block:true, blockReason }`
to deny, `undefined` to abstain. The gateway dispatch **fails OPEN if a handler
throws**, so this handler never throws and **fails CLOSED** (denies the targeted tools)
on internal error.

## Install (per-agent, no gateway rebuild)

Mirrors `life-memory-scope`:

1. Copy this `extensions/life-access-scope/` dir to the agent's extensions dir on the
   host: `/root/.openclaw/agents/life/extensions/life-access-scope/`
   (container path `/home/node/.openclaw/extensions/life-access-scope/`).
2. `chown -R 1000:1000` + `chmod 0755` the dir, `0644` the files (else silent
   "plugin not found").
3. In `life/openclaw.json`: add `"life-access-scope"` to `plugins.allow` and
   `plugins.entries["life-access-scope"] = { "enabled": true }`.
4. Append the app-user behavioral guard to `workspace/AGENTS.md` (covers what the hook
   cannot — e.g. the agent reading an internal file _by name_ and pasting it).
5. `docker restart life-openclaw-gateway-1`. Confirm the log line
   `[life-access-scope] before_tool_call typed hook registered via api.on`.

Deployed live 2026-06-12 (US host `5.161.84.219`). Backups:
`openclaw.json.bak.pre-access-scope`, `workspace/AGENTS.md.bak.pre-access-scope`.

## Verified (2026-06-12, prod)

- App session "list all files" → `exec` blocked (`[life-access-scope] blocked exec …`);
  agent declines gracefully.
- App session "read `/home/node/.openclaw/agents/life/docker.env`" → `read` path blocked.
- Non-app session (`smoke-nonapp-control`) → unaffected, `smoke-ok`.

## Residual (closed by the durable fix, NOT this stopgap)

This stopgap does **not** confine `read`/`write`/`edit` to the user's OWN files. An app
user can still `read` a _named, relative_ in-workspace file (e.g. `SOUL.md`,
`users/<other-id>.md` if they guess the unguessable Clerk id). The `AGENTS.md` behavioral
guard discourages this, but it is advisory. Enumeration is blocked, so discovery is hard,
but this is not airtight.

## Durable fix — Option A: per-user workspace (decided 2026-06-12)

Give each app user their own workspace root; jail the file tools to it per session; move
agent IP (`SOUL.md`, `AGENTS.md`, `BOOTSTRAP.md`, the TAL method files) **out** of the
user-reachable space (into the injected system prompt or a read-only agent-config dir).
This resolves the structural tension — the agent and the user are one principal at the
file layer today — and fails closed by construction. It is a gateway **source** change
(per-session workspace resolution, `src/agents/.../attempt.ts` `effectiveWorkspace`) plus
a small migration, so it needs a gateway image rebuild. First design step: determine
whether the agent reads `SOUL.md` / the TAL files at runtime or whether they're injected
at boot (only `AGENTS.md` + `BOOTSTRAP.md` appear auto-injected today).

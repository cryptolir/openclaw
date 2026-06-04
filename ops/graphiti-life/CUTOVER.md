# Phase 3 cutover runbook — wire Graphiti memory into the `life` agent

Applies the per-user memory feature to the live `life` gateway on the US host
(`5.161.84.219`). All steps are reversible; backups are taken first.

> **Live-bot side effect:** setting `session.dmScope = per-peer` changes Telegram
> DM session keys from a single shared `…:main` session to one per sender. Existing
> in-flight DM conversations effectively start a fresh session thread. This is
> required for per-user memory (the default `main` scope has no user identity).

## 0. Prereqs (already done in Phase 1/2)

- `graphiti-life` compose stack healthy on the host (`/opt/graphiti`).
- Proxy validated; identity hook written.

## 1. Connect the life container to Graphiti's network

```bash
docker network connect graphiti-life_graphiti life-openclaw-gateway-1
# verify the proxy host resolves from inside life:
docker exec life-openclaw-gateway-1 getent hosts graphiti-mcp
```

(Re-run after any `docker compose up` that recreates the life container.)

## 2. Install the extensions into life's config dir

```bash
# proxy (CommonJS, own dir)
mkdir -p /root/.openclaw/agents/life/extensions/graphiti-proxy
cp proxy/graphiti-proxy.js proxy/package.json \
   /root/.openclaw/agents/life/extensions/graphiti-proxy/
# identity hook plugin
cp -r extensions/life-memory-scope \
   /root/.openclaw/agents/life/extensions/
```

Container sees these at `/home/node/.openclaw/extensions/...`.

## 3. Edit `/root/.openclaw/agents/life/openclaw.json` (BACK UP FIRST)

```bash
cp openclaw.json openclaw.json.bak.pre-graphiti
```

Add/merge:

```jsonc
{
  "session": { "dmScope": "per-peer" },
  "plugins": {
    "entries": {
      "telegram": { "enabled": true },
      "life-memory-scope": { "enabled": true },
      "mcp-bridge": {
        "enabled": true,
        "config": {
          "servers": {
            "graphiti": {
              "command": "node",
              "args": ["/home/node/.openclaw/extensions/graphiti-proxy/graphiti-proxy.js"],
              "env": {
                "GRAPHITI_URL": "http://graphiti-mcp:8000/mcp",
                "GRAPHITI_HOST_HEADER": "localhost:8000",
              },
            },
          },
        },
      },
    },
  },
}
```

## 4. Teach the agent the memory protocol (prompt)

Append a concise protocol to the agent's `MEMORY.md` (workspace) — read-before /
write-after-raw, and that "show me my file" reads the per-user user-file, not memory.
The model sees the tools as `mcp__graphiti__add_memory`, `…__search_memory_facts`,
`…__search_nodes`, `…__get_episodes` (no group params — scope is automatic).

## 5. Restart the gateway

```bash
docker restart life-openclaw-gateway-1
docker logs life-openclaw-gateway-1 --tail 40 2>&1 | grep -iE "mcp-bridge|life-memory-scope|graphiti|error"
```

Expect: mcp-bridge starts "graphiti" with 4 tools; life-memory-scope hook registered.

## 6. Smoke test (per-channel + isolation) — see Phase 6 in the plan.

## Rollback

```bash
cp openclaw.json.bak.pre-graphiti openclaw.json
docker restart life-openclaw-gateway-1
docker network disconnect graphiti-life_graphiti life-openclaw-gateway-1   # optional
```

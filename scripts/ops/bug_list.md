# Moved

This file relocated on 2026-07-10 to the **private** control-plane repo — it carries live
infra state (hosts, memory pressure, agent names) that doesn't belong in a public repo:

**`cryptolir/openclaw-dashboard` → [`docs/ops/bug_list.md`](https://github.com/cryptolir/openclaw-dashboard/blob/main/docs/ops/bug_list.md)**

The writers still live here in `scripts/ops/`: `agents_server_diagnostic.sh` rewrites the
AUTOSCAN block in the new location (daily 06:00 UTC via `diagnostic-cron.sh` on the dev
server, which needs the `openclaw-dashboard` checkout alongside this repo — see `DASH_REPO`).

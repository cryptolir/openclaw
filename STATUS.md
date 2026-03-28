# OpenClaw — Dev Status

> Claude reads this at session start, updates it at session end.
> Keep it short. Max ~60 lines. One source of truth for "where we are."

---

## Last Session

- **Date**: 2026-03-28
- **What happened**:
  - Merged gateway PR #4: `feat(gateway): add usage report rpc`
  - Added a follow-up gateway fix to parallelize `usage.report` session aggregation so large agents return before the dashboard timeout
  - Deployed gateway tag `v2026.03.28.1` to both Hetzner servers
  - Built/pushed the image on the EU host, then rolled it to the EU fleet (12 agents) and the US fleet (3 agents) with `/opt/openclaw-ops/scripts/deploy.sh`
  - Verified all 15 Hetzner agents are running image `europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway:v2026.03.28.1`
  - Merged dashboard PR #34: `feat(reports): add org and platform reporting views`
  - Added a follow-up dashboard fix for clickable `7d/30d/90d` filters and direct per-agent report RPC origin handling
  - Deployed dashboard via Cloud Build job `9e1e7a65-328e-4982-9a20-65a3e023b7e4`
  - Dashboard is live on Cloud Run revision `openclaw-dashboard-00161-nsr`
  - Pushed release tags `v2026.03.28.1` in both repos
- **Repos with uncommitted changes**:
  - `openclaw-dashboard`: user branch `fix/sync-serialization` still has unrelated local changes and was intentionally left untouched

---

## Currently In Progress

- No active Codex reporting branches
- Future dashboard/project coordination work is documented in `openclaw-dashboard/GROUP_BEHAVIOR_POLICY_PLAN.md`

---

## Next Up (priority order)

1. Add structured `group_behavior_policies` storage (see GROUP_BEHAVIOR_POLICY_PLAN.md)
2. Add runtime enforcement for group-scoped file visibility, file creation, and project update permissions
3. Add canonical `projects` and `project_group_bindings`
4. Continue gateway CI/deploy follow-up in `clawdbot-worker`
5. Decide explicit owner-identity mapping for project approval flows

---

## Blockers / Open Questions

- Telegram privacy mode still cannot be verified via Bot API; the dashboard status is manually confirmed from BotFather
- Privacy mode is technically per bot/account, but the current dashboard stores it per group row because Community docs do not yet carry normalized Telegram account IDs
- Verify goimpact cleanup on server (leftover files after dashboard deletion?)

---

## Active Branches / PRs

| Branch                   | PR                              | Status | Owner  | Notes                                       |
| ------------------------ | ------------------------------- | ------ | ------ | ------------------------------------------- |
| chore/staging-deploy-gcp | cryptolir/openclaw#1            | open   | Claude | GCP workflow replacement                    |
| —                        | cryptolir/openclaw#4            | merged | Codex  | Usage report RPC + faster aggregation       |
| —                        | cryptolir/openclaw-dashboard#34 | merged | Codex  | Reports UI + post-merge filter/origin fixes |

---

## Recent Deploys

| Tag           | Date       | Notes                                                                         |
| ------------- | ---------- | ----------------------------------------------------------------------------- |
| v2026.03.28.1 | 2026-03-28 | Gateway usage report RPC rollout on Hetzner + dashboard reports deployed      |
| v2026.03.25.4 | 2026-03-25 | Manual Telegram privacy status stored per Community row + handoff plan update |
| v2026.03.25.3 | 2026-03-25 | Sync Telegram group policy from agent config into Community docs              |
| v2026.03.25.2 | 2026-03-25 | Community-tab per-group privacy review + clarified handoff plan               |
| v2026.03.25.1 | 2026-03-25 | Dashboard privacy review tag + bot-group design note                          |

---

## Quick Reminders

- EU server: `89.167.70.46` (2 agents: openclaw, mikyhelper — goimpact deleted)
- US server: `5.161.84.219` (standby, empty)
- Dashboard: https://openclaw-dashboard-xact3lcvqa-ew.a.run.app
- Registry: `europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway:{tag}`
- Gateway repo: `/Users/liranperetz/clawdbot-worker` → `cryptolir/openclaw`

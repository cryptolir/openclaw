# AgentGlob System V1 Architecture

This is the canonical V1 architecture note for AgentGlob running on OpenClaw. It covers the system boundary across `openclaw-dashboard`, `openclaw`, DevAgents, the production Agent hosts, gateway containers, skills, runtime routes, deployment flow, and runtime environment sources.

The goal is minimum moving parts first: one dashboard control plane, one gateway runtime, one agent workspace layout, one runtime auth pattern, one release path for dashboard, and one release path for gateway images.

## Scope

This document covers:

- AgentGlob dashboard to Agent host deployment flow.
- Agent host filesystem layout and Docker Compose runtime layout.
- Gateway container, workspace, skill, and MCP responsibilities.
- Runtime route pattern for platform-native capabilities such as wallet and Rain.
- Source of truth for environment variables, secrets, image tags, and release flow.

This document does not replace integration-specific API contracts. Rain, wallet, and future integrations should each have their own endpoint and skill contracts, but they should follow the system shape described here.

## Canonical Terms

| Term                  | Meaning                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Agent                 | One full Hetzner Docker Compose deployment managed by the dashboard.                                                           |
| Bot                   | One messaging or public-chat channel inside an Agent.                                                                          |
| Org                   | Dashboard-level tenant unit stored in Firestore. Do not use `workspace` for this dashboard concept.                            |
| Workspace             | The per-Agent local runtime directory on an Agent host, usually `/root/.openclaw/agents/{agent}/workspace`.                    |
| Gateway               | The `openclaw-gateway` container process that receives chat work, runs providers, loads skills, and manages runtime execution. |
| Platform-native skill | A skill shipped by AgentGlob/OpenClaw and optionally paired with dashboard `/api/runtime/*` routes.                            |

## System Planes

| Plane                         | Repo / Location                      | Responsibilities                                                                                                    |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Control plane                 | `openclaw-dashboard` on Cloud Run    | Agent CRUD, Org/RBAC, Firestore state, deploy orchestration, release selection, Secrets UI, runtime adapter routes. |
| Runtime/data plane            | `openclaw` gateway image on Hetzner  | Gateway process, chat execution, provider calls, skill loading, MCP startup, per-Agent workspace isolation.         |
| Development and orchestration | DevAgents `204.168.223.245`          | Routine repo work, builds, gateway image build/push, gateway release orchestration.                                 |
| Production Agent hosts        | EU `89.167.70.46`, US `5.161.84.219` | Run Agent Docker Compose projects and host `/opt/openclaw` plus `/root/.openclaw/agents/*`.                         |

## Topology

```text
Browser / operator
  -> openclaw-dashboard on Cloud Run
     -> Firestore: agents, orgs, secrets metadata, releases
     -> SSH to selected Agent host for deploy/control/logs

Agent host
  /opt/openclaw/docker-compose.yml
  /opt/openclaw/skills/{skill}
  /root/.openclaw/agents/{agent}/docker.env
  /root/.openclaw/agents/{agent}/openclaw.json
  /root/.openclaw/agents/{agent}/workspace
    -> skills/{installed-skill}

Docker Compose project: {agent}
  openclaw-gateway container
    -> loads openclaw.json and workspace
    -> handles chat/providers/MCP/skills
    -> calls dashboard /api/runtime/* for privileged platform actions
```

The dashboard must resolve the Agent's target server from dashboard state before SSH, Docker, gateway RPC, or log access. Do not hardcode a production host for Agent work.

## Dashboard Responsibilities

`openclaw-dashboard` is the control plane. In V1 it owns:

- Agent records, Org access, role checks, and release metadata in Firestore.
- Deploy orchestration through `app/api/agents/deploy/route.ts`.
- Per-Agent environment generation through `lib/agent-server.ts`.
- Runtime authentication through `lib/runtime-auth.ts`.
- Runtime adapter routes under `/api/runtime/*`.
- UI for Secrets, Tools, Wallet status, logs, and deployment controls.

The dashboard should not run long-lived Agent workloads. It prepares state, writes runtime files over SSH, starts or restarts the Agent's Docker Compose project, and serves runtime adapter endpoints called by deployed gateways.

## Gateway Responsibilities

`openclaw` is the runtime/data plane. In V1 it owns:

- The gateway image and `dist/index.js gateway` process.
- Chat execution and model/provider calls.
- Channel providers and public-chat runtime behavior.
- Skill loading from the Agent workspace.
- MCP process startup and runtime command execution.
- Source skill directories under `skills/{name}`.

Platform-native skills should degrade cleanly if required env is missing. They should return actionable messages such as `redeploy this agent with Rain selected` or `set WALLET_PRIVATE_KEY in Secrets`, instead of crashing the gateway process.

## Agent Host Layout

The shared host layout is:

| Path                                           | Owner                       | Purpose                                                                                        |
| ---------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `/opt/openclaw`                                | Gateway release/deploy flow | Runtime repo checkout, shared `docker-compose.yml`, shared host `.env`, bundled source skills. |
| `/opt/openclaw/docker-compose.yml`             | `openclaw` repo             | Shared Compose template for every Agent project.                                               |
| `/opt/openclaw/skills/{skill}`                 | Gateway image/release       | System skill source copied into Agent workspaces during deploy.                                |
| `/root/.openclaw/agents/{agent}/docker.env`    | Dashboard deploy route      | Per-Agent env file consumed by Docker Compose.                                                 |
| `/root/.openclaw/agents/{agent}/openclaw.json` | Dashboard deploy route      | Gateway config and auth token for that Agent.                                                  |
| `/root/.openclaw/agents/{agent}/workspace`     | Gateway runtime             | Agent workspace, memory files, installed skills, and runtime artifacts.                        |

The Compose project name is the Agent name. A running gateway container normally has the name `{agent}-openclaw-gateway-1`.

## Deploy Flow

The V1 deploy flow is:

1. Dashboard receives a deploy request for an Agent.
2. Dashboard loads the existing Agent record, selected skills, workspace secrets, server, port reservation, and optional release tag.
3. Dashboard resolves the target Agent host from the Agent/server record.
4. Dashboard resolves the gateway image:
   - explicit `releaseTag`, when provided;
   - latest stable release, when available;
   - local fallback image only when no registry release is selected.
5. Dashboard writes or reuses the gateway token in `openclaw.json`.
6. Dashboard builds `/root/.openclaw/agents/{agent}/docker.env`.
7. Dashboard bootstraps workspace files such as `SOUL.md`, `MEMORY.md`, and `AGENTS.md` when needed.
8. Dashboard copies each selected skill from `/opt/openclaw/skills/{skill}` to `/root/.openclaw/agents/{agent}/workspace/skills/{skill}`.
9. Dashboard starts or recreates the gateway container with `docker compose --project-name {agent} --env-file {docker.env} up -d --force-recreate openclaw-gateway`.
10. Dashboard updates Firestore with deploy state, gateway token, image/release details, and status.

If a selected skill directory is missing from `/opt/openclaw/skills/{skill}`, deploy must fail visibly for that Agent instead of silently producing a half-configured runtime.

## Environment Sources

Per-Agent `docker.env` is built from multiple sources in priority order:

1. Host-global env: `/opt/openclaw/.env`.
2. Workspace secrets loaded from Firestore via `workspace_secrets`.
3. User-provided deploy secrets in the deploy request.
4. Existing per-Agent `docker.env` values that are not system overrides.
5. System-generated overrides for paths, ports, image, bind mode, and runtime access.

System-generated keys always override prior sources:

- `OPENCLAW_CONFIG_DIR=/root/.openclaw/agents/{agent}`
- `OPENCLAW_WORKSPACE_DIR=/root/.openclaw/agents/{agent}/workspace`
- `OPENCLAW_GATEWAY_PORT={reservedGatewayPort}`
- `OPENCLAW_BRIDGE_PORT={reservedGatewayPort + 1}`
- `OPENCLAW_GATEWAY_BIND=lan`
- `OPENCLAW_IMAGE={resolvedImage}`

Platform-native runtime integrations add these keys only when needed:

- `AGENTGLOB_RUNTIME_URL`
- `AGENTGLOB_RUNTIME_TOKEN`

`AGENTGLOB_RUNTIME_TOKEN` is the Agent's gateway token in V1. Runtime routes validate it by looking up the Agent record and checking the source IP against the known Agent hosts.

## Secret Handling

V1 uses Secrets as the user-facing place to configure credentials. At deploy time, the dashboard carries eligible secret values into the Agent's `docker.env` so the gateway container can use them without storing raw values in frontend-visible responses.

Important current keys:

- `NVIDIA_API_KEY`
- `VENICE_API_KEY`
- `OPENAI_API_KEY`
- `BRAVE_API_KEY`
- `ELEVENLABS_API_KEY`
- `WALLET_PRIVATE_KEY`
- `RAIN_API_KEY`

Owner/member RBAC still applies. Secret values must not be returned to member-role users, and runtime adapter routes must never return private keys or raw provider credentials.

## Runtime Routes

Runtime routes live in `openclaw-dashboard` under `/api/runtime/*`. They are called by deployed gateway containers and platform-native skills, not browsers.

All runtime routes should use `authenticateRuntimeRequest()` from `lib/runtime-auth.ts`. V1 auth gates are:

1. Reject browser-shaped requests with `Origin` or `Cookie` headers.
2. Require `Authorization: Bearer {token}`.
3. Resolve the Agent by matching the bearer token to `gatewayToken`.
4. Require the source IP to be in the known Hetzner Agent host allowlist, except when `OPENCLAW_RUNTIME_DEV_ALLOW_ANY_IP=1` is explicitly set for local development.

Runtime routes should return structured, user-safe errors. They should not expose secrets, raw internal stack traces, or provider credentials.

## Skills

The system skill lifecycle is:

1. Source lives in `openclaw/skills/{skill}`.
2. Gateway release makes it available on hosts at `/opt/openclaw/skills/{skill}`.
3. Dashboard deploy copies selected skills into the Agent workspace under `workspace/skills/{skill}`.
4. Gateway loads the workspace skill at runtime.
5. Skill calls dashboard runtime routes when privileged platform actions are needed.

Current examples:

- `wallet`: active when the deployed Agent has a valid `WALLET_PRIVATE_KEY` available in its per-Agent runtime env. The deploy route auto-installs the wallet skill when wallet presence is detected.
- `rain`: active only when `rain` is explicitly selected in the deploy payload. `RAIN_API_KEY` presence alone must not auto-install Rain.

This distinction prevents a workspace-level credential from silently granting every Agent access to a per-Agent integration.

## Release Flow Source Of Truth

Dashboard release is GitHub Actions based:

- Repo: `openclaw-dashboard`.
- Workflow: `.github/workflows/deploy.yml`.
- Trigger: push to `main`.
- Steps: `npm ci`, `npx tsc --noEmit`, `npm run build`, Cloud Run deploy, auto-tag.

Gateway/Agent runtime release is the DevAgents ops-script flow:

- Build and push from DevAgents: `/opt/openclaw-ops/scripts/build-and-push.sh <tag>`.
- Deploy from DevAgents: `/opt/openclaw-ops/scripts/deploy.sh <tag> [1stclaw|2ndclaw|all]`.
- Registry: `europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway`.
- Tag format: `vYYYY.M.D.N` or `vYYYY.M.D.N-hotfix`.

`deploy.sh` pulls the tagged image on the target host, updates `OPENCLAW_IMAGE` in each Agent's `docker.env`, rolls one Agent at a time, checks that the container is running, and rolls back a failed Agent to its previous image.

The `openclaw` GitHub workflow `.github/workflows/docker-release.yml` builds GHCR images for the upstream OpenClaw package. It currently ignores docs and `skills/**`, and it is not the AgentGlob production gateway rollout path.

## Stability Requirements

V1 should enforce these operational checks before declaring an Agent healthy:

- Required selected skill directories exist on the host before deploy completes.
- `docker.env` contains required runtime env for active platform-native skills.
- Gateway container reaches `running` state after restart.
- Runtime adapter endpoints reject unauthenticated calls and accept calls from the deployed Agent host.
- MCP command paths are validated before startup or isolated so a broken MCP does not crash chat.
- Known-bad model/provider request-shape failures should clear only the affected session and fall back to an approved model policy, not poison all sessions.

## Operational Guardrails

- Do not edit production Agent `docker.env` by hand except for explicit emergency repair work.
- Do not run ad hoc Docker builds or direct `docker compose up` as the normal gateway release path.
- Do not hardcode EU or US production hosts in integration logic.
- Do not store integration credentials in custom per-feature CRUD tables when Secrets can hold them.
- Do not let secret presence alone enable per-Agent integrations that require explicit operator selection.
- Do not let platform-native skills crash the gateway when env is missing; return a clear remediation message.

## Acceptance Criteria

System V1 is concrete enough when:

1. A new engineer can explain dashboard to Agent host to gateway container to skill flow from this document alone.
2. A new platform-native integration can follow the existing runtime route plus skill pattern without inventing a new credential store.
3. Dashboard and gateway release flows are unambiguous and point to the current scripts or workflows.
4. Operators can identify where an Agent's config, env, workspace, skills, logs, and image tag live on the host.
5. Claude and Codex can use this document as the shared architecture reference before changing deploy, runtime, skill, or monitoring behavior.

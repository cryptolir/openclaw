# Plan — Canonical Skill Registry

> Status: **v2 — Codex review incorporated, ready for implementation**
> Author: Claude (handover-paired)
> Reviewer: Codex (see PR #46 comment thread)
> Target branches when implemented:
>
> - `feat/skill-registry-manifest` (worker — Phase 1 worker side)
> - `feat/skill-registry-install-ui` (dashboard — Phase 1 dashboard side)
> - `feat/skill-registry-drift` (dashboard — Phase 2)
> - `feat/skill-registry-fleet` (dashboard + worker — Phase 3)
>
> **v2 changes:** §1 reframed (existing host-checkout path acknowledged); §4 decision changed (committed manifest carries source metadata only, not image-tag version); §5.1/§5.3 manifest schema split into committed source-side fields + runtime-attached image metadata; §6.2 dashboard file paths corrected to match current code layout; §11 open questions resolved with Codex's answers; new §13 added documenting interaction with the existing `/opt/openclaw/skills` host-checkout path.

---

## 1. Background

While verifying the PR #45 deploy on the `raingame` agent (commit `06a172edd`), we observed that PR #45's expanded `rain` skill and new `rain-create` skill are present in the gateway image at `/app/skills/` but:

- raingame's workspace still carries the PR #19-era rain skill body, unchanged after the image rollout.
- The dashboard's `+ Install Skill` dialog is a **freeform paste editor** with no awareness of the image's bundled skills.

The shipping picture is more nuanced than "no path exists" — per Codex's review, there is an **existing host-checkout shipping path**:

```
┌────────────────────────┐    ┌──────────────────────────────┐    ┌────────────────────────────┐
│  Worker repo           │    │  Dashboard host              │    │  Agent workspace           │
│  skills/rain/SKILL.md  │ →  │  /opt/openclaw/skills/rain/  │ →  │  workspace/skills/rain/    │
│  (source in git)       │    │  (server-side checkout)      │    │  (copied at first deploy)  │
└────────────────────────┘    └──────────────────────────────┘    └────────────────────────────┘
```

Dashboard `/api/skills` reads from `/opt/openclaw/skills`; deploy copies selected skills into `/root/.openclaw/agents/<name>/workspace/skills` **before** `docker compose up`. That's why first-time skill installs work today.

The real gaps:

1. **No image/release-backed canonical provenance.** Skills shipped via host checkout drift from what's actually baked into the deployed gateway image. After the image rolls to a newer tag, the agent's workspace still has whatever was on the dashboard host at first-deploy time.
2. **No body-hash drift detection.** Workspace skill bodies can be edited, replaced, or fall behind canonical with no signal.
3. **No fleet update path.** Updating a canonical skill across N agents is a manual paste job per agent.
4. **No version tracking per agent.** No record of which canonical version any installed skill came from.

The gateway image itself bundles `/app/skills/` (canonical source content), but that content is currently unused — the dashboard reads from `/opt/openclaw/skills` instead, which is the dashboard host's checkout, not the deployed image.

This blocks the wallet-level create-market gate (planned safety follow-up) — that gate needs to refuse signing unless the `rain-create` skill is enabled, and "enabled" requires reliable provenance metadata that does not exist today.

## 2. Goals

Add an explicit fourth layer — a **canonical skill registry** — that wires the chain end-to-end:

```
Worker repo → Image (with manifest) → Canonical Registry endpoint → Agent workspace (tagged with provenance)
```

Concretely:

1. The worker repo bundles a machine-readable `skills/manifest.json` listing every canonical skill, its version, frontmatter metadata, and SKILL.md path.
2. The gateway exposes the manifest at `GET /skills/bundled` (Phase 1), so the dashboard can discover what skills are shippable per-agent.
3. The dashboard gains an `Install from Canonical` install path alongside the existing freeform editor, tagging installed skills with `meta.source = "canonical/<name>@<version>"`.
4. The dashboard surfaces drift between installed and canonical versions (Phase 2).
5. Operators can bulk-update canonical skills across agents (Phase 3).

End state: shipping a new skill is a worker PR, a gateway image build, and a one-click install in the dashboard. No more paste workflow for canonical content.

## 3. Non-goals

- No new MCP server or new tool surface.
- No removal of the freeform `Install Custom Skill` dialog — users can still paste arbitrary SKILL.md content. We are adding a second install path, not replacing one.
- No skills marketplace UI (browsing across teams / sharing). That is a separate, larger product question — the canonical registry is a precondition, not a delivery.
- No automatic skill installation at agent creation. Phase 3 includes opt-in auto-sync but not auto-install.

## 4. Locked decisions

These were resolved upfront and refined per Codex's v1 review:

| Question                                               | Decision                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 alone or commit all 3 upfront?                 | **Commit all 3.** Phase 1 ships first, but the architecture (manifest schema, provenance tagging, body-hash drift) accommodates 2 and 3 from day one.                                                                                                                                                                                                               |
| Where does the dashboard get the manifest?             | **Two sources, depending on agent state.** _Running agents:_ per-agent gateway endpoint (`GET /skills/bundled`) — authoritative for what's actually in `/app/skills/` on the running container. _Pre-boot / first deploy:_ host-checkout fallback at `/opt/openclaw/skills` (already used by the existing deploy flow). Per-image release-record source is Phase 3. |
| `skills/manifest.json` — committed or build-time only? | **Committed to git, but with source-side metadata only.** No image-tag-derived `version` in the committed file (that conflicts with the fact that the image tag is chosen at build time, not commit time). Image / runtime metadata is attached by the gateway endpoint or by the dashboard at install time. See §5.1.                                              |
| What counts as "version"?                              | **bodyHash is the load-bearing identity.** A version string (image tag / git SHA) is metadata; drift detection compares hashes. This sidesteps the manifest-vs-image-tag race entirely.                                                                                                                                                                             |

## 5. Architecture

### 5.1 Manifest schema

Two layers — **committed source manifest** and **runtime envelope**.

#### Committed (`skills/manifest.json` in worker repo)

Source-side metadata only. No image tag. One entry per canonical skill:

```json
[
  {
    "name": "rain",
    "description": "Prompt-level guidance for the Rain prediction-market integration...",
    "emoji": "🌧️",
    "requires": { "env": ["AGENTGLOB_RUNTIME_URL", "AGENTGLOB_RUNTIME_TOKEN"] },
    "path": "skills/rain/SKILL.md",
    "bodyHash": "sha256:abcd1234..."
  },
  {
    "name": "rain-create",
    "description": "...",
    "emoji": "🆕",
    "requires": { "env": ["AGENTGLOB_RUNTIME_URL", "AGENTGLOB_RUNTIME_TOKEN"] },
    "path": "skills/rain-create/SKILL.md",
    "bodyHash": "sha256:efgh5678..."
  }
]
```

`bodyHash` is the sha256 of the SKILL.md body (post-frontmatter). This is the canonical identity used by drift detection — it changes only when the prompt content changes.

#### Runtime envelope (returned by `GET /skills/bundled`)

The gateway endpoint wraps the committed manifest with image / runtime metadata:

```json
{
  "imageTag": "v2026.05.24.1",
  "imageSha": "sha256:710942989f24...",
  "sourceSha": "f84991e3a",
  "generatedAt": "2026-05-24T08:00:00Z",
  "skills": [
    /* the committed manifest entries above */
  ]
}
```

`imageTag` and `imageSha` are read from build-time env at gateway startup (set during `docker build`). `sourceSha` is the worker repo SHA at manifest generation. The committed file does not embed any of these — they are runtime-attached.

### 5.2 Provenance tagging on installed skills

When a skill is installed via the canonical path, the dashboard writes a sibling metadata file alongside the SKILL.md:

```
workspace/skills/rain/SKILL.md
workspace/skills/rain/.openclaw-source.json   ← new
```

`.openclaw-source.json`:

```json
{
  "source": "canonical",
  "name": "rain",
  "bodyHash": "sha256:abcd1234...",
  "installedAt": "2026-05-24T08:00:00Z",
  "installedFromImageTag": "v2026.05.24.1",
  "installedFromImageSha": "sha256:710942989f24..."
}
```

`bodyHash` is what drift detection compares against (the load-bearing identity per §4). `installedFromImageTag` / `installedFromImageSha` are informational — they record which gateway image the skill was installed from, useful for audit and the Phase 3 fleet matrix. They are **not** used for drift detection (a newer image with the same bodyHash means no update needed).

Three states for an installed skill, derived from this file + body hash:

| State                | `.openclaw-source.json` exists? | Body hash matches recorded? |
| -------------------- | ------------------------------- | --------------------------- |
| `canonical-clean`    | Yes                             | Yes                         |
| `canonical-modified` | Yes                             | No (user edited)            |
| `custom`             | No                              | n/a                         |

### 5.3 Version semantics

The committed manifest has **no version field**. Identity is `bodyHash`. Two ways the UI talks about "version":

- **In the committed manifest**: there is no version. The `bodyHash` is the durable identity.
- **In the gateway envelope (`GET /skills/bundled`)**: `imageTag` and `imageSha` describe the deployed image at runtime. They're attached server-side, not committed.
- **In `.openclaw-source.json`** (per installed skill): `bodyHash` is what drift detection compares; `installedFromImageTag` is a human-readable audit field.

Why this split:

- The image tag is chosen at build time (`v2026.05.24.1`), not commit time. A committed manifest with a fixed version would either be wrong on every PR, or require a manifest-only commit after every build. Avoided.
- `bodyHash` is stable across image rebuilds with the same content — exactly what drift detection wants.
- Operators still see image tags (everywhere they already see them) via the runtime envelope and the per-skill provenance file.

Migration path to per-skill semver later: add an optional `version` field to frontmatter, fold it into the committed manifest. Backwards-compatible.

### 5.4 Endpoint surface

```
GET /skills/bundled
  → Returns the runtime envelope (§5.1) wrapping the committed manifest with imageTag/imageSha.
  Cacheable; cache key = gateway image SHA.
  Auth: same as other gateway endpoints (bearer token).

GET /skills/bundled/:name
  → Returns the SKILL.md body for one canonical skill.
  Used by the dashboard's "install" action to fetch content without
  re-shipping it through the manifest.
  Auth: same.
```

Both endpoints read from `/app/skills/manifest.json` and `/app/skills/<name>/SKILL.md` respectively. No filesystem traversal outside `/app/skills/`.

### 5.5 Pre-boot install path

The endpoint above only works for **running** agents. For first-deploy (before any gateway container has started), the dashboard uses the existing host-checkout source at `/opt/openclaw/skills` (already used by today's deploy flow). The bodyHash check still applies — what was copied into the workspace is hashed and recorded in `.openclaw-source.json`, with `installedFromImageTag` left null (or set to "pending: first-boot") until the agent boots and the dashboard can reconcile against the gateway endpoint.

**Skew risk documented:** the host-checkout source can be staler than what the agent's image actually carries (the host pulls from worker repo on a different schedule than agent images are built). For Phase 1 we accept this. Phase 3 introduces release-record-based first-boot installs that pin to image SHA and eliminate the skew.

## 6. Phase 1 — Install from canonical (MVP)

### 6.1 Worker side (`feat/skill-registry-manifest`)

- **Add `scripts/generate-skills-manifest.ts`** — walks `skills/*/SKILL.md`, parses frontmatter (gray-matter or equivalent), computes body hash (sha256 of post-frontmatter content), writes `skills/manifest.json`. **No version field in the output** — see §4 and §5.3.
- **Add a pre-commit hook** (`git-hooks/pre-commit-skills-manifest`) that runs the generator and fails if the committed manifest doesn't match. Wired into the existing pre-commit infrastructure.
- **Add CI step** running the same check.
- **Add gateway routes** `GET /skills/bundled` and `GET /skills/bundled/:name`. The bundled route returns the **runtime envelope** (§5.1) — committed manifest + `imageTag`/`imageSha` read from build-time env (`OPENCLAW_IMAGE_TAG`, `OPENCLAW_IMAGE_SHA` injected by the Dockerfile / build script). Tests cover (a) envelope shape, (b) manifest entries match committed file, (c) per-skill body matches the file on disk, (d) auth required, (e) unknown skill name returns 404. Route wiring should follow the gateway's current HTTP handler convention (likely `src/gateway/server-*` style, not a new `routes/` directory — confirm with existing code layout during implementation).
- **Dockerfile**: add two `ARG`s (`OPENCLAW_IMAGE_TAG`, `OPENCLAW_IMAGE_SHA`) and `ENV` them into the container so the gateway can read them at runtime. Pass via `--build-arg` in `build-and-push.sh`.
- **Commit `skills/manifest.json`** as the initial canonical snapshot.

Files touched in worker:

```
scripts/generate-skills-manifest.ts         (new)
git-hooks/pre-commit-skills-manifest        (new)
src/gateway/routes/skills-bundled.ts        (new)
src/gateway/routes/skills-bundled.test.ts   (new)
skills/manifest.json                        (new, committed)
docs/skills-manifest.md                     (new — schema docs)
package.json                                (add generator npm script)
.github/workflows/ci.yml                    (add manifest check)
```

### 6.2 Dashboard side (`feat/skill-registry-install-ui`)

Current dashboard skills UI/API layout (per Codex's read of the code) is **largely inline** in the agent page, not split into per-feature components. The plan below is aspirational at the file-path level; the implementer should either (a) extract the relevant components/routes as part of this work, or (b) inline the new UI in the same locations as the existing skills code.

- **Dashboard API** `GET /api/agents/[agentId]/skills/canonical` — proxies to the agent's gateway `GET /skills/bundled` (when the agent is running) or reads from `/opt/openclaw/skills` (pre-boot). Returns the runtime envelope plus, for each entry, an `installed` field (`canonical-clean`, `canonical-modified`, `custom`, or `not-installed`).
- **Dashboard API** `POST /api/agents/[agentId]/skills/canonical/:name/install` — fetches the body from the canonical source (gateway endpoint or host checkout), writes both `SKILL.md` and `.openclaw-source.json` into the agent workspace.
- **Skills tab UI** — new "Install from Canonical" button next to the existing "Install Custom Skill" button. Opens a picker modal listing manifest entries with name, emoji, description, installed-state badge, and (when known) image tag the canonical source comes from. Click a row → install → toast + refresh skills list.
- **Skill card** in the agent's Skills list — show a small badge for `canonical-clean` / `canonical-modified` / `custom`. Hover tooltip shows the `bodyHash` short prefix and the recorded `installedFromImageTag`.

Files touched in dashboard (likely locations — confirm against actual layout during implementation):

```
app/api/agents/[agentId]/skills/canonical/route.ts                (new)
app/api/agents/[agentId]/skills/canonical/[name]/install/route.ts (new)
app/dashboard/[workspaceSlug]/agents/[agentId]/page.tsx           (extend — skills tab UI lives here today; either inline new picker or extract during this work)
lib/skills/canonical-state.ts                                     (new — bodyHash compare logic + canonical/modified/custom classification)
lib/skills/agent-workspace.ts                                     (extend or new — write SKILL.md + .openclaw-source.json into workspace)
lib/skills/canonical-source.ts                                    (new — gateway-endpoint-or-host-checkout source resolver)
```

The existing `/api/agents/[agentId]/skills` routes and `/api/skills` (host-checkout reader) remain unchanged — the canonical flow is additive.

### 6.3 Acceptance for Phase 1

- [ ] `pnpm run generate-skills-manifest` produces a committed `skills/manifest.json` matching every `skills/*/SKILL.md` file.
- [ ] Pre-commit hook + CI both fail when manifest is out of sync.
- [ ] `GET /skills/bundled` on a deployed gateway returns the manifest; `GET /skills/bundled/rain` returns the SKILL.md body.
- [ ] Dashboard Skills tab on raingame shows `rain-create` as an "Install from Canonical" option.
- [ ] Installing `rain-create` from the dashboard writes the file and `.openclaw-source.json` into the agent workspace; reloading shows it in the skills list with the `canonical-clean` badge.
- [ ] Reinstalling `rain` via canonical replaces the stale PR #19-era body with PR #45's content.

## 7. Phase 2 — Drift detection (`feat/skill-registry-drift`)

Dashboard-only work, depends on Phase 1's provenance tagging.

- **Dashboard API** extends `GET /api/agents/[agentId]/skills/canonical` to compute the `installed` state per entry by hashing the workspace SKILL.md body and comparing to `.openclaw-source.json`'s recorded hash.
- **"Update available"** badge on canonical-tagged skills when the agent's gateway image carries a newer canonical version (manifest entry's `bodyHash` differs from the recorded one). Modified-locally skills also show a warning but no update prompt (operator chooses).
- **One-click "Update from Canonical"** action — same code path as install. When state is `canonical-modified`, pre-warns ("local edits will be overwritten") and writes a timestamped backup at `workspace/skills/<name>/SKILL.md.backup.<ISO8601>` before overwriting (§11.2).
- **Backwards-compat scan** — on Phase 2 deploy, a one-time admin action scans every agent's `workspace/skills/*` and:
  - If the body matches the bodyHash of any historical canonical version, auto-tags it as `canonical-clean` for that version (best-effort migration).
  - Otherwise leaves it as `custom`.

### 7.1 Acceptance for Phase 2

- [ ] Skill card shows the right state badge for each of: clean, modified, custom, update-available.
- [ ] Update-from-canonical replaces the body and refreshes the `.openclaw-source.json` to the new version.
- [ ] Modified-locally update shows a confirm dialog before overwriting.
- [ ] Backwards-compat scan correctly tags existing rain skills on agents that match canonical history.

## 8. Phase 3 — Fleet operations (`feat/skill-registry-fleet`)

Dashboard + small worker addition.

- **Admin "Skill Matrix" view** — table of agents × installed canonical skills, showing per-cell: `bodyHash` short prefix, state badge, `installedFromImageTag`, and the agent's currently-deployed image tag. Filterable by skill name, state, host. The matrix surfaces version skew at a glance — e.g. agents whose image tag is older than the latest pushed tag, or agents whose installed body lags the canonical body their own image carries.
- **Bulk update action** — "Update `rain` from canonical on all agents whose current image carries the target canonical `bodyHash`". This decision (§11.4) means agents on older images are flagged "upgrade gateway image first" rather than silently skipped. Excludes `canonical-modified` by default (operator can opt in per-agent, which triggers the backup-then-overwrite flow from §7).
- **Per-agent `autoSyncCanonicalSkills` config** — when true, the dashboard's deploy flow automatically refreshes any `canonical-clean` skill whose recorded `bodyHash` differs from the new image's manifest. (`canonical-modified` and `custom` are never touched automatically.) This is the behavior the user intuitively expected when they redeployed raingame.
- **Release-record-pinned first-boot installs** — Phase 1's host-checkout fallback (§5.5) is replaced here. The dashboard's deploy flow consults the release record for the target image tag, gets the canonical manifest+bodies pinned to that image SHA, and installs them into the workspace before `docker compose up`. Eliminates host-checkout skew.
- **Worker addition**: when the build-and-push script registers a release (`POST /api/platform/releases`), it includes the manifest content (or a stable retrieval URL). The dashboard stores this for the Phase 3 release-record install path.

### 8.1 Acceptance for Phase 3

- [ ] Admin matrix view loads for the fleet and surfaces version skew at a glance.
- [ ] Bulk update runs end-to-end against a 5+ agent test fleet with mixed states.
- [ ] `autoSyncCanonicalSkills: true` on an agent causes its canonical-clean skills to refresh on the next dashboard redeploy without manual action.

## 9. Implementation order

1. Worker `feat/skill-registry-manifest` PR — generator, hook, routes, manifest commit, tests.
2. Worker image rebuild + push (`v2026.05.<N>.<seq>`).
3. Dashboard `feat/skill-registry-install-ui` PR — API + UI. Land independently; non-canonical install still works in the interim.
4. Dashboard `feat/skill-registry-drift` PR — adds Phase 2 state computation + update flow.
5. Dashboard + worker `feat/skill-registry-fleet` PR — Phase 3 matrix, bulk action, auto-sync.

Phases 2 and 3 can ship in either order; Phase 1 is a hard prerequisite for both.

## 10. Out of scope / follow-ups

- Skills marketplace / cross-team browsing.
- Skill semver decoupled from image tag.
- Skill dependency graph (`requires.skills` in frontmatter, enforced — currently flagged as unsupported in PR #44).
- Wallet-level `rain_build_create_market` gate — depends on canonical provenance (`meta.source` check), so the wallet gate lands after Phase 1.
- Allowing users to publish back to canonical (a "promote my custom skill to canonical" workflow) — not in scope; canonical entries only originate from the worker repo.

## 11. Decisions (resolved by Codex review)

1. **First-boot install path.** **Do not defer until first gateway boot.** Use the existing host-checkout fallback at `/opt/openclaw/skills` for pre-boot installs (already wired into the deploy flow today). Use `GET /skills/bundled` once the agent is running. Skew risk between host checkout and image is documented (§5.5) and accepted for Phase 1; release-record-pinned first-boot installs land in Phase 3.
2. **`canonical-modified` overwrite policy.** **Always allow, with a strong warning and an automatic timestamped backup.** Fleet bulk updates exclude modified skills by default and require explicit per-agent opt-in. Backup format: `workspace/skills/<name>/SKILL.md.backup.<ISO8601>` next to the original.
3. **Manifest body inlining.** **Keep separate fetch in Phase 1.** Manifest stays small/cacheable; body fetch happens only on install/update click. Add `?includeBody=1` later if install latency becomes a real issue.
4. **Multi-server fleets / version skew.** **Phase 3 matrix shows the manifest version actually reported by each agent's running gateway.** Bulk update operates only on agents whose current image carries the target canonical `bodyHash`. Agents with older images are flagged as "upgrade gateway image first" rather than silently skipped.

## 12. Why this blocks the wallet gate

The originally-planned next ticket was `feat/wallet-create-market-gate` (from PR #44 §11 — wallet sign-tx refuses factory-create calls unless the agent has `rain-create` enabled). That gate is built on top of skill provenance:

- "Does the agent have `rain-create` enabled?" only has a meaningful answer if installed skills carry canonical provenance metadata. Without it, the gate either fires on the name string (trivially bypassable by renaming) or doesn't fire at all.
- Operators need a reliable way to install `rain-create` on agents that should be allowed to create markets. The host-checkout path works today for first-deploy, but has no provenance tagging — so the wallet gate cannot tell "rain-create from canonical (signing allowed)" apart from "rain-create freeform paste (signing should require operator review)".

Land Phase 1 first; the wallet gate becomes straightforward after — it checks `.openclaw-source.json` for `source: "canonical"` and `name: "rain-create"` before allowing the factory-create signature.

## 13. Interaction with the existing host-checkout path

For background, the current shipping flow:

```
worker repo  →  dashboard host pulls into /opt/openclaw/skills  →  deploy copies selected
                                                                    → /root/.openclaw/agents/<name>/workspace/skills
```

This is the path that delivered the PR #19-era rain skill to raingame and never updated it. It works for first-deploy because the copy happens **before** `docker compose up`, when the agent's gateway can't be queried.

The canonical registry plan **does not replace this path**. Instead:

- **Phase 1**: the path stays as-is. New "Install from Canonical" UI uses the gateway endpoint when the agent is running and falls back to reading `/opt/openclaw/skills` when it isn't. Provenance file is written either way.
- **Phase 2**: drift detection compares workspace `bodyHash` against the gateway's bundled hash. The host checkout falls out of the comparison loop — its body might be stale relative to the image, but the agent's installed skill body is what's checked.
- **Phase 3**: an opt-in `autoSyncCanonicalSkills` agent config refreshes canonical-clean skills on each redeploy. This effectively replaces the host-checkout's role for canonical content. The host checkout becomes a Phase-1-only artifact and can be retired later (separate ticket — not in scope for this plan).

Risks of running both paths:

- **Host-checkout drift from image.** If the dashboard host pulls worker repo later than a new image was built, first-deploys could install older skill bodies than the image carries. The `.openclaw-source.json`'s `installedFromImageTag` will record "pre-boot host-checkout" so this is auditable; subsequent runs of the agent will reconcile against the gateway endpoint and surface the drift as "update available".
- **Operator confusion.** Two install paths (paste + canonical) on the same UI surface. Mitigated by the existing freeform editor being labeled "Install Custom Skill" and the new picker being labeled "Install from Canonical" — they're visually distinct and serve different intents.

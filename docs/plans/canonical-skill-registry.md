# Plan — Canonical Skill Registry

> Status: **proposal, awaiting review** (no code changes yet)
> Author: Claude (handover-paired)
> Reviewer: Codex
> Target branches when implemented:
>
> - `feat/skill-registry-manifest` (worker — Phase 1 worker side)
> - `feat/skill-registry-install-ui` (dashboard — Phase 1 dashboard side)
> - `feat/skill-registry-drift` (dashboard — Phase 2)
> - `feat/skill-registry-fleet` (dashboard + worker — Phase 3)

---

## 1. Background

While verifying the PR #45 deploy on the `raingame` agent (commit `06a172edd`), we discovered the dashboard's `Install Skill` dialog is **a freeform paste editor** — it does not list, surface, or reference the skills bundled in the gateway image at `/app/skills/`. The "skills" exist in three disconnected layers:

```
┌──────────────────────────┐       ┌──────────────────────────┐       ┌──────────────────────────┐
│  Worker repo             │       │  Gateway image           │       │  Agent workspace         │
│  skills/rain/SKILL.md    │  →    │  /app/skills/rain/...    │   ✗   │  workspace/skills/rain/  │
│  (source of truth in git)│       │  (baked at build time)   │       │  (user-pasted content)   │
└──────────────────────────┘       └──────────────────────────┘       └──────────────────────────┘
                                                       ↓
                                                no shipping path
```

The `image → workspace` hop is broken. Consequences:

- PR #45's expanded rain skill and the new rain-create skill are in the image but invisible to operators in the dashboard.
- Existing per-agent skill content (e.g. raingame's rain skill, still on PR #19-era content) never updates regardless of how many gateway image upgrades happen.
- There is no per-agent skill version tracking, no drift detection, no fleet update.
- The worker repo's `skills/*/SKILL.md` files are effectively documentation — they don't actually deploy.

This blocks the wallet-level create-market gate (planned as the next safety follow-up) — that gate needs to refuse signing unless the `rain-create` skill is enabled, but operators have no reliable way to install `rain-create` on agents today.

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

These were resolved before drafting the plan:

| Question                                               | Decision                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 alone or commit all 3 upfront?                 | **Commit all 3.** Phase 1 ships first, but the architecture (manifest schema, provenance tagging, version semantics) accommodates 2 and 3 from day one.                                                                             |
| Where does the dashboard get the manifest?             | **Per-agent gateway endpoint** (`GET /skills/bundled`). Each agent reports the manifest carried by its gateway image. No central dashboard cache in Phase 1 (revisit in Phase 3 if needed).                                         |
| `skills/manifest.json` — committed or build-time only? | **Committed to git.** A pre-commit hook regenerates it; CI verifies it matches the SKILL.md files. Committing makes the manifest reviewable in PRs and surfaces accidental drift between SKILL.md and manifest at code-review time. |

## 5. Architecture

### 5.1 Manifest schema

`skills/manifest.json` is an array, one entry per canonical skill:

```json
[
  {
    "name": "rain",
    "version": "2026.05.24.1",
    "description": "Prompt-level guidance for the Rain prediction-market integration...",
    "emoji": "🌧️",
    "requires": { "env": ["AGENTGLOB_RUNTIME_URL", "AGENTGLOB_RUNTIME_TOKEN"] },
    "path": "skills/rain/SKILL.md",
    "bodyHash": "sha256:abcd1234..."
  },
  {
    "name": "rain-create",
    "version": "2026.05.24.1",
    ...
  }
]
```

`version` ties to the gateway image tag (decision 5.3 below). `bodyHash` is the sha256 of the SKILL.md body (post-frontmatter) — used by drift detection in Phase 2.

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
  "version": "2026.05.24.1",
  "installedAt": "2026-05-24T08:00:00Z",
  "bodyHash": "sha256:abcd1234..."
}
```

Three states for an installed skill, derived from this file + body hash:

| State                | `.openclaw-source.json` exists? | Body hash matches recorded? |
| -------------------- | ------------------------------- | --------------------------- |
| `canonical-clean`    | Yes                             | Yes                         |
| `canonical-modified` | Yes                             | No (user edited)            |
| `custom`             | No                              | n/a                         |

### 5.3 Version semantics

`version` in the manifest is the **gateway image tag** that bundled this canonical content (e.g. `2026.05.24.1`). Rationale:

- One source of truth per release. No separate semver bookkeeping per skill.
- Trivial to derive at build time.
- Operators recognize the format — same as image tags they already see.
- Migration to per-skill semver later is a frontmatter-only change.

When the manifest is regenerated, every entry takes the current image tag (read from env / CI). If a SKILL.md body hasn't changed, the version still bumps — that's intentional. The dashboard's drift detection compares **bodyHash**, not version string, so unchanged bodies show "no update needed" even when the version number bumped.

### 5.4 Endpoint surface

```
GET /skills/bundled
  → Returns the full manifest array. Cacheable; cache key = gateway image SHA.
  Auth: same as other gateway endpoints (bearer token).

GET /skills/bundled/:name
  → Returns the SKILL.md body for one canonical skill.
  Used by the dashboard's "install" action to fetch content without
  re-shipping it through the manifest.
  Auth: same.
```

Both endpoints read from `/app/skills/manifest.json` and `/app/skills/<name>/SKILL.md` respectively. No filesystem traversal outside `/app/skills/`.

## 6. Phase 1 — Install from canonical (MVP)

### 6.1 Worker side (`feat/skill-registry-manifest`)

- **Add `scripts/generate-skills-manifest.ts`** — walks `skills/*/SKILL.md`, parses frontmatter (gray-matter or equivalent), computes body hash, reads `version` from a build-time env var (CI passes the image tag), writes `skills/manifest.json`.
- **Add a pre-commit hook** (`git-hooks/pre-commit-skills-manifest`) that runs the generator and fails if the committed manifest doesn't match. Wired into the existing pre-commit infrastructure.
- **Add CI step** running the same check.
- **Add gateway routes** `GET /skills/bundled` and `GET /skills/bundled/:name` in the existing gateway router. Tests cover (a) manifest returns expected entries, (b) per-skill body matches the file on disk, (c) auth required, (d) unknown skill name returns 404.
- **Dockerfile**: no change needed — `/app/skills/` is already in the image. Manifest is committed so it ships with the rest of the source.
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

- **Dashboard API** `GET /api/agents/[agentId]/skills/canonical` — proxies to the agent's gateway `GET /skills/bundled`. Returns the manifest plus, for each entry, an `installed` field (`canonical-clean`, `canonical-modified`, `custom`, or `not-installed`).
- **Dashboard API** `POST /api/agents/[agentId]/skills/canonical/:name/install` — fetches the body from the agent's gateway, writes both `SKILL.md` and `.openclaw-source.json` into the agent workspace.
- **Skills tab UI** — new "Install from Canonical" button next to the existing "Install Custom Skill" button. Opens a picker modal listing manifest entries with name, emoji, description, version, and installed-state badge. Click a row → install → toast + refresh skills list.
- **Skill card** in the agent's Skills list — show a small badge for `canonical-clean` / `canonical-modified` / `custom`. Hover tooltip shows the version.

Files touched in dashboard:

```
app/api/agents/[agentId]/skills/canonical/route.ts                (new)
app/api/agents/[agentId]/skills/canonical/[name]/install/route.ts (new)
lib/skills/canonical-state.ts                                     (new — hash compare logic)
lib/skills/agent-workspace.ts                                     (extend — write .openclaw-source.json)
components/agent/skills-tab.tsx                                   (extend — add canonical install button + picker)
components/agent/skill-card.tsx                                   (extend — provenance badge)
```

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
- **One-click "Update from Canonical"** action — same code path as install, but pre-warns when state is `canonical-modified` ("local edits will be overwritten").
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

- **Admin "Skill Matrix" view** — table of agents × installed canonical skills, showing version + state for each cell. Filterable by skill name, state, host.
- **Bulk update action** — "Update `rain` from canonical on all agents with `canonical-clean` state". Excludes `canonical-modified` by default (operator can opt in per-agent). Runs as a backgrounded job, reports per-agent success/failure.
- **Per-agent `autoSyncCanonicalSkills` config** — when true, the dashboard's deploy flow automatically refreshes any `canonical-clean` skill whose recorded version is older than the new image's manifest. (`canonical-modified` and `custom` are never touched automatically.) This is the behavior the user intuitively expected when they redeployed raingame.
- **Worker addition**: optional `GET /skills/bundled?since=<version>` query param to return only manifest entries newer than the recorded version on a given agent, used by the auto-sync diff.

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

## 11. Open questions for reviewer

1. **Manifest discoverability across non-running agents.** `GET /skills/bundled` only works when the agent's gateway is up. If we need to install canonical skills on a freshly created agent before its first gateway boots, the dashboard needs an alternative source. Two options: (a) ship the manifest as part of each gateway image's release record (the dashboard already tracks image SHA per agent), (b) defer until first boot. **My read:** defer (option b) — simpler, and a freshly created agent has nothing to lose by waiting one boot cycle.
2. **`canonical-modified` policy.** Should the dashboard ever refuse to overwrite a modified skill, or always allow with a warning? **My read:** always allow with a warning. Operators are trusted; lock-out friction is worse than the rare accidental overwrite.
3. **Manifest body inlining.** The manifest carries `bodyHash` but not the body. An alternative is to inline the body in the manifest (saves one round trip on install). **My read:** keep them separate — manifest stays small/cacheable, body fetch is one extra request only on click. If install latency becomes a problem we can add inlining.
4. **Multi-server fleets.** If two agents on different hosts run different gateway image versions, their canonical manifests differ. The admin matrix view in Phase 3 needs to handle this. **My read:** show both versions in the matrix; bulk update operates per-version, refusing the action on agents whose image doesn't carry the target canonical version (they need a gateway image upgrade first).

## 12. Why this blocks the wallet gate

The originally-planned next ticket was `feat/wallet-create-market-gate` (from PR #44 §11 — wallet sign-tx refuses factory-create calls unless the agent has `rain-create` enabled). That gate is built on top of skill provenance:

- "Does the agent have `rain-create` enabled?" only has a meaningful answer if installed skills carry canonical provenance metadata. Without it, the gate either fires on the name string (trivially bypassable by renaming) or doesn't fire at all.
- Operators need a reliable way to install `rain-create` on agents that should be allowed to create markets. Today the only path is paste — which is exactly the gap this plan closes.

Land Phase 1 first; the wallet gate becomes straightforward after.

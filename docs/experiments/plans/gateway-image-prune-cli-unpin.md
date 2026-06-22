---
summary: "Stop the recurring US disk P0 by removing the dead openclaw-cli one-shot containers that pin stale gateway images, so the existing daily prune can actually reclaim them"
owner: "openclaw"
status: "proposed"
last_updated: "2026-06-22"
title: "Gateway-Image Prune: Unpin Stale Tags from Dead CLI Containers"
---

# Gateway-Image Prune: Unpin Stale Tags from Dead CLI Containers

## Context

On 2026-06-22 the daily AUTOSCAN flagged the US host (`5.161.84.219`) at **91% root
fs** (P0). Manual cleanup brought it to 40% by removing ~25 GB of stale gateway
images plus a journal vacuum. This is the **third** time disk pressure has bitten
the US host (97% mid-roll on 2026-06-18; "no space left" on a `docker pull`).

The surprising part: a prune already runs **every day**.
`diagnostic-cron.sh` (step 2.6) streams `prune-gateway-images.sh` to both hosts
with `KEEP_RECENT=2`. Yet three stale tags survived every run:

| Tag | Age | Why it survived |
| --- | --- | --- |
| `openclaw:v2026.05.05.1` | 6 wk | referenced by 4 exited `*-openclaw-cli-1` containers |
| `gateway:v2026.05.24.1`  | 4 wk | referenced by 7 exited `*-openclaw-cli-1` containers |
| `gateway:v2026.06.01.1`  | 2 wk | referenced by `life-openclaw-cli-1` (exited) |

## Root cause

Each agent's Compose project defines a second service, `openclaw-cli`, a
**one-shot** that prints help and exits 1 (restart policy `no`). It is never
meant to run — but the **exited container lingers**, and a stopped container
still *references* the image it was created from.

`prune-gateway-images.sh` keeps any tag referenced by **any** container —
`docker ps -a` (running **or** stopped) — as its primary safety guard. That
guard is correct for rollback safety, but it means **every roll leaves one more
dead cli one-shot pinning the previous image, forever**. The prune dutifully
keeps them; disk climbs ~8.5 GB per roll until a pull fails.

So the bug is not the keep-policy (that protects rollbacks). It is that nothing
ever removes the **stateless, exited one-shots** that pin long-dead tags.

## Goals

- Make the existing daily prune actually reclaim stale gateway tags, eliminating
  the recurring disk P0 — without weakening any rollback guarantee.
- Keep the change non-destructive and re-pullable (no data, no in-use image, no
  running container ever at risk).
- Have `--dry-run` report exactly what the new step would remove.

## Non-goals

- Changing the gateway/cli Compose topology (the one-shot service stays; it is
  recreated on the next `compose up`).
- Touching non-gateway images (graphiti `falkordb`/`zepai`, `node:20-alpine`) —
  they are out of the prune's repo-path scope and remain so.
- Fixing US memory/swap pressure — tracked separately as OB-9 (structural;
  owner decision on rescale / OB-14 cap / rebalance).

## Proposed change

### 1. `scripts/ops/prune-gateway-images.sh` — unpin before pruning, and make dry-run predictive

Two coupled edits. **First**, a pre-step (after the `docker` presence check)
that removes the **exited** one-shot cli containers — scoped to
`name=openclaw-cli-1 + status=exited`, so it can never touch a running gateway:

```bash
# Unpin stale tags: the per-agent `openclaw-cli` one-shot service exits 1 by
# design (restart policy `no`) and is recreated on the next `compose up`. While
# the exited container lingers it still *references* the image it was built on,
# which makes the in-use guard below treat long-dead tags as "in use" forever.
# Remove the exited one-shots first so genuinely-unused tags become reclaimable.
# Stateless: config + workspace are bind-mounted volumes, untouched by `rm`.
mapfile -t DEAD_CLI < <(docker ps -a --filter 'name=openclaw-cli-1' --filter 'status=exited' --format '{{.Names}}')
if [[ "${#DEAD_CLI[@]}" -gt 0 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "prune: would remove ${#DEAD_CLI[@]} exited openclaw-cli one-shot(s): ${DEAD_CLI[*]}"
  else
    printf '%s\n' "${DEAD_CLI[@]}" | xargs -r docker rm >/dev/null 2>&1 \
      && echo "prune: removed ${#DEAD_CLI[@]} exited openclaw-cli one-shot container(s)"
  fi
fi
```

**Second — the fix for [Codex P1].** In dry-run the block above does *not*
actually remove the containers, so the existing `INUSE_TAGS` scan would still
see them and still report their stale tags as "in use" — i.e. dry-run would
**not** match the live decision. So the `INUSE_TAGS` computation must *exclude*
the doomed containers (live: already removed; dry-run: simulated removed),
giving both modes one faithful answer. Replace the current single-line scan:

```bash
# BEFORE:
# mapfile -t INUSE_TAGS < <(docker ps -a --format '{{.Image}}' \
#   | grep -F "$REPO:" | sed "s#^$REPO:##" | sort -u)

# AFTER: ignore the exited one-shots from DEAD_CLI so dry-run == live decision.
mapfile -t INUSE_TAGS < <(
  docker ps -a --format '{{.Names}}'$'\t''{{.Image}}' \
    | awk -F'\t' -v repo="$REPO:" -v doomed="$(printf '%s\n' "${DEAD_CLI[@]:-}")" '
        BEGIN { n = split(doomed, d, "\n"); for (i=1;i<=n;i++) if (d[i] != "") skip[d[i]] = 1 }
        index($2, repo) == 1 && !($1 in skip) { t = $2; sub(repo, "", t); print t }
      ' | sort -u
)
```

This keeps placement in `prune-gateway-images.sh` (not the cron wrapper) so the
documented manual invocation — `ssh host 'bash -s -- 3 --dry-run' <
prune-gateway-images.sh` — self-heals *and* previews faithfully. `DRY_RUN` and
`DEAD_CLI` are both in scope here. (This also settles open question 1:
the dry-run simulation has to live where `INUSE_TAGS` is computed.)

[Codex P1]: review comment 4769696347

### 2. `scripts/ops/diagnostic-cron.sh` — keep one extra rollback

Bump the prune depth `2 → 3` (step 2.6, the `bash -s -- 2` invocation) and
refresh the comment. There are now effectively two image "tracks" — the fleet
(`v2026.06.10.1`, 11 gateways) and `life` (`v2026.06.20.x`) — so `KEEP_RECENT=3`
guarantees the three newest tags survive regardless of references. One extra
8.5 GB image is cheap at 40% disk; the safety margin is worth it.

### 3. `scripts/ops/bug_list.md` — correct OB-15

OB-15 currently reads "prevention: add image-prune to `diagnostic-cron.sh`."
That is wrong — the prune already exists. Correct it to: "prune exists but the
exited `*-openclaw-cli-1` one-shots pin stale tags through its in-use guard;
prevention = remove the dead one-shots before the prune (this plan)."

### 4. Legacy `openclaw:*` tags — out of scope ([Codex P2])

The 6-week-old `openclaw:v2026.05.05.1` uses the **pre-Artifact-Registry local
repo name** (`openclaw`), which is outside the prune's candidate scope
(`docker images "$REPO"` for the `…/openclaw-gateway/gateway` path only).
Unpinning frees its reference, but the recurring prune still will not remove it.

Resolution: **already remediated and won't recur.** It was removed manually on
2026-06-22 (`docker rmi openclaw:v2026.05.05.1`). Current deploys only ever
produce Artifact Registry `gateway:*` tags — `deploy.sh` sets `OPENCLAW_IMAGE`
to the registry path; the compose default `openclaw:local` is materialized only
by an un-pinned *local* build, never on a prod host. So no new `openclaw:v*`
tags accrete, and broadening the recurring prune to a second repo (risking a
developer's `openclaw:local`) is not worth it.

If belt-and-suspenders is ever wanted, a **one-time** sweep after unpinning
suffices (matches version tags only, never `:local`):
`docker images openclaw --format '{{.Repository}}:{{.Tag}}' | grep -E ':v[0-9]' | xargs -r docker rmi`.

[Codex P2]: review comment 4769696347

## Safety analysis

A gateway tag is removed by the prune **only if it fails every one** of these —
unchanged by this plan except that dead one-shots no longer prop up guard (2):

1. **Scope** — candidate set is `docker images <REPO>` for the exact Artifact
   Registry gateway path only. Non-gateway images are never candidates.
2. **In-use guard** — kept if referenced by any *running or stopped* container,
   **excluding the exited cli one-shots removed in §1** (so dry-run and live
   agree). After unpinning, the only referencing containers are the **12 running
   gateways**, so `v2026.06.10.1` + `v2026.06.20.3` stay pinned.
3. **Rollback-depth guard** — the `KEEP_RECENT` newest tags by version sort are
   kept regardless of references → `life` rollback `v2026.06.20.2` survives.
4. **No `-f`** — plain `docker rmi` refuses to delete an image still backing a
   container. Hard backstop even if guards 2–3 regressed.
5. **Non-destructive** — every tag is re-pullable from Artifact Registry; a
   worst-case wrong removal costs one slower re-pull, never data.
6. **`--dry-run`** — report-only mode shows the **true** keep/remove decision
   (the in-use scan excludes the doomed one-shots, per §1, so the preview equals
   the live result) *and* which cli one-shots would be removed, before arming.

**Removing the exited cli one-shots is safe because** the service is restart
policy `no`, exits 1 by design (it is not meant to run), holds no state (config
+ workspace are bind-mounted volumes), and is recreated by the next
`compose up`. The filter `status=exited` guarantees no running container is hit.

### Dry-run behavior

**Current US host** (post-manual-cleanup — no dead one-shots, 3 tags). This is a
real run; `KEEP_RECENT` shown as the proposed `3`:

```
prune-gateway-images: 3 local gateway tag(s); keep in-use (2) + 3 most-recent [dry-run]
  keep         v2026.06.10.1     # fleet — 11 running gateways
  keep         v2026.06.20.2     # life rollback
  keep         v2026.06.20.3     # life current — running
prune-gateway-images: removed 0 tag(s)
```

**Representative pinned state** — what this morning's 91%-full host (12 dead cli
one-shots, 5 gateway-repo tags) would report under the **revised** logic. The
doomed one-shots are excluded from the in-use scan, so the tags they pinned now
correctly preview as removable — the behavior change [Codex P1] asks for:

```
prune: would remove 12 exited openclaw-cli one-shot(s): agentav-openclaw-cli-1 …
prune-gateway-images: 5 local gateway tag(s); keep in-use (2 sim) + 3 most-recent [dry-run]
  would remove v2026.05.24.1
  would remove v2026.06.01.1
  keep         v2026.06.10.1
  keep         v2026.06.20.2
  keep         v2026.06.20.3
prune-gateway-images: removed 0 tag(s) [dry-run]
```

(`openclaw:v2026.05.05.1` is absent — legacy-repo tag, outside prune scope; §4.)
Under the *old* logic this same state previewed `keep` for both stale tags
(their dead cli one-shots still counted as in-use) — the bug this revision fixes.

## Rollout & verification

1. Land the script change; **dry-run on both hosts** first:
   `ssh <host> 'bash -s -- 3 --dry-run' < prune-gateway-images.sh` — confirm it
   reports the dead cli one-shots and keeps the 3 expected tags.
2. Arm by letting the 06:00 UTC `diagnostic-cron.sh` run (or one manual live
   run per host).
3. **Verify:** after the next gateway roll + one cron cycle, the previous
   fleet tag is gone, disk holds steady, and AUTOSCAN shows no disk P0.
4. EU host: same change applies; EU is not currently disk-pressured but should
   stay clean by the same mechanism.

## Review responses (Codex, PR #85 — comment 4769696347)

- **P1 — dry-run not predictive:** fixed in §1. The `INUSE_TAGS` scan now
  excludes the doomed exited cli one-shots, so a dry-run reports the same
  keep/remove decision a live run makes. Safety points 2 & 6 and the dry-run
  example were updated; the example now shows a stale tag previewing as
  `would remove`.
- **P2 — legacy `openclaw:*` outside scope:** addressed in §4. Already removed
  manually 2026-06-22 and won't recur (prod deploys emit only registry
  `gateway:*`), so explicitly out of scope for the recurring prune; a one-time
  sweep is documented for belt-and-suspenders.
- Confirmed clean: `bash -n` on both scripts; root-cause theory (`docker ps -a`
  in-use guard, rolls only touch `openclaw-gateway`) verified by Codex.

## Open questions (for review)

1. **`KEEP_RECENT=3`** vs. keeping the cron's `2` — is one extra rollback image
   worth ~8.5 GB, or is re-pull-from-registry enough?
2. **Journal cap** — the 3.1 GB systemd journal also contributed today. Worth a
   persistent `SystemMaxUse=500M` in `journald.conf` on both hosts, or leave the
   vacuum to the manual recipe / a separate change?

(Placement — prune script vs. cron — is now settled: the P1 dry-run simulation
must live where `INUSE_TAGS` is computed, i.e. in `prune-gateway-images.sh`.)

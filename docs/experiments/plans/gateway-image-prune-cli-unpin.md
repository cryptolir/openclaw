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

### 1. `scripts/ops/prune-gateway-images.sh` — unpin before pruning

Insert a pre-step (after the `docker` presence check, before `INUSE_TAGS` is
computed) that removes the **exited** one-shot cli containers. Scoped tightly to
`name=openclaw-cli-1 + status=exited`, so it can never touch a running gateway.
Dry-run aware.

```bash
# Unpin stale tags: the per-agent `openclaw-cli` one-shot service exits 1 by
# design (restart policy `no`) and is recreated on the next `compose up`. While
# the exited container lingers it still *references* the image it was built on,
# which makes the KEEP rule below treat long-dead tags as "in use" forever.
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

This lives in `prune-gateway-images.sh` (not the cron wrapper) so the documented
manual invocation — `ssh host 'bash -s -- 2 --dry-run' < prune-gateway-images.sh`
— also self-heals and reports the same way. `DRY_RUN` is already parsed above
this point in the arg loop.

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

## Safety analysis

A gateway tag is removed by the prune **only if it fails every one** of these —
unchanged by this plan except that dead one-shots no longer prop up guard (2):

1. **Scope** — candidate set is `docker images <REPO>` for the exact Artifact
   Registry gateway path only. Non-gateway images are never candidates.
2. **In-use guard** — kept if referenced by any *running or stopped* container.
   After unpinning, the only referencing containers are the **12 running
   gateways**, so `v2026.06.10.1` + `v2026.06.20.3` stay pinned.
3. **Rollback-depth guard** — the `KEEP_RECENT` newest tags by version sort are
   kept regardless of references → `life` rollback `v2026.06.20.2` survives.
4. **No `-f`** — plain `docker rmi` refuses to delete an image still backing a
   container. Hard backstop even if guards 2–3 regressed.
5. **Non-destructive** — every tag is re-pullable from Artifact Registry; a
   worst-case wrong removal costs one slower re-pull, never data.
6. **`--dry-run`** — report-only mode shows the full keep/remove decision *and*
   (new) which cli one-shots would be removed, before anything is armed.

**Removing the exited cli one-shots is safe because** the service is restart
policy `no`, exits 1 by design (it is not meant to run), holds no state (config
+ workspace are bind-mounted volumes), and is recreated by the next
`compose up`. The filter `status=exited` guarantees no running container is hit.

### Live dry-run (post-manual-cleanup, US host)

```
prune-gateway-images: 3 local gateway tag(s); keep in-use (2) + 2 most-recent [dry-run]
  keep         v2026.06.10.1     # fleet — 11 running gateways
  keep         v2026.06.20.2     # life rollback — recent-2
  keep         v2026.06.20.3     # life current — running
prune-gateway-images: removed 0 tag(s)
```

The keep-policy is already correct; this plan only ensures dead one-shots stop
feeding guard (2) false positives on the next roll.

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

## Open questions (for review)

1. **Placement** — put the cli-unpin in `prune-gateway-images.sh` (chosen: also
   fixes manual runs) vs. orchestrate it in `diagnostic-cron.sh` only (keeps the
   prune script "images-only"). Preference?
2. **`KEEP_RECENT=3`** vs. keeping the cron's `2` — is one extra rollback image
   worth ~8.5 GB, or is re-pull-from-registry enough?
3. **Journal cap** — the 3.1 GB systemd journal also contributed today. Worth a
   persistent `SystemMaxUse=500M` in `journald.conf` on both hosts, or leave the
   vacuum to the manual recipe / a separate change?

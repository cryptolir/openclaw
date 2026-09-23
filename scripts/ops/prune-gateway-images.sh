#!/usr/bin/env bash
#
# prune-gateway-images.sh — free disk on an agent host by removing OLD, UNUSED
# openclaw images and the dangling build cache. Runs LOCALLY on the agent host
# (uses the host's own docker).
#
# Each gateway image is ~8.5 G; every roll pulls a new one, so hosts accumulate
# tags until a `docker pull` fails with "no space left on device" (2026-06-18
# incident on the US host). This prunes the backlog safely.
#
# SCOPE — every local image repository whose name contains `openclaw`, discovered
# at run time. This used to be ONE hard-coded repo path, which silently excluded
# `openclaw-gateway/hermes` and the legacy local `openclaw:*` builds: on
# 2026-09-23 EU sat at 92% full with ~25 G of images this script could not see,
# while reporting success every day. Discovering the repos instead of naming one
# means a new openclaw image repo is covered the first time it appears.
#
# KEEP policy — a tag is kept iff it is EITHER:
#   (a) referenced by any container, running or stopped (`docker ps -a`); or
#   (b) among the KEEP_RECENT most-recent tags OF ITS OWN REPO (rollback depth).
# Everything else is removed with `docker rmi` (never -f — which refuses in-use
# images anyway). Registry tags are re-pullable from Artifact Registry, so
# deleting a local copy is non-destructive.
#
# Usage (on the host, or streamed: `ssh host 'bash -s -- 2' < prune-gateway-images.sh`):
#   prune-gateway-images.sh [KEEP_RECENT] [--dry-run]
#     KEEP_RECENT  most-recent tags per repo to always keep (default 2)
#     --dry-run    report what would be removed; remove nothing
#   Exit: 0 ok · 2 bad arg / no docker · 3 still under MIN_FREE_GB free afterwards
#
set -uo pipefail

# Match on the repository name rather than a full path: the bug this replaces was
# a single hard-coded path that went stale the moment a second repo appeared.
REPO_MATCH='openclaw'

KEEP_RECENT=2
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    ''|*[!0-9]*) echo "prune: bad arg '$arg' (want KEEP_RECENT integer and/or --dry-run)" >&2; exit 2 ;;
    *) KEEP_RECENT="$arg" ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "prune: docker not found" >&2; exit 2; }

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

BEFORE=$(df -h / | awk 'NR==2{print $4" free, "$5" used"}')

# Images referenced by ANY container (running or stopped) — never remove these —
# EXCLUDING the exited one-shots removed above (live: already gone; dry-run:
# simulated gone) so the dry-run keep/remove decision matches a live run.
# Keyed by the full `repo:tag` now that more than one repo is in scope.
mapfile -t INUSE_IMAGES < <(
  docker ps -a --format '{{.Names}}'$'\t''{{.Image}}' \
    | awk -F'\t' -v doomed="$(printf '%s\n' "${DEAD_CLI[@]:-}")" '
        BEGIN { n = split(doomed, d, "\n"); for (i = 1; i <= n; i++) if (d[i] != "") skip[d[i]] = 1 }
        !($1 in skip) { print $2 }
      ' | sort -u
)
declare -A INUSE=()
for i in "${INUSE_IMAGES[@]:-}"; do [[ -n "$i" ]] && INUSE["$i"]=1; done

mapfile -t REPOS < <(docker images --format '{{.Repository}}' | grep -F "$REPO_MATCH" | grep -vxF '<none>' | sort -u)

removed=0
if [[ "${#REPOS[@]}" -eq 0 ]]; then
  echo "prune: no openclaw image repositories present; nothing to do"
fi

for REPO in "${REPOS[@]:-}"; do
  [[ -n "$REPO" ]] || continue
  # Tags of this repo, oldest -> newest (version sort handles N>9 correctly).
  mapfile -t ALL_TAGS < <(docker images "$REPO" --format '{{.Tag}}' | grep -vxF '<none>' | sort -uV)
  [[ "${#ALL_TAGS[@]}" -eq 0 ]] && continue

  unset KEEP; declare -A KEEP=()
  # (b) rollback depth, per repo.
  while IFS= read -r t; do [[ -n "$t" ]] && KEEP["$t"]=1; done < <(printf '%s\n' "${ALL_TAGS[@]}" | tail -n "$KEEP_RECENT")
  # (a) in use by some container.
  for t in "${ALL_TAGS[@]}"; do [[ -n "${INUSE["$REPO:$t"]:-}" ]] && KEEP["$t"]=1; done

  echo "prune: $REPO — ${#ALL_TAGS[@]} tag(s); keep in-use + ${KEEP_RECENT} most-recent$([[ $DRY_RUN -eq 1 ]] && echo ' [dry-run]')"
  for t in "${ALL_TAGS[@]}"; do
    if [[ -n "${KEEP[$t]:-}" ]]; then
      echo "  keep         $REPO:$t"
    elif [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  would remove $REPO:$t"
    elif docker rmi "$REPO:$t" >/dev/null 2>&1; then
      echo "  removed      $REPO:$t"
      removed=$((removed + 1))
    else
      echo "  skip         $REPO:$t (in use or removal failed)"
    fi
  done
done

# Build cache. `docker builder prune` is the only thing that reclaims it and
# nothing on these hosts ran it: EU carried 6.1 G across 25 entries, none active,
# the oldest two months old — pure accretion from local `build-and-push.sh` runs.
# `-a` is safe here because build cache is a cache: worst case the next build is
# slower. It never touches images or containers.
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "prune: build cache reclaimable (dry-run, untouched): $(docker system df 2>/dev/null | awk '/^Build Cache/{print $NF}')"
else
  echo "prune: build cache — $(docker builder prune -af 2>/dev/null | tail -1)"
fi

AFTER=$(df -h / | awk 'NR==2{print $4" free, "$5" used"}')
echo "prune-gateway-images: removed ${removed} tag(s); disk: ${BEFORE} -> ${AFTER}"

# Say so plainly when pruning could not make room. For 10 days (Sep 2026) the
# daily run printed "removed 0 tag(s)" against a 92% disk — the same words as a
# quiet day — and exited 0. Exit 3 is the caller's cue to escalate.
# ponytail: fixed floor = one ~8.7 G gateway image pull + margin; derive it from
# `docker image inspect` if images outgrow it. Keep equal to DISK_FREE_CRIT_GB
# in agents_server_diagnostic.sh.
MIN_FREE_GB=10
free_gb=$(df -P / | awk 'END{print int($4/1048576)}')
if [[ "$free_gb" -lt "$MIN_FREE_GB" ]]; then
  echo "prune: DISK STILL LOW — ${free_gb}G free after this run; the next gateway image pull needs ~${MIN_FREE_GB}G and nothing left is safe for this script to remove. A person has to look."
  exit 3
fi

#!/usr/bin/env bash
#
# diagnostic-cron.sh — unattended daily fleet diagnostic (OS-cron entrypoint)
# ─────────────────────────────────────────────────────────────────────────────
# Wraps agents_server_diagnostic.sh for cron: syncs the repo, runs the scan
# (which rewrites the AUTOSCAN block in bug_list.md), commits + pushes the
# refreshed bug list, triggers the daily release report + deploy-log refresh,
# and emails the full report to the ops address.
#
# Everything here is deterministic — no LLM. Install via crontab, e.g.:
#   0 8 * * *  CRON_SECRET=<secret> /bin/bash <repo>/scripts/ops/diagnostic-cron.sh >> /var/log/agentglob-diag.log 2>&1
#
# CRON_SECRET (optional) enables the release-report trigger + deploy-log refresh
# (step 4); it must match the dashboard's CRON_SECRET env var. Unset ⇒ step 4 is
# skipped cleanly and the rest of the diagnostic runs unchanged.
#
set -uo pipefail

# Cron runs with a minimal environment — pin PATH and key locations explicitly.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export SSH_KEY=/root/.ssh/hetzner-openclaw
# Repo root = two levels above this script — survives the checkout being moved.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMAIL_TO=liran@agentglob.com
EMAIL_FROM="AgentGlob Diagnostics <onetrue2023@gmail.com>"
# bug_list.md lives in the PRIVATE dashboard repo (moved 2026-07-10 — it carries
# live infra state that doesn't belong in this public repo).
DASH_REPO="${DASH_REPO:-/root/AgentGlob_Apps/openclaw-dashboard}"
BUG_LIST_REL=docs/ops/bug_list.md
BUG_LIST="$DASH_REPO/$BUG_LIST_REL"
BUG_LIST_URL=https://github.com/cryptolir/openclaw-dashboard/blob/main/docs/ops/bug_list.md
# Release-notify (dashboard plan docs/plans/release-notify-cron.md): this cron is
# the daily trigger — its run time IS the report cutoff. Both endpoints are
# CRON_SECRET-gated; export CRON_SECRET in the crontab entry to enable them.
DASH_URL="${DASH_URL:-https://app.agentglob.com}"
FEATURE_RELEASES_REL=docs/ops/feature-releases.md
FEATURE_RELEASES="$DASH_REPO/$FEATURE_RELEASES_REL"
FEATURE_RELEASES_URL=https://github.com/cryptolir/openclaw-dashboard/blob/main/docs/ops/feature-releases.md

cd "$REPO" || { echo "FATAL: $REPO not found"; exit 1; }

echo "═══════════════════════════════════════════════════════════════"
echo "diagnostic-cron run @ $(date '+%Y-%m-%d %H:%M:%S %Z')"

# 1. Sync this repo (scripts), then the dashboard repo (bug_list.md). Reset the
#    bug_list first so `git pull` never collides with the last run's
#    uncommitted AUTOSCAN write. Only touch the dashboard checkout on main —
#    never yank someone's feature branch out from under them.
git pull -q --rebase --autostash origin main || echo "WARN: git pull failed; continuing with local tree"
if git -C "$DASH_REPO" rev-parse --git-dir >/dev/null 2>&1; then
  if [[ "$(git -C "$DASH_REPO" branch --show-current)" == "main" ]]; then
    git -C "$DASH_REPO" checkout -- "$BUG_LIST_REL" 2>/dev/null || true
    git -C "$DASH_REPO" checkout -- "$FEATURE_RELEASES_REL" 2>/dev/null || true
    git -C "$DASH_REPO" pull -q --rebase --autostash origin main \
      || echo "WARN: dashboard git pull failed; continuing with local tree"
  else
    echo "WARN: $DASH_REPO is not on main — bug_list sync will be skipped"
  fi
else
  echo "WARN: $DASH_REPO is not a git checkout — bug_list write/sync will fail"
fi

# 2. Run the scan (writes the AUTOSCAN block) and capture the full report.
REPORT="$(/bin/bash scripts/ops/agents_server_diagnostic.sh --bug-list "$BUG_LIST" all 2>&1)"
echo "$REPORT"

# 2.5 Archive untracked cruft from the hosts' /opt/openclaw checkouts (OB-7)
#     so it can't collide with deploy-time `git pull`. Move — never delete —
#     into /root/openclaw-cruft-archive/<date>/ on each host. Only clearly
#     stale patterns (*.bak, .archive-*) older than 7 days are touched;
#     soul.md and status/ are deliberately left alone (soul.md seeds new
#     agents' SOUL.md during provisioning).
for H in 89.167.70.46 5.161.84.219; do
  ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o BatchMode=yes "root@$H" '
    cd /opt/openclaw 2>/dev/null || exit 0
    ARCHIVE="/root/openclaw-cruft-archive/$(date +%F)"
    FILES=$(find . -maxdepth 2 \( -name "*.bak" -o -name ".archive-*" \) -mtime +7 2>/dev/null)
    [ -n "$FILES" ] || exit 0
    mkdir -p "$ARCHIVE"
    N=$(printf "%s\n" "$FILES" | wc -l)
    printf "%s\n" "$FILES" | xargs -I{} mv {} "$ARCHIVE/"
    echo "→ cruft-archive: moved $N item(s) to $ARCHIVE"
  ' 2>/dev/null || echo "WARN: cruft-archive skipped for $H (ssh failed)"
done

# 2.6 Prune old, UNUSED gateway images on each agent host so a roll never fails
#     on disk (image drift: each roll pulls a ~8.5 G image; the US host hit 97%
#     and a pull failed "no space left" on 2026-06-18). prune-gateway-images.sh
#     first removes exited `*-openclaw-cli-1` one-shots (they pin stale tags
#     through the in-use guard), then keeps in-use tags + the 3 most-recent
#     (rollback depth for both the fleet + life image tracks); all tags are
#     re-pullable from Artifact Registry, so removing a local copy is non-destructive.
for H in 89.167.70.46 5.161.84.219; do
  echo "── gateway-image prune: root@$H ──"
  ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o BatchMode=yes "root@$H" 'bash -s -- 3' \
    < "$REPO/scripts/ops/prune-gateway-images.sh" 2>/dev/null \
    || echo "WARN: gateway-image prune skipped for $H (ssh failed)"
done

# 3. Commit + push the refreshed bug list in the dashboard repo (only if it
#    actually changed, and only from main — see the step-1 guard).
if [[ "$(git -C "$DASH_REPO" branch --show-current 2>/dev/null)" == "main" ]] \
   && ! git -C "$DASH_REPO" diff --quiet "$BUG_LIST_REL" 2>/dev/null; then
  git -C "$DASH_REPO" add "$BUG_LIST_REL"
  git -C "$DASH_REPO" commit -q -m "ops: automated bug_list AUTOSCAN refresh $(date +%F)" \
    && git -C "$DASH_REPO" push -q origin main \
    && echo "→ bug_list.md committed + pushed (dashboard repo)" \
    || echo "WARN: commit/push failed (dashboard repo)"
else
  echo "→ bug_list.md unchanged (or dashboard not on main); nothing to push"
fi

# 4. Trigger the daily release report, then refresh the deploy log. This run IS
#    the report cutoff: qualifying deploys detected now go into today's email,
#    later ones roll into tomorrow's. Both endpoints are CRON_SECRET-gated and
#    everything here is best-effort — a failure WARNs and never aborts the
#    diagnostic. Plan: openclaw-dashboard docs/plans/release-notify-cron.md.
if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "→ CRON_SECRET unset; skipping release report + deploy-log refresh"
elif [[ "$(git -C "$DASH_REPO" branch --show-current 2>/dev/null)" != "main" ]]; then
  echo "→ dashboard not on main; skipping release report + deploy-log refresh"
else
  RN_OUT=/var/tmp/agentglob-release-notify.out
  RN_CODE="$(curl -sS --max-time 300 -o "$RN_OUT" -w '%{http_code}' \
    -H "Authorization: Bearer $CRON_SECRET" "$DASH_URL/api/cron/release-notify" 2>/dev/null || echo 000)"
  if [[ "$RN_CODE" == "200" ]]; then
    echo "→ release report triggered: $(head -c 300 "$RN_OUT")"
  else
    echo "WARN: release-notify returned $RN_CODE — $(head -c 300 "$RN_OUT" 2>/dev/null)"
  fi

  # Render the ledger to the tracking file. Overwrite ONLY on a clean 200 whose
  # body actually looks like the log — a 5xx JSON error or an HTML error page
  # must never truncate a committed file.
  RL_TMP="$(mktemp)"
  RL_CODE="$(curl -sS --max-time 120 -o "$RL_TMP" -w '%{http_code}' \
    -H "Authorization: Bearer $CRON_SECRET" "$DASH_URL/api/cron/release-log" 2>/dev/null || echo 000)"
  if [[ "$RL_CODE" == "200" && -s "$RL_TMP" ]] && head -1 "$RL_TMP" | grep -q '^# Deploy log'; then
    mv "$RL_TMP" "$FEATURE_RELEASES"
    if ! git -C "$DASH_REPO" diff --quiet "$FEATURE_RELEASES_REL" 2>/dev/null; then
      git -C "$DASH_REPO" add "$FEATURE_RELEASES_REL"
      git -C "$DASH_REPO" commit -q -m "ops: refresh deploy log $(date +%F)" \
        && git -C "$DASH_REPO" push -q origin main \
        && echo "→ feature-releases.md committed + pushed (dashboard repo)" \
        || echo "WARN: feature-releases.md commit/push failed (dashboard repo)"
    else
      echo "→ feature-releases.md unchanged; nothing to push"
    fi
  else
    rm -f "$RL_TMP"
    echo "WARN: release-log returned $RL_CODE — deploy log left untouched"
  fi
fi

# 5. Email the report. Subject carries the P0..P3 totals at a glance.
COUNTS="$(printf '%s\n' "$REPORT" | grep -oE 'Totals:.*' | tail -1)"
SUBJECT="[AgentGlob] Fleet diagnostic $(date +%F) — ${COUNTS:-scan complete}"
if command -v msmtp >/dev/null 2>&1; then
  {
    printf 'Subject: %s\n' "$SUBJECT"
    printf 'From: %s\n' "$EMAIL_FROM"
    printf 'To: %s\n' "$EMAIL_TO"
    printf 'Content-Type: text/plain; charset=UTF-8\n\n'
    printf '%s\n\n' "$REPORT"
    MODELS_REPORT_FILE=/var/tmp/agentglob-models-report.txt
    if [[ -f "$MODELS_REPORT_FILE" && -n "$(find "$MODELS_REPORT_FILE" -mmin -360 2>/dev/null)" ]]; then
      printf '═══════ MODEL CONNECTIVITY (05:50 UTC run) ═══════\n%s\n\n' "$(cat "$MODELS_REPORT_FILE")"
    fi
    DEPS_REPORT_FILE=/var/tmp/agentglob-deps-report.txt
    if [[ -f "$DEPS_REPORT_FILE" && -n "$(find "$DEPS_REPORT_FILE" -mmin -360 2>/dev/null)" ]]; then
      printf '═══════ DEPENDENCY AUDIT (05:45 UTC run) ═══════\n%s\n\n' "$(cat "$DEPS_REPORT_FILE")"
    else
      printf '═══════ DEPENDENCY AUDIT ═══════\n⚠ report missing or stale (>6h) — the 05:45 deps-audit cron produced no fresh output; see /var/log/agentglob-deps.log\n\n'
    fi
    printf 'Bug list: %s\n' "$BUG_LIST_URL"
    printf 'Deploy log: %s\n' "$FEATURE_RELEASES_URL"
  } | msmtp "$EMAIL_TO" \
      && echo "→ summary emailed to $EMAIL_TO" \
      || echo "WARN: email send failed — check ~/.msmtp.log and the Gmail app password in ~/.msmtprc"
else
  echo "WARN: msmtp not installed; skipping email"
fi

echo "diagnostic-cron done @ $(date '+%H:%M:%S %Z')"

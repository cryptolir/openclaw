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
# The HUMAN checkout. Never written to, never branch-switched — someone is
# usually working in it.
DASH_SHARED="${DASH_SHARED:-/root/AgentGlob_Apps/openclaw-dashboard}"
# …and OUR OWN worktree of it, permanently detached at origin/main. Before this
# existed the cron used the shared checkout and skipped whenever a human had it
# on a branch: measured 53 consecutive skipped runs (2026-08-09), silently, with
# bug_list, the release report and the deploy log all frozen. A worktree costs
# one directory and cannot be branch-switched out from under us.
DASH_REPO="${DASH_REPO:-/root/AgentGlob_Apps/.dashboard-autoscan}"
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

# 1. Check our own checkout (read-only — see below), then sync the dashboard
#    repo that holds bug_list.md. Neither of the two checkouts a human might be
#    working in is ever written to or branch-switched; each side gets its own
#    cron-owned worktree instead.
# Every WARN that means "today's findings will not reach anyone" goes in here and
# is reprinted in the EMAIL (step 5) and the SUBJECT. A warning that only ever
# reaches /var/log is a warning nobody reads — that is the whole reason 53 runs
# went by unnoticed.
SYNC_WARNINGS=""
warn_sync() { echo "WARN: $1"; SYNC_WARNINGS="${SYNC_WARNINGS}⚠ $1"$'\n'; }

# This cron does not update its own checkout, and must never pull it. $REPO is
# meant to be .openclaw-autoscan — a detached worktree owned by cron alone,
# re-pinned to origin/main by its own crontab line at 05:40, while nothing is
# executing from it (rewriting a script under a running bash is its own bug).
#
# It used to run from the SHARED human checkout and `git pull --rebase` it. That
# does not merely fail when someone has a branch checked out — it REWRITES that
# branch. 2026-08-11: the 06:00 run rebased a local feature branch onto main, hit
# a STATUS.md conflict, and left the repo detached mid-rebase; every later `git
# pull` there refused with "needs merge" for ~9h while a `|| echo WARN` kept the
# run reporting success. The dashboard checkout below has had a dedicated
# worktree since the 53-skip incident; the checkout the cron RUNS FROM did not.
#
# So: read-only. Fetch to learn where main is, then say — in the EMAIL, not just
# /var/log — if what we are about to execute is not it. A worktree whose pin
# quietly stopped running would otherwise re-run yesterday's scripts forever.
git fetch -q origin main 2>/dev/null \
  || warn_sync "$REPO: git fetch failed — cannot tell whether these scripts are current"
_head="$(git rev-parse HEAD 2>/dev/null || true)"
_main="$(git rev-parse origin/main 2>/dev/null || true)"
# `git rev-parse --git-path`, not a literal .git/… — in a worktree `.git` is a
# FILE and the rebase state lives under .git/worktrees/<name>/, so a hardcoded
# path can never be true in the one checkout this check exists to protect.
if [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]; then
  warn_sync "$REPO is MID-REBASE — every script below is running from a half-merged tree. Fix: cd $REPO && git rebase --abort"
elif [[ -n "$_head" && -n "$_main" && "$_head" != "$_main" ]]; then
  warn_sync "$REPO is not at origin/main ($(git rev-parse --short HEAD) vs $(git rev-parse --short origin/main)) — these scripts may be stale. Expected \$REPO=/root/AgentGlob_Apps/.openclaw-autoscan, re-pinned by the 05:40 crontab line."
fi

if ! git -C "$DASH_SHARED" rev-parse --git-dir >/dev/null 2>&1; then
  warn_sync "$DASH_SHARED is not a git checkout — bug_list write/sync will fail"
else
  git -C "$DASH_SHARED" fetch -q origin main \
    || warn_sync "dashboard fetch failed; continuing with the last synced tree"
  git -C "$DASH_SHARED" worktree prune 2>/dev/null || true
  # `.git` in a worktree is a FILE, not a directory — test -e, not -d.
  if [[ ! -e "$DASH_REPO/.git" ]]; then
    git -C "$DASH_SHARED" worktree add --detach "$DASH_REPO" origin/main \
      && echo "→ created AUTOSCAN worktree at $DASH_REPO" \
      || warn_sync "could not create the AUTOSCAN worktree at $DASH_REPO"
  fi
  # Hard-reset to origin/main every run. Detached on purpose: there is no branch
  # to switch, so no human action can disable this. A commit that failed to push
  # last run is discarded here rather than accumulating — the scan regenerates
  # its own content daily, so replaying is always cheaper than reconciling.
  if [[ -e "$DASH_REPO/.git" ]]; then
    git -C "$DASH_REPO" checkout -q --detach origin/main 2>/dev/null \
      && git -C "$DASH_REPO" reset -q --hard origin/main \
      || warn_sync "could not pin $DASH_REPO to origin/main"
  fi
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
if ! git -C "$DASH_REPO" diff --quiet "$BUG_LIST_REL" 2>/dev/null; then
  git -C "$DASH_REPO" add "$BUG_LIST_REL"
  # Detached HEAD, so the refspec is explicit. A rejected push means someone
  # else moved main between our fetch and now — next run rebases onto it.
  if git -C "$DASH_REPO" commit -q -m "ops: automated bug_list AUTOSCAN refresh $(date +%F)" \
     && git -C "$DASH_REPO" push -q origin HEAD:main; then
    echo "→ bug_list.md committed + pushed (dashboard repo)"
  else
    warn_sync "bug_list commit/push failed — today's findings are NOT on main"
  fi
else
  echo "→ bug_list.md unchanged; nothing to push"
fi

# 4. Trigger the daily release report, then refresh the deploy log. This run IS
#    the report cutoff: qualifying deploys detected now go into today's email,
#    later ones roll into tomorrow's. Both endpoints are CRON_SECRET-gated and
#    everything here is best-effort — a failure WARNs and never aborts the
#    diagnostic. Plan: openclaw-dashboard docs/plans/release-notify-cron.md.
if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "→ CRON_SECRET unset; skipping release report + deploy-log refresh"
elif [[ ! -e "$DASH_REPO/.git" ]]; then
  warn_sync "no AUTOSCAN worktree — skipping release report + deploy-log refresh"
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
    # Shrink guard: the log is append-only, so a render with FEWER entries than
    # the committed file means the ledger is under-populated (e.g. the cron was
    # wired before GH_RELEASE_READ_TOKEN, so the dashboard stream fails closed
    # and only gateway rows render). Refuse to clobber a good file with a thin
    # one — a real shrink never happens.
    NEW_N="$(grep -c '^- ' "$RL_TMP" || true)"
    OLD_N=0
    [[ -f "$FEATURE_RELEASES" ]] && OLD_N="$(grep -c '^- ' "$FEATURE_RELEASES" || true)"
    if (( NEW_N < OLD_N )); then
      rm -f "$RL_TMP"
      echo "WARN: release-log rendered $NEW_N entries vs $OLD_N committed — refusing to shrink the deploy log (check GH_RELEASE_READ_TOKEN + the release_log backfill)"
    else
      mv "$RL_TMP" "$FEATURE_RELEASES"
      # `git diff --quiet` reports NO change for an UNTRACKED path, so the very
      # first creation would never be committed (Codex #103). `git status
      # --porcelain` covers modified AND untracked.
      if [[ -n "$(git -C "$DASH_REPO" status --porcelain -- "$FEATURE_RELEASES_REL" 2>/dev/null)" ]]; then
        git -C "$DASH_REPO" add "$FEATURE_RELEASES_REL"
        git -C "$DASH_REPO" commit -q -m "ops: refresh deploy log $(date +%F)" \
          && git -C "$DASH_REPO" push -q origin HEAD:main \
          && echo "→ feature-releases.md committed + pushed ($NEW_N entries)" \
          || echo "WARN: feature-releases.md commit/push failed (dashboard repo)"
      else
        echo "→ feature-releases.md unchanged; nothing to push"
      fi
    fi
  else
    rm -f "$RL_TMP"
    echo "WARN: release-log returned $RL_CODE — deploy log left untouched"
  fi
fi

# 5. Email the report. Subject carries the P0..P3 totals at a glance.
COUNTS="$(printf '%s\n' "$REPORT" | grep -oE 'Totals:.*' | tail -1)"
SUBJECT="[AgentGlob] Fleet diagnostic $(date +%F) — ${COUNTS:-scan complete}"
# A sync failure means the findings below never reached the repo. Put it in the
# SUBJECT: the log line alone went unread for 53 runs.
[[ -n "$SYNC_WARNINGS" ]] && SUBJECT="⚠ SYNC FAILED — $SUBJECT"
if command -v msmtp >/dev/null 2>&1; then
  {
    printf 'Subject: %s\n' "$SUBJECT"
    printf 'From: %s\n' "$EMAIL_FROM"
    printf 'To: %s\n' "$EMAIL_TO"
    printf 'Content-Type: text/plain; charset=UTF-8\n\n'
    if [[ -n "$SYNC_WARNINGS" ]]; then
      printf '═══════ ⚠ AUTOSCAN SYNC FAILED ═══════\n%s\nThe findings below were produced but may NOT be committed to bug_list.md.\nSee /var/log/agentglob-diag.log\n\n' "$SYNC_WARNINGS"
    fi
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
    SEC_REPORT_FILE=/var/tmp/agentglob-security-report.txt
    if [[ -f "$SEC_REPORT_FILE" && -n "$(find "$SEC_REPORT_FILE" -mmin -360 2>/dev/null)" ]]; then
      printf '═══════ SECURITY AUDIT (05:52 UTC run) ═══════\n%s\n\n' "$(cat "$SEC_REPORT_FILE")"
    else
      printf '═══════ SECURITY AUDIT ═══════\n⚠ report missing or stale (>6h) — the 05:52 security-audit cron produced no fresh output; see /var/log/agentglob-security.log\n\n'
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

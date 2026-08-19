#!/usr/bin/env bash
#
# security-audit-cron — daily read-only security posture scan for the fleet
# ─────────────────────────────────────────────────────────────────────────────
# Runs on the dev server at 05:52 UTC, after the 05:40 worktree re-pin and
# before the 06:00 fleet diagnostic that ingests its output. Deterministic
# bash — no LLM, no tokens. Every check is READ-ONLY: nothing is restarted,
# written, or changed on any host. Per-host cost is one ssh running a few
# stats, greps and docker execs — seconds, not minutes.
#
# What it checks (chosen from real estate state, 2026-08-19). Deliberately
# NOT here: docker.env containment — the D2 section of
# agents_server_diagnostic.sh (openclaw#127) already verifies that per
# container daily; this script covers the posture D2 does not:
#   1. Config backups inside agent mounts — openclaw.json.bak*/tmp copies
#      under /root/.openclaw/agents/*/ are container-readable and carry live
#      gateway/bot tokens (D2 only covers docker.env.bak*). P2 while > 0.
#   2. Identical private keys across agents — sha256 fingerprints compared
#      in-process ON the host; only counts + 8-char fp prefixes travel back,
#      never values. Two or more agents sharing one key is a P1.
#   3. sshd posture — PasswordAuthentication yes is a P1; an ACTUAL password
#      login in the last 24h is a P1 (the fleet is key-only by policy).
#   4. Non-loopback listeners outside the allowlist (22 + 18xxx gateways) —
#      docker-API/DB/cache class ports are P1, anything else unexpected P2.
#   5. Docker posture — a privileged container or a docker.sock mount is P1.
#   6. Secrets tree traversable by non-root (docker.env files are 644, so the
#      directory chain is the only gate) — P2 if the chain is open.
#   7. Patch drift + ssh brute-force volume — context lines, P3 past a bound.
#   8. Dashboard surface (from this host, no ssh): the CRON_SECRET-gated
#      endpoints must reject an unauthenticated call (200 ⇒ P0); HSTS header.
#   The dev host itself gets checks 3–7 too — it holds the keys to the fleet.
#
# Output mirrors models_connectivity_check.sh / deps-audit-cron.sh — two state
# files the 06:00 diagnostic ingests for ONE combined email + bug_list entries:
#   REPORT_FILE  human report    (default /var/tmp/agentglob-security-report.txt)
#   ISSUES_FILE  ISSUE|... lines (default /var/tmp/agentglob-security-issues.txt)
#
# Install (dev-server crontab, alongside the existing 05:40–06:00 block):
#   52 5 * * * /bin/bash /root/AgentGlob_Apps/.openclaw-autoscan/scripts/ops/security-audit-cron.sh >> /var/log/agentglob-security.log 2>&1
#
# Env overrides: SSH_KEY, HOSTS ("eu:89.167.70.46 us:5.161.84.219"),
#   PORT_ALLOW (regex of allowed public ports), DASH_URL, REPORT_FILE, ISSUES_FILE.
#
set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner-openclaw}"
HOSTS="${HOSTS:-eu:89.167.70.46 us:5.161.84.219}"
DASH_URL="${DASH_URL:-https://app.agentglob.com}"
REPORT_FILE="${REPORT_FILE:-/var/tmp/agentglob-security-report.txt}"
ISSUES_FILE="${ISSUES_FILE:-/var/tmp/agentglob-security-issues.txt}"
# Ports allowed to listen on non-loopback: ssh + the 18xxx gateway range.
# Anything intended but not listed here should be ADDED here with a comment,
# not silenced on the host. No {n} quantifiers in the default: inside
# ${var:-...} bash closes the expansion at the FIRST '}', silently corrupting
# the regex (found by the first validation run flagging port 22).
PORT_ALLOW="${PORT_ALLOW:-^(22|18[0-9][0-9][0-9])$}"
# Ports that must never face the network no matter what.
PORT_SENSITIVE='^(2375|2376|6379|5432|3306|27017|9200|8086|6443)$'

ISSUES_TMP="$(mktemp)"; REPORT_TMP="$(mktemp)"
trap 'rm -f "$ISSUES_TMP" "$REPORT_TMP"' EXIT

rep() { printf '%s\n' "$1" >>"$REPORT_TMP"; }
# ISSUE|P<n>|<host>|<agent>|<title>|<detail> — same shape the fleet diagnostic
# and deps audit emit, so the 06:00 merge + bug_list writer need no changes.
iss() { printf 'ISSUE|%s\n' "$1" >>"$ISSUES_TMP"; }

rep "security-audit run @ $(date '+%Y-%m-%d %H:%M:%S %Z')"
rep ""

# ── Per-host probe: emits ISSUE|... and INFO|... lines on stdout. Runs the
#    same block locally for the dev host (mode=dev skips the fleet-only parts).
#    Secrets are hashed in-process on the host; values never leave it.
host_probe() {  # $1 short name   $2 mode: fleet|dev
  local H="$1" MODE="$2"
  set -uo pipefail
  iss() { printf 'ISSUE|%s\n' "$1"; }
  inf() { printf 'INFO|%s|%s\n' "$H" "$1"; }

  if [ "$MODE" = fleet ]; then
    # 1. Config backups readable from inside the containers. docker.env
    #    containment itself is the diagnostic's D2 section — not duplicated here.
    local n
    n=$(find /root/.openclaw/agents/ -maxdepth 3 -name 'openclaw.json*' ! -name 'openclaw.json' 2>/dev/null | wc -l | tr -d ' ')
    [ "${n:-0}" -gt 0 ] && iss "P2|$H|-|${n} config backups inside agent mounts|openclaw.json.bak*/tmp copies under /root/.openclaw/agents/*/ are readable from inside their containers and carry gateway+bot tokens. Move them under a backups/ dir outside every mount (the custody plan already does this for docker.env snapshots)."
    inf "config-backups: ${n:-0} openclaw.json* backup files inside mounts"

    # 2. One private key shared by many agents — fingerprints only.
    local K f v d cnt fp
    for K in PRIVATE_KEY HYPERLIQUID_PRIVATE_KEY WALLET_PRIVATE_KEY; do
      for d in $(for f in /root/.openclaw/agents/*/docker.env; do
                   v=$(grep -E "^${K}=" "$f" 2>/dev/null | head -1 | cut -d= -f2-)
                   [ -n "$v" ] && printf '%s' "$v" | sha256sum | cut -c1-8
                 done | sort | uniq -c | awk '$1>1{print $1":"$2}'); do
        cnt=${d%%:*}; fp=${d##*:}
        iss "P1|$H|-|${cnt} agents share the same ${K}|sha256 fingerprint ${fp}… — one compromised agent compromises all ${cnt}. Issue per-agent keys. (Values are hashed on-host and never printed.)"
      done
    done
  fi

  # 3. sshd posture + real password logins.
  local pa napw nfail
  pa=$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')
  [ "$pa" = "yes" ] && iss "P1|$H|-|SSH password authentication enabled|sshd accepts passwords; the fleet standard is key-only. Set PasswordAuthentication no (sshd_config + sshd_config.d/*) and reload — AFTER confirming key login works."
  napw=$(journalctl -S -24h 2>/dev/null | grep -c 'Accepted password')
  [ "${napw:-0}" -gt 0 ] && iss "P1|$H|-|Password SSH login OCCURRED (${napw}x in 24h)|someone authenticated to this host with a password in the last 24h — expected zero on a key-only fleet. Review journalctl -S -24h | grep 'Accepted password' for source IPs."
  nfail=$(journalctl -S -24h 2>/dev/null | grep -cE 'Failed password|Invalid user')
  inf "ssh: ${nfail:-0} failed login attempts in 24h (internet background noise unless it spikes); password-auth=${pa:-unknown}"

  # 4. Public listeners vs allowlist.
  local ports p unexpected="" sensitive=""
  # Exclude ALL of 127.0.0.0/8, not just .1 — systemd-resolved listens on
  # 127.0.0.53/54 and must not count as a public listener.
  ports=$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^127\.|^\[::1\]' | sed 's/.*://' | sort -un)
  for p in $ports; do
    echo "$p" | grep -qE "$PORT_ALLOW" && continue
    if echo "$p" | grep -qE "$PORT_SENSITIVE"; then sensitive="$sensitive $p"; else unexpected="$unexpected $p"; fi
  done
  [ -n "$sensitive" ] && iss "P1|$H|-|Sensitive service port(s) publicly bound|port(s)${sensitive} listen on non-loopback — docker-API/DB/cache class services must never face the internet (docker published ports BYPASS ufw). Bind to 127.0.0.1 or firewall at the provider."
  [ -n "$unexpected" ] && iss "P2|$H|-|Unexpected public listener(s)|port(s)${unexpected} listen on non-loopback, outside the allowlist (22 + 18xxx gateway range). Intended ⇒ add to PORT_ALLOW in security-audit-cron.sh with a comment; not ⇒ bind loopback or firewall."
  inf "listeners: public ports: $(echo "$ports" | tr '\n' ' ')"

  # 5. Docker container posture.
  local line name priv rest mounts
  for c in $(docker ps -q 2>/dev/null); do
    line=$(docker inspect "$c" --format '{{.Name}}|{{.HostConfig.Privileged}}|{{range .Mounts}}{{.Source}};{{end}}' 2>/dev/null)
    name=${line%%|*}; name=${name#/}
    rest=${line#*|}; priv=${rest%%|*}; mounts=${rest#*|}
    [ "$priv" = "true" ] && iss "P1|$H|${name}|Privileged container|${name} runs --privileged — full host access. Confine it or document why."
    case "$mounts" in *docker.sock*) iss "P1|$H|${name}|docker.sock mounted|${name} can control the host docker daemon (root-equivalent). Remove the mount or document why." ;; esac
  done

  # 6. Secrets tree reachable by non-root. docker.env files are 644, so the
  #    directory chain is the only gate; flag when BOTH links are open.
  local rperm ocperm
  rperm=$(stat -c '%a' /root 2>/dev/null || echo 700)
  ocperm=$(stat -c '%a' /root/.openclaw 2>/dev/null || echo 700)
  if [ "${rperm: -1}" != "0" ] && [ "${ocperm: -1}" != "0" ]; then
    iss "P2|$H|-|Secrets tree traversable by non-root|/root is ${rperm} and /root/.openclaw is ${ocperm} — docker.env files are 644, so any local user could read every agent secret. chmod o-rx /root/.openclaw (or /root)."
  fi

  # 7. Patch drift — context only until it grows past a bound.
  local nsec
  nsec=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst.*[Ss]ecurity')
  inf "patches: ${nsec:-0} pending security updates"
  [ "${nsec:-0}" -gt 30 ] && iss "P3|$H|-|${nsec} security updates pending|patch drift is growing; schedule an apt upgrade + reboot window."
}

# ── Fleet hosts (one ssh each; the function body ships over stdin) ───────────
for hv in $HOSTS; do
  short=${hv%%:*}; ip=${hv##*:}
  out=$(ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        "root@${ip}" "PORT_ALLOW='$PORT_ALLOW' PORT_SENSITIVE='$PORT_SENSITIVE' bash -s" 2>/dev/null \
        <<REMOTE
$(declare -f host_probe)
host_probe "$short" fleet
REMOTE
  ) || true
  if [ -z "$out" ]; then
    iss "P1|$short|-|Security scan could not reach host|ssh to ${ip} failed or returned nothing — this host's security posture is UNVERIFIED today."
    rep "── $short ($ip) — UNREACHABLE, posture unverified"
  else
    rep "── $short ($ip) ──"
    printf '%s\n' "$out" | awk -F'|' '/^INFO\|/{printf "  %s\n", $3}' >>"$REPORT_TMP"
    printf '%s\n' "$out" | grep '^ISSUE|' >>"$ISSUES_TMP" || true
  fi
  rep ""
done

# ── Dev host (local, no ssh; fleet-only sections skipped) ────────────────────
out=$(host_probe dev dev 2>/dev/null) || true
rep "── dev ($(hostname -I 2>/dev/null | awk '{print $1}')) ──"
printf '%s\n' "$out" | awk -F'|' '/^INFO\|/{printf "  %s\n", $3}' >>"$REPORT_TMP"
printf '%s\n' "$out" | grep '^ISSUE|' >>"$ISSUES_TMP" || true
rep ""

# ── Dashboard surface (from here; both endpoints are CRON_SECRET-gated and a
#    call WITHOUT credentials must be rejected — a 200 means the gate is off) ─
for ep in release-notify release-log; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$DASH_URL/api/cron/$ep" 2>/dev/null || echo 000)
  case "$code" in
    200) iss "P0|dash|-|Cron endpoint accepts UNAUTHENTICATED calls|GET $DASH_URL/api/cron/$ep returned 200 with no Authorization header — the CRON_SECRET gate is not enforced." ;;
    000) iss "P2|dash|-|Dashboard unreachable for surface check|$DASH_URL/api/cron/$ep did not answer — cannot verify the auth gate today." ;;
  esac
  rep "  dashboard /api/cron/$ep unauthenticated ⇒ HTTP $code (want 401/403)"
done
hsts=$(curl -sSI --max-time 20 "$DASH_URL" 2>/dev/null | grep -ci '^strict-transport-security')
[ "${hsts:-0}" -eq 0 ] && iss "P3|dash|-|HSTS header missing|$DASH_URL does not send Strict-Transport-Security — add it via next.config headers."
rep "  dashboard HSTS header present: $([ "${hsts:-0}" -gt 0 ] && echo yes || echo NO)"
rep ""

# ── Summary + atomic state-file writes (the 06:00 diagnostic ingests both) ───
# grep -c prints the count even when it exits 1 (zero matches) — `|| true`,
# never `|| echo 0`, or a zero-match file yields "0\n0".
n_issues=$(grep -c '^ISSUE|' "$ISSUES_TMP" 2>/dev/null || true)
for p in P0 P1 P2 P3; do
  c=$(grep -c "^ISSUE|$p|" "$ISSUES_TMP" 2>/dev/null || true)
  counts="${counts:-}${p}:${c:-0} "
done
rep "Totals: ${counts:-none} (${n_issues} finding(s))"
if [ "${n_issues:-0}" -gt 0 ]; then
  rep ""
  rep "Findings:"
  awk -F'|' '/^ISSUE\|/{printf "  [%s] %s/%s — %s\n", $2, $3, $4, $5}' "$ISSUES_TMP" >>"$REPORT_TMP"
fi

mv "$REPORT_TMP" "$REPORT_FILE"; REPORT_TMP=""
mv "$ISSUES_TMP" "$ISSUES_FILE"; ISSUES_TMP=""
trap - EXIT
cat "$REPORT_FILE"
echo "state files written: $REPORT_FILE / $ISSUES_FILE"

#!/usr/bin/env bash
#
# agents_server_diagnostic — AgentGlob fleet health, agent status & issue triage
# ─────────────────────────────────────────────────────────────────────────────
# Diagnostic protocol for the Hetzner agent hosts that run the openclaw
# gateways. It performs, in order:
#
#   A. Server health      — uptime, load, memory, swap, disk, docker hygiene
#   B. Agent status       — every *-openclaw-gateway-1 container: running?
#                           port listening? crash-looping? recent errors?
#   C. List all issues    — collected from A + B with a severity each
#   D. Prioritise         — issues sorted P0 (critical) → P3 (cosmetic)
#   E. Write bug_list.md  — the prioritised issues are written into the
#                           <!-- AUTOSCAN --> block of bug_list.md
#
# Known failure signatures it recognises (learned from real incidents):
#   - gateway not listening / container not running .............. P0
#   - container "Restarting" (crash loop) ....................... P0
#   - disk >= DISK_CRIT% ........................................ P0
#   - OOM kill in kernel log .................................... P1
#   - low memory headroom / no swap / heavy swap use ............ P1
#   - uncaught EPIPE / plugin (mcp-bridge) crash ................ P1
#   - model not responding (typing-TTL / no-reply / timeout) .... P1
#   - auth/token failure (401, setMyCommands) ................... P1
#   - provider model-discovery timeout (e.g. venice) ............ P2
#   - disk >= DISK_WARN% ........................................ P2
#   - no docker log rotation (unbounded logs) ................... P2
#   - docker.env key not reaching the container ................. P2
#   - agent session dir large (>SESSION_DIR_WARN_MB MiB) ......... P2
#   - agent workspace dir large (>WORKSPACE_DIR_WARN_MB MiB) ..... P1
#   - mcp-bridge "No servers configured" noise .................. P3
#
# Usage:
#   ./agents_server_diagnostic.sh [options] [host ...]
#     host            one or more of: eu  us  all      (default: all)
#
#   --bug-list PATH   path to bug_list.md   (default: $DASH_REPO/docs/ops/bug_list.md)
#   --no-write        print the report only; do not touch bug_list.md
#   --since DURATION  gateway-log lookback for the scan (default: 30m)
#   -h | --help       this help
#
# Requires: ssh access to the hosts via $SSH_KEY (default ~/.ssh/hetzner-openclaw)
# Portable to bash 3.2 (macOS) — the orchestrator avoids assoc arrays / mapfile.
#
set -uo pipefail

# ── Fleet definition (functions, not assoc arrays → bash 3.2 / macOS safe) ────
SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner-openclaw}"
host_ip()    { case "$1" in eu) echo "89.167.70.46";; us) echo "5.161.84.219";; *) echo "";; esac; }
host_label() { case "$1" in eu) echo "1stClaw/EU";; us) echo "2ndClaw/US";; *) echo "$1";; esac; }
ALL_HOSTS="eu us"

# ── Thresholds (tune here) ───────────────────────────────────────────────────
DISK_WARN=80          # % root fs used → P2
DISK_CRIT=90          # % root fs used → P0
MEM_AVAIL_WARN=500    # MiB available → P1 below this
SWAP_USED_WARN=1024   # MiB swap in use → P1 above this (thrashing)
LOG_SINCE="30m"       # gateway-log lookback window
SESSION_DIR_WARN_MB=100   # MiB per-agent sessions/ dir  → P2
WORKSPACE_DIR_WARN_MB=500 # MiB per-agent workspace/ dir → P1
# Keys that legitimately sit in docker.env WITHOUT being forwarded, so the
# env-forwarding check above stays quiet about them:
#   OPENCLAW_IMAGE / CONFIG_DIR / WORKSPACE_DIR / *_PORT - consumed by compose
#     itself for interpolation; they were never meant to reach the container.
#     OPENCLAW_GATEWAY_BIND is the same, one step further removed: compose
#     interpolates it into the gateway COMMAND ("${OPENCLAW_GATEWAY_BIND:-lan}"),
#     so the value arrives as an argv entry, never as an env var. Verified
#     2026-08-09 by the check itself flagging it on all 13 US agents.
#   NVIDIA_API_KEY - provider retired in the OpenRouter migration.
#   WALLET_PRIVATE_KEY, RAIN_API_KEY - written by the dashboard Core Package UI
#     but read by nothing (verified 2026-08-09: zero refs across openclaw src/
#     and skills/). If either gains a consumer, remove it here and add it to the
#     compose allowlist instead - do not silence a key that is actually used.
#   OPENCLAW_HOME_VOLUME / EXTRA_MOUNTS / DOCKER_APT_PACKAGES - deploy-level
#     knobs consumed while BUILDING the compose invocation, like the paths above.
#   HYPERLIQUID_PRIVATE_KEY, GOG_KEYRING_PASSWORD, GOG_KEYRING_BACKEND - carried
#     by the EU host older provisioning template; zero readers in openclaw src/
#     or skills/ (verified 2026-08-09), i.e. dead entries rather than a
#     forwarding bug.
#
# Deliberately NOT silenced, because they DO have readers and so a missing
# forward is a real fault: GEMINI_API_KEY (16 refs), RPC_URL (2 refs). The first
# run of this check found GEMINI_API_KEY on an EU agent with no compose entry -
# a fifth instance of the OB-21 class, which is the whole point of the check.
ENV_FORWARD_IGNORE="OPENCLAW_IMAGE OPENCLAW_CONFIG_DIR OPENCLAW_WORKSPACE_DIR OPENCLAW_GATEWAY_PORT OPENCLAW_BRIDGE_PORT OPENCLAW_GATEWAY_BIND OPENCLAW_HOME_VOLUME OPENCLAW_EXTRA_MOUNTS OPENCLAW_DOCKER_APT_PACKAGES NVIDIA_API_KEY WALLET_PRIVATE_KEY RAIN_API_KEY HYPERLIQUID_PRIVATE_KEY GOG_KEYRING_PASSWORD GOG_KEYRING_BACKEND"

# ── Args ─────────────────────────────────────────────────────────────────────
SELECT="" ; WRITE=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# bug_list.md moved to the private dashboard repo (2026-07-10). Default assumes
# the dev-server layout (both checkouts side by side); override with --bug-list.
DASH_REPO="${DASH_REPO:-/root/AgentGlob_Apps/openclaw-dashboard}"
BUG_LIST="${DASH_REPO}/docs/ops/bug_list.md"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bug-list) BUG_LIST="$2"; shift 2 ;;
    --no-write) WRITE=0; shift ;;
    --since)    LOG_SINCE="$2"; shift 2 ;;
    -h|--help)  sed -n '2,49p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    eu|us)      SELECT="$SELECT $1"; shift ;;
    all)        SELECT="$ALL_HOSTS"; shift ;;
    *) echo "ERROR: unknown arg '$1' (try --help)" >&2; exit 2 ;;
  esac
done
[[ -z "${SELECT// }" ]] && SELECT="$ALL_HOSTS"

# ── Remote probe ─────────────────────────────────────────────────────────────
# Runs on each host as root. Emits machine-readable lines on stdout:
#   METRIC|<host>|<name>|<value>|<ok|warn|crit>
#   ISSUE|<P0|P1|P2|P3>|<host>|<agent|->|<title>|<detail>
remote_probe() {
  local name="$1" ip="$2"
  ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      "root@${ip}" \
      "HOST_NAME='${name}' LOG_SINCE='${LOG_SINCE}' DISK_WARN='${DISK_WARN}' DISK_CRIT='${DISK_CRIT}' MEM_AVAIL_WARN='${MEM_AVAIL_WARN}' SWAP_USED_WARN='${SWAP_USED_WARN}' SESSION_DIR_WARN_MB='${SESSION_DIR_WARN_MB}' WORKSPACE_DIR_WARN_MB='${WORKSPACE_DIR_WARN_MB}' ENV_FORWARD_IGNORE='${ENV_FORWARD_IGNORE}' bash -s" 2>/dev/null <<'REMOTE'
set -uo pipefail
H="${HOST_NAME:-?}"
em(){ printf '%s\n' "$*"; }
rd(){ awk -v k="$1" '$1==k{print int($2/1024)}' /proc/meminfo; }   # MiB

# ── A. SERVER HEALTH ─────────────────────────────────────────────────────────
load1=$(awk '{print $1}' /proc/loadavg); cores=$(nproc)
em "METRIC|$H|load_1m|${load1} (of ${cores} vCPU)|$(awk -v l="$load1" -v c="$cores" 'BEGIN{print (l>c)?"warn":"ok"}')"

memtotal=$(rd MemTotal:); memavail=$(rd MemAvailable:)
mst=ok; [ "${memavail:-0}" -lt "$MEM_AVAIL_WARN" ] && mst=warn
em "METRIC|$H|mem_avail|${memavail}MiB / ${memtotal}MiB|$mst"
[ "$mst" = warn ] && em "ISSUE|P1|$H|-|Low memory headroom|Only ${memavail}MiB available (warn<${MEM_AVAIL_WARN}MiB); OOM risk under load."

swaptotal=$(rd SwapTotal:); swapfree=$(rd SwapFree:); swapused=$(( ${swaptotal:-0} - ${swapfree:-0} ))
if [ "${swaptotal:-0}" -eq 0 ]; then
  em "METRIC|$H|swap|NONE|warn"
  em "ISSUE|P1|$H|-|No swap configured|0 swap: an OOM hard-kills a gateway instead of degrading. Add a swapfile."
else
  sst=ok; [ "$swapused" -gt "$SWAP_USED_WARN" ] && sst=warn
  em "METRIC|$H|swap_used|${swapused}MiB / ${swaptotal}MiB|$sst"
  [ "$sst" = warn ] && em "ISSUE|P1|$H|-|Heavy swap usage|${swapused}MiB swap in use; host is memory-pressured. Consider a RAM rescale."
fi

diskpct=$(df -P / | awk 'END{gsub("%","",$5); print $5}')
dst=ok; [ "$diskpct" -ge "$DISK_WARN" ] && dst=warn; [ "$diskpct" -ge "$DISK_CRIT" ] && dst=crit
em "METRIC|$H|disk_root|${diskpct}%|$dst"
[ "$diskpct" -ge "$DISK_CRIT" ] && em "ISSUE|P0|$H|-|Disk almost full|Root fs ${diskpct}% used (crit>=${DISK_CRIT}%)."
[ "$diskpct" -ge "$DISK_WARN" ] && [ "$diskpct" -lt "$DISK_CRIT" ] && em "ISSUE|P2|$H|-|Disk filling|Root fs ${diskpct}% used (warn>=${DISK_WARN}%)."

if [ ! -f /etc/docker/daemon.json ] || ! grep -q max-size /etc/docker/daemon.json 2>/dev/null; then
  em "ISSUE|P2|$H|-|No docker log rotation|/etc/docker/daemon.json lacks max-size; container logs grow unbounded (disk-fill risk on a crash loop)."
fi

if dmesg -T 2>/dev/null | grep -qiE 'Out of memory: Killed process'; then
  em "ISSUE|P1|$H|-|OOM kill in kernel log|$(dmesg -T 2>/dev/null | grep -iE 'Out of memory: Killed process' | tail -1 | cut -c1-160)"
fi

# ── B. AGENT / CONTAINER STATUS ──────────────────────────────────────────────
for cname in $(docker ps -a --format '{{.Names}}' | grep -- '-openclaw-gateway-1' 2>/dev/null); do
  agent="${cname%-openclaw-gateway-1}"
  status=$(docker inspect -f '{{.State.Status}}' "$cname" 2>/dev/null || echo missing)
  restarts=$(docker inspect -f '{{.RestartCount}}' "$cname" 2>/dev/null || echo 0)
  envf="/root/.openclaw/agents/${agent}/docker.env"
  gwport=$(grep -E '^OPENCLAW_GATEWAY_PORT=' "$envf" 2>/dev/null | cut -d= -f2)

  cst=ok; [ "$status" != running ] && cst=crit
  em "METRIC|$H|agent:${agent}|${status} restarts=${restarts} port=${gwport:-?}|$cst"

  # Restart-count delta vs the previous scan, keyed on container ID so a
  # recreate (new ID, counter reset to 0) starts a fresh baseline instead of
  # producing false alarms.
  cid=$(docker inspect -f '{{.Id}}' "$cname" 2>/dev/null | cut -c1-12)
  if [ -n "$cid" ]; then
    prevr=$(grep "^${cid} " /var/tmp/agentglob-restart-baseline.txt 2>/dev/null | awk '{print $2}' | head -1)
    if [ -n "$prevr" ] && [ "$restarts" -ge $((prevr + 3)) ]; then
      em "ISSUE|P1|$H|$agent|Restart count climbing|RestartCount ${prevr}→${restarts} since the last scan (same container) — instability even if the error signature is unknown."
    fi
    echo "$cid $restarts $cname" >> /var/tmp/agentglob-restart-baseline.next
  fi

  if [ "$status" != running ]; then
    em "ISSUE|P0|$H|$agent|Agent not running|Container status='${status}' (expected running)."
    continue
  fi
  case "$(docker ps --filter "name=^${cname}$" --format '{{.Status}}')" in
    Restarting*) em "ISSUE|P0|$H|$agent|Crash loop|Container is restarting repeatedly." ;;
  esac
  # gateway actually serving? (catches internal boot-loops: container 'Up' but
  # the gateway never reaches 'listening', e.g. the mcp-bridge EPIPE loop)
  if [ -n "$gwport" ] && ! ss -ltn 2>/dev/null | grep -q ":${gwport} "; then
    em "ISSUE|P0|$H|$agent|Gateway port not listening|Port ${gwport} not bound; gateway not serving (possible boot loop)."
  fi

  logs=$(docker logs "$cname" --since "$LOG_SINCE" 2>&1)
  printf '%s' "$logs" | grep -qiE 'Uncaught exception|EPIPE' \
    && em "ISSUE|P1|$H|$agent|Gateway uncaught exception|EPIPE/Uncaught in last ${LOG_SINCE} — likely a plugin/MCP server crash (see mcp-bridge)."
  # `aborted due to timeout` was REMOVED from this pattern 2026-08-10. It matched
  # the venice model-DISCOVERY timeout, which the P2 rule below already reports
  # correctly — so one boot-time line raised two issues, and this one told the
  # reader to go look at a hanging or invalid primary model, which is not what
  # happened. Discovery runs at startup, so EVERY fleet recreate produced a wave
  # of these: a 15-agent EU roll produced 13 (measured; on researcher the sole
  # match was one line 32s after container start, with zero user-facing failures
  # after it). Same shape as the 401 rule above — two different failures sharing
  # one rule, the remedy wrong for one of them. This rule now keeps only the
  # signals that mean a real request went unanswered.
  printf '%s' "$logs" | grep -qiE 'typing TTL reached|no reply' \
    && em "ISSUE|P1|$H|$agent|Model not responding|typing-TTL / no-reply in logs — a request went unanswered; primary model may be hanging or invalid."
  # Two DIFFERENT failures used to share this rule, and the shared remedy was
  # wrong for one of them. Measured on us/projectmanager (2026-08-09): the only
  # matches were two `[ws] unauthorized … reason=token_mismatch` lines, and the
  # row told the reader to go rotate a bot token or an API key — neither of
  # which is involved. `Unauthorized` here is the GATEWAY's own auth handshake,
  # not a provider 401. Genuine revoked-credential cases are already caught,
  # correctly, by the `terminal channel error` rule below.
  printf '%s' "$logs" | grep -qiE 'setMyCommands.*401|: 401' \
    && em "ISSUE|P1|$H|$agent|Provider auth failure (401)|A 401 from an upstream API in the last ${LOG_SINCE} — bot token or API key likely invalid."
  printf '%s' "$logs" | grep -q 'reason=token_mismatch' \
    && em "ISSUE|P1|$H|$agent|Gateway token mismatch|The dashboard and this container disagree on the gateway token, so calls are refused before reaching the model — chat fails with a generic error. NOT a bot token or API key. Restart the container (it re-reads its config on boot); if it recurs, redeploy."
  printf '%s' "$logs" | grep -qiE 'Discovery attempt failed: TimeoutError' \
    && em "ISSUE|P2|$H|$agent|Model-provider discovery timeout|A provider (e.g. venice) discovery is timing out; fallback may be impaired."
  printf '%s' "$logs" | grep -qiE 'No servers configured' \
    && em "ISSUE|P3|$H|$agent|mcp-bridge no servers|mcp-bridge loaded with no servers (log noise; harmless)."
  printf '%s' "$logs" | grep -q 'terminal channel error' \
    && em "ISSUE|P1|$H|$agent|Channel paused on terminal error|Gateway circuit paused a channel (invalid credential — e.g. revoked bot token). Fix the credential; it re-probes hourly."

  # Tight-loop detector: log bytes written in the last hour (file size is
  # capped by rotation, so measure via docker logs --since).
  lograte=$(docker logs --since 1h "$cname" 2>&1 | wc -c)
  if [ "${lograte:-0}" -gt $((5 * 1024 * 1024)) ]; then
    em "ISSUE|P2|$H|$agent|High log write rate|$((lograte / 1024 / 1024))MB of log output in the last hour — likely a tight error loop."
  fi

  # ── env forwarding: a docker.env key that never reaches the container ─────
  # docker-compose.yml has NO `env_file`, so a per-agent key is delivered only
  # if it is ALSO named in both compose `environment:` blocks. Forget that and
  # the feature ships silently broken: the dashboard saves the key and reports
  # success while the agent behaves as if it were never set. This class has
  # bitten four times (AGENTGLOB_RUNTIME_*, GMAIL_*/GCAL_*, HERE_NOW, and the
  # grid skill) and every time a human found it days later — see OB-22 / OB-21.
  #
  # Deliberately checked by SYMPTOM rather than against a list of key names:
  # "present on disk, absent in the container" needs no knowledge of which keys
  # exist, so a key invented next month is covered without editing this script.
  # It also catches host compose drift, which a name-list check would miss.
  if [ -f "$envf" ]; then
    _cenv=$(docker exec "$cname" env 2>/dev/null | cut -d= -f1 | sort -u)   # one exec per agent, not per key
    if [ -n "$_cenv" ]; then
      _missing=""
      for _k in $(grep -oE "^[A-Za-z_][A-Za-z0-9_]*=" "$envf" 2>/dev/null | tr -d "=" | sort -u); do
        case " $ENV_FORWARD_IGNORE " in *" $_k "*) continue ;; esac
        printf "%s\n" "$_cenv" | grep -qx "$_k" || _missing="${_missing}${_k} "
      done
      if [ -n "$_missing" ]; then
        em "ISSUE|P2|$H|$agent|Key in docker.env never reaches the container|Saved for this agent but missing from its container env: ${_missing}- so any skill needing it fails as though unconfigured, while the dashboard shows it set. Cause is nearly always the compose allowlist: add the key to BOTH service blocks in /opt/openclaw/docker-compose.yml (with a :- default so agents without it are unaffected), then recreate the agent with: cd /opt/openclaw && docker compose -p ${agent} --env-file ${envf} up -d openclaw-gateway. If the key IS already in the repo compose, then THIS HOST has drifted - reconcile /opt/openclaw to main."
      fi
    fi
  fi

  # ── per-agent disk: sessions + workspace (outside docker log rotation) ────
  agdir="/root/.openclaw/agents/${agent}"
  for _chk in "sessions:${SESSION_DIR_WARN_MB}:P2" "workspace:${WORKSPACE_DIR_WARN_MB}:P1"; do
    _sub="${_chk%%:*}"; _rest="${_chk#*:}"; _thresh="${_rest%%:*}"; _pri="${_rest#*:}"
    _path="${agdir}/${_sub}"
    [ -d "$_path" ] || continue
    _mb=$(du -sm "$_path" 2>/dev/null | awk '{print int($1+0)}')
    [ -n "$_mb" ] || continue
    [ "$_mb" -gt 0 ]  || continue
    _st=ok; [ "$_mb" -ge "$_thresh" ] && _st=warn
    em "METRIC|$H|agent:${agent}:${_sub}_mb|${_mb}MB|${_st}"
    [ "$_st" = warn ] && em "ISSUE|${_pri}|$H|${agent}|Large ${_sub} dir|${_sub}/ is ${_mb}MB (warn>=${_thresh}MB); grows unbounded — consider archiving old data."
  done
done

# Rotate the restart baseline written above (next scan compares against it).
if [ -f /var/tmp/agentglob-restart-baseline.next ]; then
  mv /var/tmp/agentglob-restart-baseline.next /var/tmp/agentglob-restart-baseline.txt
fi

# Fold the hourly gateway-watchdog's findings (last 24h) into this scan —
# the watchdog never writes bug_list.md itself (single-writer rule).
if [ -f /root/.openclaw/watchdog-state.json ]; then
  python3 - <<'PYWD'
import json, datetime
try:
    entries = json.load(open("/root/.openclaw/watchdog-state.json"))
except Exception:
    entries = []
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
import os
H = os.environ.get("HOST_NAME", "?")
for e in entries:
    try:
        ts = datetime.datetime.fromisoformat(e["ts"].replace("Z", "+00:00"))
    except Exception:
        continue
    if ts < cutoff:
        continue
    agent = e.get("container", "?").replace("-openclaw-gateway-1", "")
    action, reason = e.get("action"), e.get("reason", "?")
    if action in ("skipped", "start-failed"):
        print(f"ISSUE|P1|{H}|{agent}|Watchdog: container down, not revived|action={action} reason={reason} at {e['ts']} — needs human action.")
    elif action == "revived":
        print(f"ISSUE|P3|{H}|{agent}|Watchdog revived container|exit={e.get('exitCode')} at {e['ts']} — crashed and was auto-restarted; check why it exited.")
PYWD
fi

em "METRIC|$H|reachable|yes|ok"
REMOTE
}

# ── Run probes ───────────────────────────────────────────────────────────────
TMP="$(mktemp "${TMPDIR:-/tmp}/agdiag.XXXXXX")"; trap 'rm -f "$TMP"' EXIT
echo "AgentGlob fleet diagnostic — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Hosts:$SELECT    log-window: ${LOG_SINCE}"
for h in $SELECT; do
  ip="$(host_ip "$h")"
  if [[ -z "$ip" ]]; then echo "ISSUE|P0|$h|-|Unknown host|No IP mapping for '$h'." >>"$TMP"; continue; fi
  out="$(remote_probe "$h" "$ip")"
  if [[ -n "$out" ]]; then printf '%s\n' "$out" >>"$TMP"
  else echo "ISSUE|P0|$h|-|Host unreachable|SSH to ${ip} failed or returned nothing (down, overloaded, or key/network issue)." >>"$TMP"; fi
done

# ── Merge model-connectivity issues (state file from models_connectivity_check.sh,
#    run by cron at 05:50; ignored when stale > 6 h) ───────────────────────────
MODEL_ISSUES_FILE="${MODEL_ISSUES_FILE:-/var/tmp/agentglob-model-issues.txt}"
if [[ -f "$MODEL_ISSUES_FILE" && -n "$(find "$MODEL_ISSUES_FILE" -mmin -360 2>/dev/null)" ]]; then
  grep '^ISSUE|' "$MODEL_ISSUES_FILE" >>"$TMP" 2>/dev/null || true
fi

# ── Merge dependency-audit issues (state file from deps-audit-cron.sh, 05:45;
#    an absent/stale file is itself a P2 — silence must not hide a dead audit) ─
DEPS_ISSUES_FILE="${DEPS_ISSUES_FILE:-/var/tmp/agentglob-deps-issues.txt}"
if [[ -f "$DEPS_ISSUES_FILE" && -n "$(find "$DEPS_ISSUES_FILE" -mmin -360 2>/dev/null)" ]]; then
  grep '^ISSUE|' "$DEPS_ISSUES_FILE" >>"$TMP" 2>/dev/null || true
else
  echo "ISSUE|P2|deps|-|Dependency audit missing|state file absent or >6h old — the 05:45 deps-audit cron did not run or failed." >>"$TMP"
fi

# ── A+B report ───────────────────────────────────────────────────────────────
echo; echo "════════ A+B. SERVER HEALTH & AGENT STATUS ════════"
for h in $SELECT; do
  echo; echo "── $(host_label "$h") ($(host_ip "$h")) ──"
  grep "^METRIC|$h|" "$TMP" | while IFS='|' read -r _ host name value st; do
    mark='  ok '; [ "$st" = warn ] && mark=' WARN'; [ "$st" = crit ] && mark=' CRIT'
    printf '  [%s] %-30s %s\n' "$mark" "$name" "$value"
  done
done

# ── C+D issues, prioritised (sort P0→P3, then by host) ───────────────────────
ISSUES=()
while IFS= read -r _l; do [[ -n "$_l" ]] && ISSUES+=("$_l"); done \
  < <(grep '^ISSUE|' "$TMP" | sort -t'|' -k2,2 -k3,3)

echo; echo "════════ C+D. ISSUES (prioritised) ════════"
if [[ ${#ISSUES[@]} -eq 0 ]]; then
  echo "  ✓ No issues detected. Fleet is healthy."
else
  c0=0; c1=0; c2=0; c3=0
  for line in "${ISSUES[@]}"; do
    IFS='|' read -r _ sev host agent title detail <<<"$line"
    case "$sev" in P0) c0=$((c0+1));; P1) c1=$((c1+1));; P2) c2=$((c2+1));; P3) c3=$((c3+1));; esac
    printf '  %s  [%s/%s] %s\n          %s\n' "$sev" "$host" "$agent" "$title" "$detail"
  done
  echo; echo "  Totals: P0=${c0}  P1=${c1}  P2=${c2}  P3=${c3}"
fi

# ── E. write bug_list.md AUTOSCAN block ──────────────────────────────────────
if [[ $WRITE -eq 1 ]]; then
  gen="$(mktemp "${TMPDIR:-/tmp}/agdiag.XXXXXX")"
  {
    echo "_Last automated scan: $(date '+%Y-%m-%d %H:%M:%S %Z') · hosts:${SELECT}_"
    echo
    if [[ ${#ISSUES[@]} -eq 0 ]]; then
      echo "✓ No issues detected by the last scan."
    else
      echo "| Pri | Host | Agent | Issue | Detail |"
      echo "|-----|------|-------|-------|--------|"
      for line in "${ISSUES[@]}"; do
        IFS='|' read -r _ sev host agent title detail <<<"$line"
        echo "| ${sev} | ${host} | ${agent} | ${title} | ${detail} |"
      done
    fi
  } >"$gen"

  if [[ -f "$BUG_LIST" ]] && grep -q 'AUTOSCAN:START' "$BUG_LIST"; then
    awk -v genf="$gen" '
      BEGIN{ while((getline l < genf)>0) g=g l ORS }
      /AUTOSCAN:START/{ print; print ""; printf "%s", g; skip=1; next }
      /AUTOSCAN:END/{ print ""; skip=0; print; next }
      !skip{ print }
    ' "$BUG_LIST" >"${BUG_LIST}.new" && mv "${BUG_LIST}.new" "$BUG_LIST"
    echo; echo "→ Updated AUTOSCAN block in ${BUG_LIST}"
  else
    echo; echo "WARN: ${BUG_LIST} missing or has no AUTOSCAN markers — not written." >&2
  fi
  rm -f "$gen"
fi

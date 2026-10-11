#!/usr/bin/env bash
# OB-14 boot gate (docs/experiments/plans/gateway-memory-ob14.md §3.4).
#
# Boots <image> twice with every bundled plugin enabled, plus the host extensions kept in a repo:
#   A  as prod runs it: JITI_TRY_NATIVE=1, the compose file's heap flag and mem_limit defaults
#   B  the default jiti loader, uncapped: the reference
# and refuses the image unless A boots, answers the authenticated health RPC, loads the gateway's
# own graph natively (no dist/ or node_modules/ transpiles), peaks <= PEAK_MAX_MB, and registers
# exactly B's plugin inventory. An image that lost native loading would need ~700 MB of heap to
# boot and crash-loop under the 768 cap on every Agent it reached; this stops it before the push.
#
# usage: gateway-boot-check.sh <image>      run on DevAgents; build-and-push.sh calls it pre-push
# exit:  0 pass, 1 fail, 2 setup error
# GATE_SELFTEST=default-loader|extra-plugin breaks run A on purpose; the gate must then FAIL (T2).
set -euo pipefail

IMG="${1:?usage: gateway-boot-check.sh <image>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DASH_REPO="${DASH_REPO:-/root/AgentGlob_Apps/openclaw-dashboard}"
PEAK_MAX_MB=800
COMPOSE="$REPO/docker-compose.yml"
HEAP=$(grep -o -E 'max-old-space-size=\$\{OPENCLAW_MAX_OLD_SPACE_MB:-[0-9]+\}' "$COMPOSE" | grep -o -E '[0-9]+' | tail -1 || true)
MEM=$(grep -o -E 'mem_limit: \$\{OPENCLAW_MEM_LIMIT:-[0-9]+[kmg]\}' "$COMPOSE" | sed -E 's/.*:-//; s/\}//' || true)
[[ -n "$HEAP" && -n "$MEM" ]] || { echo "SETUP: cannot read the heap/mem defaults from $COMPOSE"; exit 2; }
EXT_SRC=("$DASH_REPO/assets/mcp-bridge" "$REPO/ops/graphiti-life/extensions/life-memory-scope")
for d in "${EXT_SRC[@]}"; do [[ -f "$d/index.js" ]] || { echo "SETUP: missing host extension $d"; exit 2; }; done

WORK=$(mktemp -d /tmp/ob14-gate.XXXXXX)
RUNS=()
cleanup() { for c in "${RUNS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

ids=$(docker run --rm --network none --entrypoint node -w /app/extensions "$IMG" -e '
  const fs = require("fs");
  for (const d of fs.readdirSync(".")) {
    try { console.log(JSON.parse(fs.readFileSync(d + "/openclaw.plugin.json", "utf8")).id); } catch {}
  }')
[[ -n "$ids" ]] || { echo "SETUP: no bundled plugin ids found in $IMG"; exit 2; }

# A state dir: every bundled plugin enabled, plus the host extensions.
state() {
  mkdir -p "$1/extensions"
  for d in "${EXT_SRC[@]}"; do cp -r "$d" "$1/extensions/"; done
  python3 -c 'import json, sys; json.dump({"gateway": {"mode": "local"}, "plugins": {"entries": {i: {"enabled": True} for i in sys.argv[2:]}}}, open(sys.argv[1], "w"))' "$1/openclaw.json" $ids
  if [[ "${GATE_SELFTEST:-}" == extra-plugin && "$2" == A ]]; then # a plugin only A has
    mkdir -p "$1/extensions/ob14-gate-selftest"
    echo '{"name":"ob14-gate-selftest","type":"module","openclaw":{"extensions":["index.js"]}}' > "$1/extensions/ob14-gate-selftest/package.json"
    echo '{"id":"ob14-gate-selftest","configSchema":{"type":"object","properties":{}}}' > "$1/extensions/ob14-gate-selftest/openclaw.plugin.json"
    echo 'export default { id: "ob14-gate-selftest", name: "selftest", activate() {} };' > "$1/extensions/ob14-gate-selftest/index.js"
  fi
  chown -R 1000:1000 "$1"
}

# boot <A|B> <JITI_TRY_NATIVE> [heap MB] [mem limit]: start, wait for listening, write $WORK/<run>.*
boot() {
  local run=$1 native=$2 heap=${3:-} mem=${4:-} c="ob14-gate-$1-$$" up=no t0
  state "$WORK/$run" "$run"
  local flag=() memarg=()
  [[ -n "$heap" ]] && flag=("--max-old-space-size=$heap")
  [[ -n "$mem" ]] && memarg=("--memory=$mem")
  RUNS+=("$c")
  t0=$(date +%s)
  docker run -d --name "$c" --network none "${memarg[@]}" -e HOME=/home/node -e JITI_DEBUG=1 \
    -e JITI_TRY_NATIVE="$native" -e OPENCLAW_GATEWAY_TOKEN="gate-$RANDOM$RANDOM$RANDOM$RANDOM" \
    -v "$WORK/$run":/home/node/.openclaw "$IMG" \
    node "${flag[@]}" dist/index.js gateway --bind lan --port 18789 >/dev/null
  for _ in $(seq 1 45); do
    sleep 2
    [[ "$(docker inspect -f '{{.State.Status}}' "$c")" == running ]] || break
    docker logs "$c" 2>&1 | grep -q "listening on ws://" && { up=yes; break; }
  done
  [[ $up == yes ]] && sleep 20 # post-listen boot work (plugin activation, MCP servers)
  echo "$up $(( $(date +%s) - t0 ))" > "$WORK/$run.up"
  docker inspect -f '{{.State.Status}} {{.State.OOMKilled}} {{.State.Pid}}' "$c" > "$WORK/$run.state"
  docker logs "$c" > "$WORK/$run.log" 2>&1 || true
  if [[ $up == yes ]]; then
    awk '/^VmHWM/{print int($2/1024)}' "/proc/$(cut -d' ' -f3 "$WORK/$run.state")/status" > "$WORK/$run.peak" 2>/dev/null || true
    docker exec -e JITI_DEBUG=0 "$c" node --max-old-space-size=256 dist/index.js health >/dev/null 2>&1
    echo $? > "$WORK/$run.health" || true
    docker exec -e JITI_DEBUG=0 "$c" node dist/index.js plugins list --json > "$WORK/$run.json" 2>/dev/null || true
  fi
}

set +e # from here on every check reports instead of aborting
A_NATIVE=1; [[ "${GATE_SELFTEST:-}" == default-loader ]] && A_NATIVE=0
boot A "$A_NATIVE" "$HEAP" "$MEM"
boot B 0

read -r B_UP _ < "$WORK/B.up"
[[ $B_UP == yes && -s "$WORK/B.json" ]] || { echo "SETUP: reference run B did not boot; see its log"; tail -20 "$WORK/B.log"; exit 2; }

fail=0
report() { if [[ $1 == 0 ]]; then echo "  ok    $2"; else echo "  FAIL  $2"; fail=1; fi; }
read -r A_UP A_SECS < "$WORK/A.up"
read -r A_STATUS A_OOM _ < "$WORK/A.state"
A_PEAK=$(cat "$WORK/A.peak" 2>/dev/null || echo "?")
A_HEALTH=$(cat "$WORK/A.health" 2>/dev/null || echo "?")
OWN=$(grep '\[jiti\] \[transpile\]' "$WORK/A.log" | grep -c -E '\] \./(dist|node_modules)/')
DIFF=$(python3 - "$WORK/A.json" "$WORK/B.json" <<'PY2'
import json, sys
KEYS = ("status", "toolNames", "hookNames", "channelIds", "providerIds", "gatewayMethods",
        "services", "commands", "cliCommands", "httpHandlers", "hookCount")
def inventory(path):
    try:  # the CLI may print plugin log lines before its JSON; parse from the first "{" line
        text = open(path).read()
        start = 0 if text.startswith("{") else text.index("\n{") + 1
        plugins = json.JSONDecoder().raw_decode(text[start:])[0]["plugins"]
    except Exception as e:
        return {"<unreadable " + path + ">": str(e)}
    return {p["id"]: {k: sorted(p[k]) if isinstance(p.get(k), list) else p.get(k) for k in KEYS} for p in plugins}
a, b = inventory(sys.argv[1]), inventory(sys.argv[2])
for pid in sorted(set(a) | set(b)):
    if a.get(pid) != b.get(pid):
        print(f"{pid}: A={a.get(pid)} B={b.get(pid)}")
PY2
)
echo "OB-14 boot gate: $IMG  (heap ${HEAP} MB, mem ${MEM}, $(echo $ids | wc -w) bundled plugins + ${#EXT_SRC[@]} host extensions)"
[[ $A_UP == yes && $A_STATUS == running && $A_OOM == false ]]
report $? "A booted in ${A_SECS}s, status=$A_STATUS, OOMKilled=$A_OOM"
[[ $A_HEALTH == 0 ]]
report $? "A health RPC exit=$A_HEALTH"
[[ $OWN == 0 ]]
report $? "A transpiled $OWN files of the gateway's own graph (dist/, node_modules/); must be 0"
[[ $A_PEAK =~ ^[0-9]+$ ]] && (( A_PEAK <= PEAK_MAX_MB ))
report $? "A peak RSS ${A_PEAK} MB; max ${PEAK_MAX_MB}"
INV=$(python3 -c 'import json, sys
t = open(sys.argv[1]).read(); t = t[0 if t.startswith("{") else t.index("\n{") + 1:]
ps = json.JSONDecoder().raw_decode(t)[0]["plugins"]
print(len(ps), "plugins,", sum(p["status"] == "loaded" for p in ps), "loaded,", sum(len(p["toolNames"]) for p in ps), "tools,", sum(p["hookCount"] for p in ps), "hooks")' "$WORK/B.json" 2>/dev/null || echo "?")
[[ -z $DIFF ]]
report $? "plugin inventory A == B ($INV in B)"
[[ -n $DIFF ]] && echo "$DIFF" | head -10 | sed 's/^/        /'
if [[ $fail == 0 ]]; then echo "PASS"; else echo "FAIL (logs were in $WORK, removed on exit)"; fi
exit $fail

# Gateway memory — native plugin loading + a heap cap (OB-14)

> **Status:** Rev 1 — plan for review · **Created:** 2026-10-11 · **Owner go-ahead:** 2026-10-11
>
> **Bug list:** OB-14 (per-gateway caps), OB-9 (host RAM over-commit) in `openclaw-dashboard`
> `docs/ops/bug_list.md`. Replaces the reverted B3 of `channel-error-hardening.md`.
> **Repo:** `cryptolir/openclaw` only. No gateway image build, no fleet image roll.

---

## 1. Problem (measured 2026-10-11)

- Both prod hosts gain ~0.3 GiB of swap per day. Drained by hand 2026-06-22, 07-10 and 10-02.
  Nine days after the 10-02 drain: EU 341 MB available / 4096 MB swap, US 320 MB / 4079 MB (8 GiB
  swap per host). EU runs 15 gateways, US 13, on 7.6 GB each.
- Inside each container one process, the gateway (`node dist/index.js gateway`), holds nearly all
  the memory. MCP children peak at 17–76 MB.
- No gateway has a memory limit or a heap flag (`docker inspect`: `HostConfig.Memory=0`, no
  `NODE_OPTIONS`). So Node sizes the heap from the host: `heap_size_limit` = 2096 MB (Node 22.22.0)
  / 2240 MB (Node 24.20.0) **per gateway**.
- Idle gateways stay small: `specy` 339 MB RSS+swap after 36 days. Active ones grow ~30 MB/day:
  `cashtronics` ~330 MB after its 10-02 restart → 620 MB nine days later; `projectmanager` 1051 MB
  after 8 days; `life` 1447 MB after 37 days. None of the grown gateways has done an in-process
  restart or a second plugin load since boot (log counts: `signal SIGUSR1 received` = 0), so this is
  not a reload leak. Whether it is uncollected garbage or a real leak is not known. The cap below
  bounds it either way.

## 2. Why B3 crashed, and why a cap alone cannot work today

B3 set `mem_limit: 1g` with no heap flag. Node then derives its heap limit from the cgroup limit
(about a quarter of it, ~256 MB), and the EU fleet crash-looped at boot. The heap flag fixes that
part. Booting is the real obstacle.

Measured on DevAgents with throwaway containers (`--network none`, empty state dir, dummy token,
`--allow-unconfigured`) on every image build the fleet runs:

- A fresh boot needs **650–700 MB of live heap**. At `--max-old-space-size=512`, 576 and 640 the
  gateway dies with `FatalProcessOutOfMemory` (`Mark-Compact 507.9 -> 506.8 MB`: almost nothing
  was collectable). At 704 it boots. Uncapped, the boot peak is 1.3–2.3 GB RSS, and the process
  settles at 375–455 MB.
- **Cause.** A heap snapshot taken at the peak (`--heapsnapshot-near-heap-limit`, cap 640) is mostly
  Babel AST: `NodePath` 81 MB, `Node` 48, `Position` 33, `SourceLocation` 30, plus ~140 MB of their
  element/property arrays. `src/plugins/loader.ts:399` loads plugins through `createJiti(...)`.
  jiti then transpiles every module the plugins import, reached through the `openclaw/plugin-sdk`
  alias (`loader.ts:405` → `dist/plugin-sdk/index.js`). With `JITI_DEBUG=1`, a bare boot logs **482
  transpiles**: 419 `node_modules`, 59 `dist` chunks and 4 extension entry points. That is a second,
  transpiled copy of the gateway's own dependency graph.
- jiti caches its output in `/tmp/jiti` inside the container. `docker restart` reuses that cache;
  a recreate starts empty. Verified on the hosts: `cashtronics`, restarted 10-02, still has its 486
  cache files from container creation (09-02), and its peak RSS (VmHWM) is 524 MB. Gateways
  recreated 09-29 to 10-07 show VmHWM of 1274–1425 MB.

So a cap low enough to matter (≤ 512) cannot boot, and a cap that can boot (~1 GB) bounds nothing
useful.

## 3. The fix

### 3.1 Native plugin loading: `JITI_TRY_NATIVE=1`

jiti 2.6.1, which every image ships, reads `JITI_TRY_NATIVE` from the environment. With it set,
jiti first tries Node's own `require` (which loads ESM on Node ≥ 22.12 and strips TS types on these
versions) and falls back to transpiling a module only when that fails. Value parsing is
`Boolean(JSON.parse(env))`: measured `1` → native, `0` → 480 transpiles (the old behaviour).

Measured on all seven builds in prod: `v2026.9.1.1` and `v2026.9.4.1` (Node 22); `v2026.9.7.1`,
`v2026.9.7.2`, `v2026.09.09.1` and `v2026.09.29.1` (Node 24); the local `openclaw:v2026.09.09.1`
has the same image id as `v2026.09.09.1`.

|                             | default jiti | `JITI_TRY_NATIVE=1`     |
| --------------------------- | ------------ | ----------------------- |
| boot peak RSS               | 1294–2293 MB | 386–478 MB              |
| time to `listening`         | 38–41 s      | 24–25 s                 |
| settled RSS                 | 375–455 MB   | 318–342 MB              |
| smallest cap that boots     | 704 MB       | ≤ 384 MB (lowest tried) |
| jiti events in the boot log | 1468         | 10                      |

Both modes load the same four bundled entry points (`device-pair`, `memory-core`,
`phone-control`, `talk-voice`). The gateway's non-jiti boot log is line-for-line identical. Only
`extensions/memory-core/index.ts` falls back to transpile, because native resolution fails with
`ERR_MODULE_NOT_FOUND`: one file, 109 ms.

**The behaviour change to attack:** plugins now share the gateway's own module instances of `dist/*`
and `node_modules`. Until now they got a separate transpiled copy.

### 3.2 Heap cap: `--max-old-space-size` on the gateway command

The flag goes in the compose `command`, not in `NODE_OPTIONS`. That way only the gateway process
gets it. `NODE_OPTIONS` would be inherited by MCP servers, exec-tool children and `docker exec` CLI
runs, and it is already on exec's `DANGEROUS_HOST_ENV_VARS` list
(`src/agents/bash-tools.exec-runtime.ts`). The gateway is the container's only node process:
`docker-entrypoint.sh` execs it, and `entry.ts`'s respawn does not fire. If it ever did, it forwards
`process.execArgv`. An explicit flag also overrides Node's cgroup-derived default, which disarms the
B3 trap if a `mem_limit` is added later.

**Default 768 MB.** That is twice the native boot need (≤ 384 MB) and above every settled RSS
measured. It holds a gateway to roughly 0.9–1.0 GB RSS, where today's heap ceiling is ~2.1 GB.

### 3.3 The compose diff (`docker-compose.yml`, `openclaw-gateway` service only)

```yaml
environment:
  # …existing entries…
  # OB-14 (docs/experiments/plans/gateway-memory-ob14.md): load plugins with Node's own loader.
  # Without it jiti Babel-transpiles a second copy of the gateway's dependency graph on every
  # fresh boot (482 files, ~650 MB live heap, 1.3–2.3 GB peak RSS). Escape hatch per Agent:
  # OPENCLAW_JITI_TRY_NATIVE=0 in its docker.env restores the old loader.
  JITI_TRY_NATIVE: ${OPENCLAW_JITI_TRY_NATIVE:-1}
# …
# OB-14: explicit heap cap. Without it Node sizes the heap from the RAM it sees (~2.1 GB per
# gateway here), and under a cgroup limit from that limit, which is what crash-looped the EU
# fleet in B3 (2026-06-10). Depends on JITI_TRY_NATIVE above: the transpiling loader needs
# ~700 MB of heap to boot. Per-Agent override: OPENCLAW_MAX_OLD_SPACE_MB in its docker.env.
command: [
    "node",
    "--max-old-space-size=${OPENCLAW_MAX_OLD_SPACE_MB:-768}",
    "dist/index.js",
    "gateway",
    # …unchanged…
  ]
```

- Both knobs are interpolation-only. Compose reads them from the Agent's `docker.env` through
  `--env-file`, so neither needs an entry in the environment allowlist. No Agent sets either at
  launch.
- The B3 `NOTE` comment above `command:` is replaced by the one shown.
- The `openclaw-cli` service is untouched.

### 3.4 Boot gate: `scripts/ops/gateway-boot-check.sh <image>`

This script boots `<image>` exactly as compose will, with the same heap flag (read from the
compose file) and `JITI_TRY_NATIVE=1`. It uses `--network none` and a throwaway state dir. It passes
only if the gateway logs `listening on ws://` within 90 s and is still running 20 s later. The
script is ~30 lines and is the DevAgents tool behind every number in this plan.

It is called from `/opt/openclaw-ops/scripts/build-and-push.sh` between `docker build` and
`docker push`: a failing image is never pushed or registered, so it can never be rolled. Every
image passes through that script, and since `STATUS.md` (Deploy Rules) prod image rolls are the
owner's per-Agent dashboard **Upgrade** (not `deploy.sh`), it is the one gate all paths share.

The gate protects against a future image that stops loading the SDK natively. That image would
fall back to transpiling, need ~700 MB at boot, and crash-loop under 768 on every Agent the owner
upgrades: B3 again, one click at a time. `build-and-push.sh` is host-only (not in git). That gap
predates this plan and goes on the bug list. The edit keeps a `.bak` and is recorded in `STATUS.md`
"Hosts, by hand".

## 4. Invariants

- **I1** Every gateway boots under its cap with native loading on. Per image: the boot gate. Per
  Agent: HTTP 200 on its port, `RestartCount` unchanged, no `heap out of memory` in its log.
- **I2** No Agent loses a plugin, tool or channel. Its boot log before and after the change shows
  the same plugin registrations, `[mcp-bridge] Registered tool` count, channel `starting provider`
  lines and skill warnings.
- **I3** `life`'s per-user memory scoping still applies. Its `life-memory-scope` and
  `life-access-scope` registrations appear after the change exactly as before. The graphiti proxy
  already fails closed without the injected `group_id` (INFRASTRUCTURE §8.1), so a scoping loss
  would show as failed memory calls, not leaked ones. Verify that the first real memory call after
  the change succeeds.
- **I4** Only the gateway process gets the flag (§3.2).
- **I5** The shared `/opt/openclaw/docker-compose.yml` on a host changes only after the canary
  stages pass (§5). A merge reaches hosts uncontrolled: the dashboard deploy route pulls `main` into
  `/opt/openclaw` before every Agent deploy.
- **I6** This rollout writes no `docker.env`.

## 5. Rollout

1. **Implementation PR**: the compose diff, `gateway-boot-check.sh`, and its test (§6).
2. **Canary, `testingbot`** (EU, Node 24), run from the PR branch so nothing shared changes. Copy
   the PR's compose to `/root/ob14-canary/` on EU and run
   `docker compose -p testingbot --env-file /root/.openclaw/agents/testingbot/docker.env -f /root/ob14-canary/docker-compose.yml up -d openclaw-gateway`.
   The compose has no relative paths, so it resolves identically. Gates: I1; VmHWM < 600 MB; I2
   against the pre-change log; public-chat `smoke-ok`; one hour clean.
3. **Cohort**, same method, 24 h. Three internal Agents that cover Node 22, Telegram and
   mcp-bridge servers: `cashtronics` (EU), `support` (US) and `vcode1bot` (US; filesystem, brave and
   github MCPs). Same gates.
4. **Merge**, then bring each host's checkout up to `main`. This lands only the change plus commits
   already on `main`: EU is 2 commits behind (ops scripts), US is 25 behind (incl. three merged
   compose env additions #160/#161/#168, all empty for these Agents). Use
   `git -C /opt/openclaw pull --ff-only`; both checkouts are clean, and never `stash -u` (OB-43).
5. **Roll the rest**, one Agent at a time:
   `cd /opt/openclaw && docker compose -p <a> --env-file /root/.openclaw/agents/<a>/docker.env up -d openclaw-gateway`.
   This is the same command the dashboard and `deploy.sh` use, with the image unchanged. Apply the
   per-Agent gates from I1 and I2, stop at the first failure, and keep restarts out of minute :16–:17
   (the hourly watchdog `docker start`s any exited gateway). On US, wait for load < 2 before the
   next one. EU first, then US. Last, each verified on its own: `life` (I3), `projectmanager` and
   `calendar-demo-pkpiii` (the Google Calendar review Agents).
6. **Do not start** the stopped gateways (`researcher` EU, `social-bob` US). They pick up the change
   at their next deploy.

**Rollback.** Before step 4, recreate the Agent from `/opt/openclaw/docker-compose.yml`, which is
still unchanged. For one Agent after the merge, set `OPENCLAW_JITI_TRY_NATIVE=0` or raise
`OPENCLAW_MAX_OLD_SPACE_MB` through the dashboard Secrets tab (a fenced write), then recreate. For
the whole fleet, revert the PR, `pull --ff-only`, and recreate.

**Done when**, 7 days after step 5: no `FatalProcessOutOfMemory` anywhere; no unplanned restarts
(the daily diagnostic's restart-delta already reports them); boot peaks < 600 MB; host swap flat
(< +0.1 GiB/day/host, against +0.3 today). Record the result on OB-14 and OB-9.

## 6. Tests

- **T1** Compose shape, as plain text checks on `docker-compose.yml` (no docker needed). The
  gateway `command` carries `--max-old-space-size=${OPENCLAW_MAX_OLD_SPACE_MB:-768}` as the argument
  right before `dist/index.js`. `JITI_TRY_NATIVE: ${OPENCLAW_JITI_TRY_NATIVE:-1}` is in the gateway
  env. `openclaw-cli` has neither. Lives beside the existing `scripts/ops/test_*.py`.
- **T2** The boot gate fails closed. On DevAgents it passes a current image and fails the known
  crash, the default loader at `--max-old-space-size=512` (exit 139, `FatalProcessOutOfMemory`). The
  impl PR shows both runs. CI cannot run it: it needs docker and the 8.7 GB images.

## 7. Deliberately not building

- **`mem_limit`.** It is not needed to stop the growth. Add it only if non-heap memory runs away,
  and keep the explicit heap flag (B3).
- **`tryNative` in `loader.ts`.** The env var works on all seven builds without a release. Baking it
  into the code is a follow-up for the next image; the env then becomes redundant.
- **Cap 512.** Decide after 7 days of per-Agent RSS under 768.
- **Finding the steady-growth cause.** The cap bounds it. A gateway that reaches the cap restarts,
  and the daily diagnostic reports the restart.
- **Relaxing the US "≤ 3 boots at once" rule.** A boot now takes 24 s and ~400 MB. Revisit with data.
- **The OB-9 hardware decision** stays with the owner.

## 8. Review asks

1. Can a plugin that now loads natively behave differently from its transpiled copy: shared module
   singletons with the core, `interopDefault: true` semantics, side effects that used to run twice
   and now run once?
2. Can a native attempt run part of a module's top level, fail, and then have jiti run the module
   again transpiled (double registration)?
3. Can `life`'s memory scoping stop applying without anyone seeing it under native loading?
4. Does running one Agent from `/root/ob14-canary/docker-compose.yml` change anything shared
   (networks, labels, volumes, `empty.env`)? Does a later recreate from `/opt/openclaw` put it back
   cleanly?
5. Is 768 safe for every Agent's live heap at its busiest, not just at boot? What fails first, and
   would we see it?
6. Is `build-and-push.sh` really the only path to a rolled image? Does the dashboard Upgrade's own
   health check catch a crash-loop if one slips through?
7. After the merge, can any path recreate an Agent with the new compose before step 5 reaches it,
   and is that safe?

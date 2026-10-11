# Gateway memory — native plugin loading + a heap cap (OB-14)

> **Status:** Rev 3 — folds Codex rounds 1–2 (F1–F5) · **Created:** 2026-10-11 · **Owner go-ahead:** 2026-10-11
>
> **Bug list:** OB-14 (per-gateway caps), OB-9 (host RAM over-commit) in `openclaw-dashboard`
> `docs/ops/bug_list.md`. Replaces the reverted B3 of `channel-error-hardening.md`.
> **Repo:** `cryptolir/openclaw` only. No gateway image build, no fleet image roll.

---

## Rev 2 — Codex round 1

| #   | Finding                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | P2: the boot gate passes a transpiling image, since the default loader boots at 704 MB and the cap is 768 | **Folded.** The gate now asserts native loading directly: at most 5 `[transpile]` events (native: 1; default loader: 480) and peak RSS ≤ 600 MB (native ≤ 478; default ≥ 934). T2 now proves it fails the default loader at the compose cap. §3.4, §6.                                                             |
| F2  | P1: step 5 bypasses the dashboard Upgrade path that AGENTS.md requires for prod rolls                     | **Folded** as an explicit owner exception. AGENTS.md allows `docker compose up` when the user explicitly asks. Upgrade changes the image and recreates from the host's current compose, so it cannot apply an unmerged compose change, and merging first is F3. Its safeguards are matched in §5.                  |
| F3  | P1: after the merge, unrelated deploys spread the change ahead of the ordered rollout                     | **Folded.** The implementation PR now merges **last**, after every running Agent already runs the change. Until then every dashboard path recreates from the host's unchanged compose, so it can only revert an Agent (the safe direction), never advance one. A sweep after the merge catches reverts. §4 I5, §5. |

## Rev 3 — Codex round 2

| #   | Finding                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F4  | P1: `--max-old-space-size` bounds only V8 old space; native/external growth or an MCP child stays unbounded | **Folded.** Adds a cgroup bound, `mem_limit: 1536m`, safely above the verified boot peak (§3.2). With the explicit heap flag, Node no longer derives its heap from the cgroup, which was the B3 trap. Measured: 1536m + flag 1024 → `heap_size_limit` 1048 MB; with no flag, 792 MB. "Done when" gains an early check that tells heap growth from non-heap growth (§5). |
| F5  | P2: HTTP 200 is weaker than Upgrade's WebSocket health check                                                | **Folded.** The per-Agent gate now runs the gateway's own authenticated WebSocket RPC, `node dist/index.js health`, inside the container with its own token. On DevAgents it exits 0 with the right token and 1 with a wrong one. §4 I1, §5.                                                                                                                            |

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
(about half of it on these versions, ~520 MB; measured 792 MB under 1536m), and the EU fleet
crash-looped at boot. The heap flag fixes that
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
`process.execArgv`. An explicit flag also overrides Node's cgroup-derived default. That is what makes
the `mem_limit` below safe, where B3's was not.

**Default 768 MB.** That is twice the native boot need (≤ 384 MB) and above every settled RSS
measured. It holds a gateway to roughly 0.9–1.0 GB RSS, where today's heap ceiling is ~2.1 GB.

**Plus a cgroup bound, `mem_limit: 1536m` (Rev 3, F4).** Node's docs say `--max-old-space-size`
limits only V8's old space. RSS also holds native allocations, code, Buffers, and the container's
MCP children, and the steady growth's cause is unknown (§1). So the container gets a memory bound
too:

- **Why the flag makes it safe.** Measured on DevAgents (`v2026.9.1.1`): under `--memory=1536m`
  with no flag, Node derives `heap_size_limit` = 792 MB from the cgroup. That is the B3 trap: a
  1 GiB limit gives ~520 MB, below the ~650–700 MB boot need. With an explicit flag, the flag wins:
  1536m + flag 1024 → 1048 MB.
- **Headroom.** The native boot peak is ≤ 478 MB bare. The steady worst case is about 768 heap +
  ~300 native + MCP children, roughly 1.3 GB.
- **What happens at the bound.** Docker's default swap allowance equals `mem_limit`. A runaway is
  pushed into its own swap first, then OOM-killed at ~3 GiB RAM+swap. It restarts
  (`unless-stopped`) and shows up in the daily diagnostic's restart-delta.
- **What it is not.** It is a per-gateway backstop, not the host-wide fix: 15 × 1.5 GB is more than
  7.6 GB. The host-wide fix is the heap cap, checked by "Done when".

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
# OB-14: a backstop for what the heap flag below does not bound (native memory, Buffers, MCP
# children). Safe ONLY together with the explicit heap flag: without it Node derives the heap
# from this limit (B3, 2026-06-10). Keep OPENCLAW_MEM_LIMIT >= OPENCLAW_MAX_OLD_SPACE_MB + 768m.
mem_limit: ${OPENCLAW_MEM_LIMIT:-1536m}
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

- All three knobs are interpolation-only. Compose reads them from the Agent's `docker.env` through
  `--env-file`, so neither needs an entry in the environment allowlist. No Agent sets either at
  launch.
- The B3 `NOTE` comment above `command:` is replaced by the one shown.
- The `openclaw-cli` service is untouched.

### 3.4 Boot gate: `scripts/ops/gateway-boot-check.sh <image>`

This script boots `<image>` as compose will: the heap flag and `mem_limit` defaults are read from the
compose file, and `JITI_TRY_NATIVE=1` is set. It runs with `--network none`, a throwaway state dir and
`JITI_DEBUG=1`. It passes only if all four hold:

1. The gateway logs `listening on ws://` within 90 s.
2. It is still running 20 s later.
3. The log has **at most 5 `[jiti] [transpile]` events** (native today: 1; default loader: 480).
4. **Peak RSS (VmHWM) is ≤ 600 MB** (native: 386–478; default loader: ≥ 934 even when capped at
   704).

Checks 3 and 4 make this a test of native loading, not just of booting (Rev 2, F1). The default
loader boots at 704 MB, so "boots under 768" alone would pass exactly the image this gate exists to
stop. The script is ~40 lines and is the DevAgents tool behind every number in this plan.

It is called from `/opt/openclaw-ops/scripts/build-and-push.sh` between `docker build` and
`docker push`, so a failing image is never pushed or registered and can never be rolled. Every
image passes through that script. Since `STATUS.md` (Deploy Rules), prod image rolls are the owner's
per-Agent dashboard **Upgrade** (not `deploy.sh`), so this is the one gate all paths share. The hook
is installed in rollout step 6, once the script is on `main`, because the hook runs it from the
main checkout.

The gate protects against a future image that stops loading the SDK natively. That image would
fall back to transpiling, need ~700 MB at boot, and crash-loop under 768 on every Agent the owner
upgrades: B3 again, one click at a time. `build-and-push.sh` is host-only (not in git). That gap
predates this plan and goes on the bug list. The edit keeps a `.bak` and is recorded in `STATUS.md`
"Hosts, by hand".

## 4. Invariants

- **I1** Every gateway boots under its caps with native loading on. Per image: the boot gate. Per
  Agent: `docker exec <c> node --max-old-space-size=256 dist/index.js health` exits 0. That is the
  gateway's own authenticated WebSocket RPC, using the container's own token, so no secret leaves
  the container (Rev 3, F5). Also: HTTP 200 on its port, `RestartCount` unchanged, and no
  `heap out of memory` or OOM kill (`State.OOMKilled`) in its log or state.
- **I2** No Agent loses a plugin, tool or channel. Its boot log before and after the change shows
  the same plugin registrations, `[mcp-bridge] Registered tool` count, channel `starting provider`
  lines and skill warnings.
- **I3** `life`'s per-user memory scoping still applies. Its `life-memory-scope` and
  `life-access-scope` registrations appear after the change exactly as before. The graphiti proxy
  already fails closed without the injected `group_id` (INFRASTRUCTURE §8.1), so a scoping loss
  would show as failed memory calls, not leaked ones. Verify that the first real memory call after
  the change succeeds.
- **I4** Only the gateway process gets the flag (§3.2).
- **I5** The change merges only after every running Agent already runs it (§5; Rev 2, F3). A merge
  reaches hosts uncontrolled: the dashboard deploy route runs `git pull --rebase origin main` in
  `/opt/openclaw` before recreating. Until the merge, every dashboard path recreates from the host's
  unchanged `/opt/openclaw/docker-compose.yml`: per-Agent Upgrade, platform upgrade, verify-model,
  Secrets save (all `up -d --force-recreate`) and deploy. So those paths can revert an Agent to
  today's config, never advance one.
- **I6** This rollout writes no `docker.env`.

## 5. Rollout

**Owner exception (Rev 2, F2).** AGENTS.md routes prod rolls through the per-Agent dashboard
Upgrade, and allows a direct `docker compose up` only when the user explicitly asks. Approving this
plan is that ask, for this rollout only. Upgrade does not fit here: it changes the image and
recreates from the host's current compose, so it cannot apply a compose change that is not on
`main`, and putting it on `main` first is F3. Upgrade's safeguards, matched:

| Upgrade                                 | This rollout                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| per-Agent deploy lock                   | one Agent at a time. The owner pauses dashboard actions on Agents (Upgrade, deploy, Secrets save, verify-model) on both hosts for the window. A missed pause can only revert an Agent, which the step 6 sweep catches.                                                                                                                            |
| health check: WS connect to the gateway | the gateway's own authenticated WS RPC (`node dist/index.js health` in the container exits 0; Rev 3, F5); HTTP 200 on the gateway port; still up 60 s later with `RestartCount` unchanged and not `OOMKilled`; VmHWM < 600 MB; no `heap out of memory` or error lines; plugin, tool and channel lines equal to the saved pre-change baseline (I2) |
| on failure: revert docker.env, recreate | on failure: stop the rollout and recreate that Agent from `/opt/openclaw/docker-compose.yml` (unchanged)                                                                                                                                                                                                                                          |

1. **Implementation PR**: the compose diff, the boot gate, and their tests. It is Codex-reviewed
   and **not merged** until step 6.
2. **Stage the compose.** Copy the PR's `docker-compose.yml` to
   `/opt/openclaw-ob14/docker-compose.yml` on each host. It has no relative paths (verified), so it
   resolves exactly as `/opt/openclaw` does. Per Agent:
   `docker compose -p <a> --env-file /root/.openclaw/agents/<a>/docker.env -f /opt/openclaw-ob14/docker-compose.yml up -d openclaw-gateway`.
   The image does not change, and `docker.env` is not touched. Keep out of minute :16–:17 (the
   hourly watchdog `docker start`s any exited gateway). On US, wait for load < 2 before the next
   one.
3. **Canary `testingbot`** (EU, Node 24). The gates above, plus public-chat `smoke-ok`, and one hour
   clean.
4. **Cohort**, 24 h: `cashtronics` (EU), `support` and `vcode1bot` (US). These internal Agents cover
   Node 22, Telegram and mcp-bridge servers (filesystem, brave, github).
5. **Roll the rest** one at a time, EU then US, and stop at the first failure. Last, each verified on
   its own: `life` (I3), `projectmanager` and `calendar-demo-pkpiii` (the Google Calendar review
   Agents).
6. **Merge**, then run `git -C /opt/openclaw pull --ff-only` on both hosts. EU gains 2 ops-only
   commits; US gains 25, including the merged compose env additions #160/#161/#168, which are empty
   for these Agents. Never `stash -u` (OB-43).
   **Sweep:** every running gateway's `Config.Cmd` must carry the flag and its `Config.Env`
   `JITI_TRY_NATIVE=1`. Recreate any straggler from `/opt/openclaw` with the same gates.
   Then install the boot gate in `build-and-push.sh`, delete `/opt/openclaw-ob14` and end the pause.
7. **Stopped gateways** (`researcher` EU, `social-bob` US) stay stopped and pick up the change at
   their next deploy.

US Agents created before #160/#161/#168 also gain those empty env entries when they are recreated,
which is what any dashboard deploy would do.

**Rollback.** Before step 6: recreate the Agent from `/opt/openclaw/docker-compose.yml`. After step
6, for one Agent: set `OPENCLAW_JITI_TRY_NATIVE=0` or raise `OPENCLAW_MAX_OLD_SPACE_MB` through the
dashboard Secrets tab, which is a fenced write and recreates the gateway itself. For the whole
fleet: revert the PR, `pull --ff-only`, and recreate.

**Early check, day 3 (Rev 3, F4).** For each gateway, look at RSS+swap and its trend. The heap cap
allows ~1.0–1.1 GB RSS. If a gateway passes ~1.2 GB, or keeps growing at today's ~30 MB/day once its
heap is near the cap, the growth is not heap. In that case: record it on OB-14 and measure with a
diagnostic report (`--report-on-signal`, `--report-exclude-env`) on that one Agent. The `mem_limit`
backstop holds until then.

**Done when**, 7 days after step 5: no `FatalProcessOutOfMemory` anywhere; no unplanned restarts
(the daily diagnostic's restart-delta already reports them); boot peaks < 600 MB; host swap flat
(< +0.1 GiB/day/host, against +0.3 today). Record the result on OB-14 and OB-9.

## 6. Tests

- **T1** Compose shape, as plain text checks on `docker-compose.yml` (no docker needed). The
  gateway `command` carries `--max-old-space-size=${OPENCLAW_MAX_OLD_SPACE_MB:-768}` as the argument
  right before `dist/index.js`. `JITI_TRY_NATIVE: ${OPENCLAW_JITI_TRY_NATIVE:-1}` is in the gateway
  env. The gateway has `mem_limit: ${OPENCLAW_MEM_LIMIT:-1536m}`. `openclaw-cli` has none of the
  three. Lives beside the existing `scripts/ops/test_*.py`.
- **T2** The boot gate fails closed on exactly the case it exists for (Rev 2, F1). On DevAgents it
  passes every current image with `JITI_TRY_NATIVE=1`, and fails the same image with the default
  loader at the compose cap (768). That image boots, but logs ~480 transpiles and peaks above
  900 MB. The impl PR shows both runs. CI cannot run it: it needs docker and the 8.7 GB images.

## 7. Deliberately not building

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
7. Before the merge, can any path advance an Agent to the new config outside steps 2–5? After the
   merge, does the step 6 sweep catch every Agent that a missed pause reverted?
8. Can a dashboard action racing a step 2 recreate on the same Agent leave anything half-applied,
   rather than simply old or new?
9. With `mem_limit: 1536m` and Docker's default swap allowance, can a legitimate peak be OOM-killed:
   page cache charged to the cgroup, a large tool output held in a Buffer, MCP children at boot?
   Is 1536m right for `life` (1.45 GB RSS+swap today, uncapped)?

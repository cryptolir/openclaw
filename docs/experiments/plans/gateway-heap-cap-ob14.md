---
summary: "Relieve EU (and US) swap pressure by capping each gateway's V8 old-space heap via NODE_OPTIONS — one compose env line, canary on testingbot first. Implements OB-14."
owner: "openclaw"
status: "proposed — for Codex review"
last_updated: "2026-06-30"
title: "Gateway V8 Heap Cap (NODE_OPTIONS) — OB-14"
---

# Gateway V8 Heap Cap (NODE_OPTIONS) — OB-14

## Problem

EU host (12 gateways / 7.6 GB / 4-vCPU). AUTOSCAN 2026-06-30: **swap 2313 MiB,
only 207 MiB free** (OOM risk). US similar (2505 MiB). Structural over-commit
(OB-5 / OB-9). Root cause: each Node gateway's V8 heap grows unbounded over
days — RSS balloons (250 → 800 MiB observed on long-up US gateways) — so the
kernel swaps to keep headroom, and `available` drops toward OOM.

## Fix (ponytail: one env line, free, no reboot)

Cap V8 old-space per gateway in `docker-compose.yml` (gateway service env):

```yaml
NODE_OPTIONS: --max-old-space-size=512
```

V8 then GCs before the heap balloons, bounding RSS (~512 MB heap + overhead
instead of 800), so less gets swapped. `512` is a **calibration knob**, not a
law — steady old-space is ~300 MB (RSS 248–440 MB), so 512 leaves headroom while
still capping runaway growth. Too low → V8 aborts on a legit large context; tune
from the canary.

**Why not `mem_limit`:** the B3 attempt (`mem_limit: 1g`, a cgroup hard cap)
OOM-killed the whole EU fleet at boot — V8 is unaware of the cgroup and reserves
> 1 GB during boot, so the kernel killed it. `NODE_OPTIONS=--max-old-space-size`
is the **V8-aware soft cap** (GC first, abort only if truly stuck). OB-14 already
prescribes exactly this retry path.

## Rollout

1. **Canary** `testingbot` (EU, the safe smoke target): set the env, recreate,
   confirm it boots clean + `smoke-ok` + RSS stays bounded over ~1 day.
2. **Staged fleet roll** — one-at-a-time on US (staged-boot rule; recreate, not
   `mem_limit`).
3. **Rollback** = delete the env line, recreate. Non-destructive.

## Immediate stopgap (separate, do now if EU is OOM-thin)

One-at-a-time `docker restart` of the longest-up EU gateways frees each one's
RAM **and** releases its swap (OB-9 technique; ~30s blip each) — buys headroom
until the cap lands. **Not** `swapoff` (swapped > available → would OOM).

## Escape hatch

If the cap proves insufficient (agents legitimately need > cap, or swap still
climbs fleet-wide), the non-lazy fix is a **RAM rescale** (CPX41, 16 GB) —
owner decision, costs money + a reboot.

## Open questions (Codex)

1. Cap value: `512` vs `384`? (lower = more relief, higher abort risk).
2. Fleet-wide vs EU-only first?
3. Bundle the immediate restart-drain into this change, or keep it as a manual stopgap?

Resolves **OB-14**; relieves **OB-5 / OB-9**. ponytail: skipped per-agent caps
and a config knob in the dashboard — add only if one global value can't fit all
agents (canary will tell).

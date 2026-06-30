---
summary: "Relieve EU/US swap pressure by capping each gateway's V8 old-space heap via NODE_OPTIONS — one compose env line, canaried on testingbot then rolled EU→US. Implements OB-14."
owner: "openclaw"
status: "proposed — rev2 (Codex review + 2026-06-30 profiling folded in)"
last_updated: "2026-06-30"
title: "Gateway V8 Heap Cap (NODE_OPTIONS) — OB-14"
---

# Gateway V8 Heap Cap (NODE_OPTIONS) — OB-14

## Problem

EU host (12 gateways / 7.6 GB / 4-vCPU). AUTOSCAN 2026-06-30: swap ~2.3 GB, only
~160 MiB free (OOM risk). US similar (~2.5 GB swap). Structural over-commit
(OB-5 / OB-9).

## What's actually growing (profiled 2026-06-30)

Measured RSS across the fleet:

- **Activity-driven, not time-driven.** Idle agents sit at ~29 MiB after 8 days
  (thebook, familyorganizer); busy ones run 480–950 MiB; `life` reached 650 MiB
  in 11 h. So it tracks *work done*, not uptime.
- **Reclaimable.** A restart drops it (vcode1bot 949 → 368 MiB). So it is
  accumulated in-memory **working state** from doing work — conversation/session
  context and caches (e.g. the venice model list the gateway keeps in memory) —
  **not** workspace files on disk, and **not** a passive V8 time-ratchet.
- Leak (unbounded) vs heavy-but-bounded working set is **unproven**: the gateway
  intercepts SIGUSR1 as its own "restart" and runs no `--inspect`, so the cheap
  `process.memoryUsage()` read isn't reachable. The cap relieves it either way; a
  proper heap profile (start one canary with `--inspect`, read `heapUsed` over a
  day) can settle leak-vs-working-set later if it matters.

## Fix (ponytail: one env line, free, reversible)

Cap V8 old-space per gateway, under `openclaw-gateway.environment` **only**:

```yaml
NODE_OPTIONS: "--max-old-space-size=512"
```

V8 then GCs/evicts before the heap balloons. Use **512**, not 384: prior data
shows steady RSS ~248–440 MiB and boot reached ~620 MiB, so 384 risks turning a
relief measure into app-level aborts.

This caps the **old-space-driven** RSS growth — **not** total RSS; external/native
buffers and child processes still add overhead. So the canary must verify
*actual* RSS/swap, not assume a hard ceiling.

**Why not `mem_limit`:** the B3 attempt (`mem_limit: 1g`, a cgroup hard cap)
OOM-killed the EU fleet at boot — V8 is unaware of the cgroup and reserves more
than 1 GB during boot, so the kernel killed it. `--max-old-space-size` is the
V8-aware soft cap (GC first, abort only if truly stuck). OB-14 prescribes exactly
this retry path.

## Rollout (explicit order — EU is closest to OOM)

1. **Canary `testingbot`** (EU smoke target): recreate, watch ~24 h against the
   acceptance criteria below.
2. **Remaining EU agents**, one-at-a-time (recreate).
3. **US agents**, one-at-a-time (staged-boot rule).

Rollback = delete the env line, recreate.

**Canary acceptance:** clean boot · `smoke-ok` · no restarts / OOM /
`FatalProcessOutOfMemory` · RSS stops accreting toward the old ~800 MiB pattern ·
host swap / free-memory trend stabilizes over ~24 h.

## Immediate stopgap (manual — NOT bundled into this change)

EU is OOM-thin now (~160 MiB free). One-at-a-time `docker restart` of the
longest-up EU gateways frees each one's RAM **and** its swap (OB-9 technique,
~30 s blip each). **Not** `swapoff` (swapped exceeds available → would OOM). Keep this
separate from the compose change so the two can be reasoned about independently.

## Escape hatch

If the cap proves insufficient (agents legitimately need more, or swap still
climbs fleet-wide), the non-lazy fix is a RAM rescale (CPX41, 16 GB) — owner
decision, costs money + a reboot.

## Open questions (Codex)

1. `512` confirmed (Codex: yes, not 384).
2. After the testingbot canary: roll all EU before touching US (plan), or EU-only
   and leave US on the manual stopgap until the canary has a full 24 h?

Resolves OB-14; relieves OB-5 / OB-9. ponytail: skipped per-agent caps and a
dashboard knob — add only if one global value can't fit every agent (the canary
will tell).

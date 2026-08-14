/**
 * Retained chat-run results — the store behind `chat.result`.
 *
 * Plan: openclaw-dashboard `docs/plans/chat-turn-timeout.md` (Rev 8), §3.8.
 *
 * Why this exists: a web-chat turn that outlives the browser's 120 s request is
 * finished by the gateway anyway, but `emitChatFinal` used to DELETE the run's
 * buffer, so the answer survived only in transcript history — which carries no
 * runId, and therefore cannot tell two overlapping callers' replies apart.
 * This store keeps a finished run addressable by its runId for a short while.
 *
 * Two properties are load-bearing and both are tested:
 *
 * 1. **Session scoping.** `runId` is `Math.random()`-derived on the dashboard
 *    side and guessable, so it is NOT the credential. Every lookup must present
 *    the run's `sessionKey`. A wrong session returns `unknown` — the SAME shape
 *    as "no such run", so the answer is not an existence oracle.
 * 2. **Bounds on insert.** Gateways run on hosts with a few hundred MB spare, so
 *    retention is capped by bytes AND count AND time, enforced when a result is
 *    stored rather than by a sweep that may never run.
 */

/** Longest reply retained in full. Past this the head is kept and `truncated` is set. */
export const MAX_RESULT_BYTES = 64 * 1024;
/** Hard ceiling for one gateway's retained results. The real memory guarantee. */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** Hard ceiling on retained entries, whichever bound trips first. */
export const MAX_ENTRIES = 100;
/** How long a finished result stays collectable. Cleanup, not the guarantee. */
export const RESULT_TTL_MS = 15 * 60 * 1000;
/**
 * How long a run may go without a delta before liveness stops being believed.
 *
 * A safety net, not a timeout: if a cleanup path is ever missed, a stale live
 * entry would otherwise report `running` for ever and the caller would poll a
 * dead run until its own deadline. Past this we answer `unknown`, which the
 * client treats as RETRYABLE — so a genuinely long, quiet run is not harmed.
 */
export const LIVE_STALE_MS = 5 * 60 * 1000;

export type ChatResultState = "running" | "final" | "error" | "unknown";

export type FinishedRun = {
  sessionKey: string;
  state: "final" | "error";
  text: string;
  errorMessage?: string;
  truncated: boolean;
  bytes: number;
  at: number;
};

export type ChatResultLookup = {
  state: ChatResultState;
  text?: string;
  errorMessage?: string;
  truncated?: boolean;
};

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Truncate to a byte budget without splitting a UTF-8 character.
 *
 * `slice` counts UTF-16 units, so a byte budget cannot be applied to it
 * directly — an emoji at the boundary would be cut in half and the retained
 * text would decode with a replacement character.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // Walk back over continuation bytes (10xxxxxx) to the LEAD of the final
  // sequence, which may be complete or cut off by the slice.
  let start = buf.length - 1;
  while (start >= 0 && (buf[start] & 0b1100_0000) === 0b1000_0000) {
    start--;
  }
  if (start < 0) {
    return "";
  }
  const lead = buf[start];
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // Keep the whole character if it fits inside the budget; otherwise drop it.
  const end = start + needed <= buf.length ? start + needed : start;
  return buf.subarray(0, end).toString("utf8");
}

export type ChatResultStore = ReturnType<typeof createChatResultStore>;

export function createChatResultStore(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  /** Runs currently producing output: runId → its session and last-seen time. */
  const live = new Map<string, { sessionKey: string; at: number }>();
  /** Finished runs, insertion-ordered (Map preserves it) so eviction is oldest-first. */
  const finished = new Map<string, FinishedRun>();
  let totalBytes = 0;

  const forget = (runId: string) => {
    const prev = finished.get(runId);
    if (prev) {
      totalBytes -= prev.bytes;
      finished.delete(runId);
    }
  };

  /** Enforce every bound at insert time. A sweep that never runs guarantees nothing. */
  const enforceBounds = () => {
    for (const [runId, entry] of finished) {
      if (finished.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) {
        break;
      }
      totalBytes -= entry.bytes;
      finished.delete(runId);
    }
  };

  return {
    /** A run produced output. Called on every delta; cheap and idempotent. */
    markLive(runId: string, sessionKey: string): void {
      live.set(runId, { sessionKey, at: now() });
    },

    /**
     * A run ended. Moves it out of `live` and retains it, bounded.
     *
     * Re-dispatch of the same runId overwrites, never merges: the plan gives each
     * fallback attempt its own runId, but an overwrite here is still the safe
     * reading of "this id's result is now that one".
     */
    finish(
      runId: string,
      entry: { sessionKey: string; state: "final" | "error"; text: string; errorMessage?: string },
    ): void {
      live.delete(runId);
      forget(runId);
      const full = entry.text ?? "";
      const kept = truncateToBytes(full, MAX_RESULT_BYTES);
      const bytes = byteLength(kept);
      finished.set(runId, {
        sessionKey: entry.sessionKey,
        state: entry.state,
        text: kept,
        errorMessage: entry.errorMessage,
        truncated: kept.length !== full.length,
        bytes,
        at: now(),
      });
      totalBytes += bytes;
      enforceBounds();
    },

    /** Forget a run entirely — abort, or maintenance cleanup. */
    drop(runId: string): void {
      live.delete(runId);
      forget(runId);
    },

    /**
     * Answer `chat.result`.
     *
     * ⚠️ Every miss — no such run, wrong session, expired — returns the SAME
     * `unknown`. Distinguishing them would turn this into an existence oracle
     * for a guessable runId.
     */
    lookup(runId: string, sessionKey: string): ChatResultLookup {
      const t = now();

      const done = finished.get(runId);
      if (done) {
        if (t - done.at > RESULT_TTL_MS) {
          forget(runId);
        } else if (done.sessionKey === sessionKey) {
          return {
            state: done.state,
            text: done.text,
            errorMessage: done.errorMessage,
            truncated: done.truncated,
          };
        } else {
          return { state: "unknown" };
        }
      }

      const active = live.get(runId);
      if (active && active.sessionKey === sessionKey && t - active.at <= LIVE_STALE_MS) {
        return { state: "running" };
      }

      return { state: "unknown" };
    },

    /** Test/diagnostic surface only. */
    stats() {
      return { live: live.size, finished: finished.size, totalBytes };
    },
    clear() {
      live.clear();
      finished.clear();
      totalBytes = 0;
    },
  };
}

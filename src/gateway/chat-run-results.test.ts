import { describe, expect, it } from "vitest";
import {
  LIVE_STALE_MS,
  MAX_ENTRIES,
  MAX_ERROR_BYTES,
  MAX_LIVE_ENTRIES,
  MAX_RESULT_BYTES,
  MAX_TOTAL_BYTES,
  RESULT_TTL_MS,
  createChatResultStore,
} from "./chat-run-results.js";

/** A clock we control; every bound here is time- or size-dependent. */
function clockStore() {
  let t = 1_000_000;
  const store = createChatResultStore({ now: () => t });
  return { store, tick: (ms: number) => (t += ms) };
}

describe("chat.result — session scoping (T9)", () => {
  it("C12: the right runId with the WRONG sessionKey is `unknown`, finished", () => {
    // runId is Math.random()-derived on the caller's side and guessable, so the
    // sessionKey is the actual check. This is the whole security property.
    const { store } = clockStore();
    store.finish("run-1", { sessionKey: "app:havaya:u1", state: "final", text: "the answer" });

    expect(store.lookup("run-1", "app:havaya:u1").state).toBe("final");
    expect(store.lookup("run-1", "app:havaya:u2")).toEqual({ state: "unknown" });
    expect(store.lookup("run-1", "main")).toEqual({ state: "unknown" });
  });

  it("C12: the right runId with the WRONG sessionKey is `unknown` while STILL RUNNING", () => {
    // The active path is a separate map and was the leak Codex round 4 found:
    // liveness derived from a session-less map answers for another session's run.
    const { store } = clockStore();
    store.markLive("run-2", "app:havaya:u1");

    expect(store.lookup("run-2", "app:havaya:u1").state).toBe("running");
    expect(store.lookup("run-2", "app:plusim:u9")).toEqual({ state: "unknown" });
  });

  it("a wrong session is INDISTINGUISHABLE from a missing run (no oracle)", () => {
    const { store } = clockStore();
    store.finish("real", { sessionKey: "s1", state: "final", text: "x" });
    store.markLive("live", "s1");

    const absent = store.lookup("never-existed", "other");
    expect(store.lookup("real", "other")).toEqual(absent);
    expect(store.lookup("live", "other")).toEqual(absent);
  });
});

describe("chat.result — the tri-state (C18)", () => {
  it("running → final: a live run is NOT reported as a miss", () => {
    // Codex round 3, finding 5: collapsing `running` into "not found" makes the
    // FIRST poll after hand-off look identical to a permanent miss, and the
    // client would stop before the answer ever arrives.
    const { store } = clockStore();
    store.markLive("r", "s");
    expect(store.lookup("r", "s").state).toBe("running");

    store.finish("r", { sessionKey: "s", state: "final", text: "done" });
    expect(store.lookup("r", "s")).toEqual({
      state: "final",
      text: "done",
      errorMessage: undefined,
      truncated: false,
    });
  });

  it("a retained error is terminal and carries its message (C17)", () => {
    const { store } = clockStore();
    store.finish("r", {
      sessionKey: "s",
      state: "error",
      text: "",
      errorMessage: "model refused",
    });
    const got = store.lookup("r", "s");
    expect(got.state).toBe("error");
    expect(got.errorMessage).toBe("model refused");
  });

  it("an unknown run is `unknown`, never an error", () => {
    const { store } = clockStore();
    expect(store.lookup("nope", "s")).toEqual({ state: "unknown" });
  });

  it("finishing clears the live entry, so a completed run never reports running", () => {
    const { store } = clockStore();
    store.markLive("r", "s");
    store.finish("r", { sessionKey: "s", state: "final", text: "ok" });
    expect(store.stats().live).toBe(0);
    expect(store.lookup("r", "s").state).toBe("final");
  });
});

describe("chat.result — bounds enforced on insert (T10/C14)", () => {
  it("C14: the entry cap holds and evicts oldest first", () => {
    const { store } = clockStore();
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      store.finish(`r${i}`, { sessionKey: "s", state: "final", text: `t${i}` });
    }
    expect(store.stats().finished).toBe(MAX_ENTRIES);
    expect(store.lookup("r0", "s").state).toBe("unknown");
    expect(store.lookup(`r${MAX_ENTRIES + 9}`, "s").state).toBe("final");
  });

  it("C14: an oversized reply is truncated, flagged, and never exceeds the cap", () => {
    const { store } = clockStore();
    const huge = "a".repeat(MAX_RESULT_BYTES * 3);
    store.finish("big", { sessionKey: "s", state: "final", text: huge });

    const got = store.lookup("big", "s");
    // Truncation must be surfaced, not silent.
    expect(got.truncated).toBe(true);
    expect(Buffer.byteLength(got.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    // totalBytes also carries the sessionKey and the runId (round 1, finding 3),
    // so the ceiling for one entry is the text cap plus those identifiers.
    expect(store.stats().totalBytes).toBeLessThanOrEqual(
      MAX_RESULT_BYTES + Buffer.byteLength("s", "utf8") + Buffer.byteLength("big", "utf8"),
    );
  });

  it("C14: the TOTAL byte ceiling holds even below the entry cap", () => {
    // The count cap alone is not a memory bound — that was the Rev 6 mistake:
    // "100 x 32 KB" assumed a reply size nothing enforced.
    const { store } = clockStore();
    const big = "b".repeat(MAX_RESULT_BYTES);
    for (let i = 0; i < 80; i++) {
      store.finish(`r${i}`, { sessionKey: "s", state: "final", text: big });
    }
    expect(store.stats().totalBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(store.stats().finished).toBeLessThan(80);
  });

  it("truncation never splits a UTF-8 character", () => {
    const { store } = clockStore();
    const emoji = "😀".repeat(MAX_RESULT_BYTES);
    store.finish("e", { sessionKey: "s", state: "final", text: emoji });
    const got = store.lookup("e", "s");
    expect(got.text ?? "").not.toContain("�");
    expect(Buffer.byteLength(got.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it("re-finishing the same runId does not double-count bytes", () => {
    const { store } = clockStore();
    store.finish("r", { sessionKey: "s", state: "final", text: "x".repeat(1000) });
    const first = store.stats().totalBytes;
    store.finish("r", { sessionKey: "s", state: "final", text: "y".repeat(1000) });
    expect(store.stats().totalBytes).toBe(first);
    expect(store.stats().finished).toBe(1);
  });
});

describe("chat.result — time bounds", () => {
  it("a result past its TTL is `unknown` and its bytes are released", () => {
    const { store, tick } = clockStore();
    store.finish("r", { sessionKey: "s", state: "final", text: "hello" });
    tick(RESULT_TTL_MS - 1);
    expect(store.lookup("r", "s").state).toBe("final");
    tick(2);
    expect(store.lookup("r", "s").state).toBe("unknown");
    expect(store.stats().totalBytes).toBe(0);
  });

  it("a stale live entry degrades to `unknown`, not a permanent `running`", () => {
    // Safety net: if a cleanup path is ever missed, the caller must not poll a
    // dead run for ever. `unknown` is retryable, so a long quiet run is fine.
    const { store, tick } = clockStore();
    store.markLive("r", "s");
    tick(LIVE_STALE_MS + 1);
    expect(store.lookup("r", "s").state).toBe("unknown");
  });

  it("a live run that keeps emitting stays running", () => {
    const { store, tick } = clockStore();
    store.markLive("r", "s");
    for (let i = 0; i < 5; i++) {
      tick(LIVE_STALE_MS - 1000);
      store.markLive("r", "s");
      expect(store.lookup("r", "s").state).toBe("running");
    }
  });
});

describe("chat.result — drop", () => {
  it("drop removes a run from both live and finished", () => {
    const { store } = clockStore();
    store.markLive("a", "s");
    store.finish("b", { sessionKey: "s", state: "final", text: "x" });

    store.drop("a");
    store.drop("b");

    expect(store.lookup("a", "s")).toEqual({ state: "unknown" });
    expect(store.lookup("b", "s")).toEqual({ state: "unknown" });
    expect(store.stats().totalBytes).toBe(0);
  });
});

describe("chat.result — every retained string is accounted (round 1, finding 3)", () => {
  it("the error message, sessionKey and runId all count toward the ceiling", () => {
    // The first draft counted only the reply text, so a hundred entries with
    // large errors or large ids could blow past MAX_TOTAL_BYTES while
    // totalBytes stayed small — the bound was advisory, not real.
    const { store } = clockStore();
    const plain = clockStore();

    store.finish("r".repeat(500), {
      sessionKey: "s".repeat(500),
      state: "error",
      text: "",
      errorMessage: "e".repeat(500),
    });
    plain.store.finish("r", { sessionKey: "s", state: "error", text: "", errorMessage: "e" });

    expect(store.stats().totalBytes).toBeGreaterThan(plain.store.stats().totalBytes + 1000);
  });

  it("an oversized error message is truncated, not retained whole", () => {
    const { store } = clockStore();
    store.finish("r", {
      sessionKey: "s",
      state: "error",
      text: "",
      errorMessage: "x".repeat(MAX_ERROR_BYTES * 4),
    });
    const got = store.lookup("r", "s");
    expect(Buffer.byteLength(got.errorMessage ?? "", "utf8")).toBeLessThanOrEqual(MAX_ERROR_BYTES);
  });
});

describe("chat.result — live entries are pruned, not just hidden (round 1, finding 4)", () => {
  it("a stale live entry is DELETED on lookup", () => {
    // Hiding it behind a staleness check still leaked the runId and sessionKey
    // for the gateway's lifetime — in exactly the missed-cleanup case the check
    // was added for.
    const { store, tick } = clockStore();
    store.markLive("r", "s");
    expect(store.stats().live).toBe(1);

    tick(LIVE_STALE_MS + 1);
    expect(store.lookup("r", "s").state).toBe("unknown");
    expect(store.stats().live).toBe(0);
  });

  it("the live map is capped even when nothing is ever cleaned up", () => {
    const { store } = clockStore();
    for (let i = 0; i < MAX_LIVE_ENTRIES + 250; i++) {
      store.markLive(`run-${i}`, "s");
    }
    expect(store.stats().live).toBeLessThanOrEqual(MAX_LIVE_ENTRIES);
  });

  it("capping evicts the oldest and keeps the newest run alive", () => {
    const { store } = clockStore();
    for (let i = 0; i < MAX_LIVE_ENTRIES + 10; i++) {
      store.markLive(`run-${i}`, "s");
    }
    expect(store.lookup("run-0", "s").state).toBe("unknown");
    expect(store.lookup(`run-${MAX_LIVE_ENTRIES + 9}`, "s").state).toBe("running");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// F6 / T17a (dashboard plan public-chat-app-identity §3.4.2): identity in
// server state is only as authorized as the key it sits on (I8). A session
// entry poisoned with a victim's appUserId on a NON-app key — mintable during
// the pre-gate exposure window — must never resolve.

const loadSessionEntry = vi.fn();
vi.mock("../gateway/session-utils.js", () => ({
  loadSessionEntry: (key: string) => loadSessionEntry(key),
}));

const { resolveAppUserId, isAppUserSession } = await import("./app-user-workspace.ts");

const POISONED = { entry: { appUserId: "user_victim" } };

beforeEach(() => {
  loadSessionEntry.mockReset();
  loadSessionEntry.mockReturnValue(POISONED);
});

describe("resolveAppUserId — F6 read-side refusal (T17a)", () => {
  it("refuses a persisted appUserId on an anon: key — and never reads the store", () => {
    expect(resolveAppUserId("anon:life:x")).toBeNull();
    expect(loadSessionEntry).not.toHaveBeenCalled();
  });

  it("refuses on other non-app shapes (member/telegram/webchat/cron)", () => {
    for (const key of [
      "member:someone@example.com:t1",
      "agent:life:telegram:12345",
      "webchat:abc",
      "cron:daily",
    ]) {
      expect(resolveAppUserId(key), key).toBeNull();
    }
    expect(loadSessionEntry).not.toHaveBeenCalled();
  });

  it("still honours a persisted appUserId on an app-scoped key", () => {
    expect(resolveAppUserId("agent:main:app:havaya:user_victim:c1")).toBe("user_victim");
    expect(loadSessionEntry).toHaveBeenCalledTimes(1);
  });

  it("write-side and read-side share ONE predicate (isAppUserSession)", () => {
    // chat.ts's persist refusal uses the same function — pin its truth table so
    // the two sides cannot drift apart.
    expect(isAppUserSession("anon:life:x")).toBe(false);
    expect(isAppUserSession("member:a@b.c:t")).toBe(false);
    expect(isAppUserSession("app:havaya:u:c")).toBe(true);
    expect(isAppUserSession("agent:main:app:havaya:u:c")).toBe(true);
    expect(isAppUserSession(undefined)).toBe(false);
  });

  it("Codex #105 P1: canonical grammar — the app marker must be at a fixed position", () => {
    // Real forms accepted:
    expect(isAppUserSession("app:userid:conv")).toBe(true); // bare legacy 3-part
    expect(isAppUserSession("app:havaya:userid:conv")).toBe(true); // bare namespaced
    expect(isAppUserSession("agent:main:app:userid:conv")).toBe(true); // prefixed legacy
    expect(isAppUserSession("agent:life:app:havaya:userid:conv")).toBe(true); // prefixed namespaced
    // Substring impostors REJECTED — marker buried behind a channel segment or elsewhere:
    expect(isAppUserSession("agent:main:telegram:app:direct:123")).toBe(false); // the reported attack
    expect(isAppUserSession("agent:main:whatsapp:app:x:y")).toBe(false);
    expect(isAppUserSession("anon:app:x:y")).toBe(false); // app not at seg 0 or 2
    expect(isAppUserSession("member:app:x:y")).toBe(false);
    expect(isAppUserSession("app")).toBe(false); // no tail
    expect(isAppUserSession("agent:main:app")).toBe(false); // marker but no userId/conv tail
  });

  it("Codex #105 P1: the honour path rejects a poisoned entry on a substring-impostor key", () => {
    // Entry mock is POISONED with user_victim; a telegram key that merely
    // CONTAINS :app: must not resolve it now.
    expect(resolveAppUserId("agent:main:telegram:app:direct:123")).toBeNull();
    expect(loadSessionEntry).not.toHaveBeenCalled();
  });
});

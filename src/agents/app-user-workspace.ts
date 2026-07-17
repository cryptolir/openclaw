import path from "node:path";
import { loadSessionEntry } from "../gateway/session-utils.js";

/**
 * Per-user workspace isolation for app-user sessions (Option A).
 *
 * The agent runs in ONE shared per-agent workspace. To stop an app user from
 * reading the agent's IP (SOUL.md, …) or other users' files via the built-in
 * file tools, app sessions are re-rooted to a private per-user directory at
 * `<workspaceHome>/user-workspaces/<appUserId>/`. Identity is the STABLE
 * `appUserId` persisted on the session entry (NOT the per-conversation
 * sessionKey), so a user's directory is the same across all their conversations.
 *
 * The canonical per-user *file* (`save_user_section` / the dashboard reader)
 * lives at `<workspaceHome>/users/<appUserId>.md` for EVERY app user — including
 * admins, who keep the full shared workspace — so the dashboard can resolve it
 * deterministically from `(agent, userId)` regardless of the tool cwd.
 *
 * Non-app channels (telegram, owner, webchat, cron, subagent) and admins keep
 * the full shared workspace.
 */

/** Path-safe charset for the on-disk userId component (matches save_user_section). */
const SAFE_USERID = /^[A-Za-z0-9_-]+$/;

/** Sub-dir (under the agent workspace) that holds per-app-user private roots. */
export const USER_WORKSPACES_DIRNAME = "user-workspaces";

/**
 * Hard-coded admin app users who BYPASS the per-user jail and get the full agent
 * workspace (read access to all files). The admin dashboard that manages these
 * users is built separately; this is just the chat-side allowlist. Add
 * lowercased appUserIds, e.g. "user_2abc...".
 */
export const ADMIN_APP_USER_IDS: ReadonlySet<string> = new Set<string>([
  // (none yet — populate with real admin appUserIds)
]);

/**
 * A session is an app-user session iff its key matches the canonical app-key
 * grammar — the `app` marker at a FIXED position, not merely present as a
 * substring (Codex #105 P1):
 *
 *   bare:            app:[<namespace>:]<userId>:<conversationId>       (seg[0] === "app")
 *   gateway-prefixed: agent:<agentId>:app:[<namespace>:]<userId>:<conversationId>  (seg[2] === "app")
 *
 * A substring test (`/(?:^|:)app:/`) matched crafted non-app keys whose channel
 * account id happens to be "app", e.g. `agent:main:telegram:app:direct:123` —
 * which would then have identity persisted/honoured on it, reopening the
 * poisoned-state path this predicate guards. Persist (chat.send) and honour
 * (resolveAppUserId) share THIS function, so both are canonical together.
 */
export function isAppUserSession(sessionKey?: string): boolean {
  if (typeof sessionKey !== "string" || !sessionKey) {
    return false;
  }
  const seg = sessionKey.split(":");
  // Bare form needs at least app:<userId>:<conversationId>.
  if (seg[0] === "app") {
    return seg.length >= 3;
  }
  // Gateway-prefixed form: the marker must sit right after `agent:<agentId>`,
  // with a userId+conversationId tail (agent:<id>:app:<userId>:<conv> ⇒ ≥5).
  if (seg[0] === "agent" && seg[2] === "app") {
    return seg.length >= 5;
  }
  return false;
}

/** Resolve the lowercased, path-safe appUserId from the persisted session entry. */
export function resolveAppUserId(sessionKey?: string): string | null {
  if (!sessionKey) {
    return null;
  }
  // F6 read-side (dashboard plan public-chat-app-identity §3.4.2): a persisted
  // appUserId is honoured ONLY on an app-scoped key. An entry poisoned onto an
  // anon:/other key during the exposure window must not resolve — identity in
  // server state is only as authorized as the key it sits on (I8). chat.send
  // enforces the same predicate write-side; keep both on isAppUserSession.
  if (!isAppUserSession(sessionKey)) {
    return null;
  }
  try {
    const { entry } = loadSessionEntry(sessionKey);
    const raw = (entry as { appUserId?: unknown } | undefined)?.appUserId;
    if (typeof raw !== "string") {
      return null;
    }
    const id = raw.trim().toLowerCase();
    return SAFE_USERID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function isAdminAppUser(appUserId: string | null | undefined): boolean {
  return typeof appUserId === "string" && ADMIN_APP_USER_IDS.has(appUserId);
}

/** Canonical per-user-file directory — always `<workspaceHome>/users`, independent of cwd. */
export function canonicalUserFileDir(workspaceHome: string): string {
  return path.join(workspaceHome, "users");
}

export type AppWorkspaceResolution =
  | { kind: "shared" }
  | { kind: "peruser"; dir: string; appUserId: string }
  | { kind: "deny"; dir: string };

/**
 * Decide the tool workspace (cwd + file-tool root) for a session.
 *
 * - non-app session                → { shared }  (full agent workspace)
 * - app session + ADMIN appUserId  → { shared }  (full access)
 * - app session + valid appUserId  → { peruser } (jailed private dir)
 * - app session + NO appUserId     → { deny }    (throwaway empty dir — FAIL CLOSED;
 *                                                  never fall back to the shared workspace)
 *
 * `workspaceHome` is the agent's real workspace dir (the shared root). `denyKey`
 * (e.g. sessionId) keys the throwaway dir so concurrent denied sessions don't
 * share scratch space.
 */
export function resolveAppToolWorkspace(params: {
  workspaceHome: string;
  sessionKey?: string;
  denyKey?: string;
}): AppWorkspaceResolution {
  if (!isAppUserSession(params.sessionKey)) {
    return { kind: "shared" };
  }
  const appUserId = resolveAppUserId(params.sessionKey);
  if (!appUserId) {
    const safeKey = (params.denyKey ?? "session").replace(/[^A-Za-z0-9_-]/g, "_");
    return {
      kind: "deny",
      dir: path.join(params.workspaceHome, USER_WORKSPACES_DIRNAME, "_no-app-user", safeKey),
    };
  }
  if (isAdminAppUser(appUserId)) {
    return { kind: "shared" };
  }
  return {
    kind: "peruser",
    appUserId,
    dir: path.join(params.workspaceHome, USER_WORKSPACES_DIRNAME, appUserId),
  };
}

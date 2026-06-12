/**
 * life-access-scope — file/exfil capability boundary for APP-USER sessions on the `life` agent.
 *
 * STOPGAP (2026-06-12): the agent runs in ONE shared per-agent workspace, so its
 * built-in file/shell tools expose agent IP (SOUL.md, the TAL method files, …) and
 * other users' files (users/<id>.md) to any app user who asks. Until real per-user
 * workspace isolation ships, this hook denies — for APP-USER sessions only — the
 * tools that enable enumeration, shell, subagent-identity-bypass, and reads outside
 * the workspace.
 *
 * Scope: ONLY sessions whose sessionKey marks the `app` channel, i.e. it contains an
 * `:app:` segment (agent:<id>:app:<userId>:… or agent:<id>:app:havaya:<userId>:…).
 * Telegram, webchat, owner, cron and internal sessions are NOT touched.
 *
 * Mechanism: api.on("before_tool_call") (typed hook — the same path life-memory-scope
 * uses; api.registerHook would NOT fire on tool calls). Return { block:true,
 * blockReason } to deny, undefined to abstain. The gateway dispatch FAILS OPEN if a
 * handler throws, so this handler never throws and FAILS CLOSED (denies the targeted
 * tools) on any internal error.
 *
 * This is a stopgap: it does not yet confine `read`/`write`/`edit` to the user's OWN
 * files (that needs per-user path scoping — the architecture decision). It removes the
 * easy exposure (browse/enumerate/shell/subagent + out-of-workspace reads of secrets
 * like docker.env or other agents' dirs).
 */

// Tools an app user must never invoke: shell / process, enumeration, content-search,
// headless browser (can reach file://), and subagent spawn (a child session key drops
// the app identity, so the child would run unguarded). Names are matched exactly.
const BLOCKED_TOOLS = new Set([
  "exec",
  "process",
  "bash",
  "shell",
  "apply_patch",
  "find",
  "grep",
  "ls",
  "glob",
  "browser",
  "sessions_spawn",
  "subagents",
  "spawn",
]);

// Path-taking tools allowed for app users, but only inside the workspace as a RELATIVE
// path. Absolute / home / @-prefixed / parent-traversal targets are denied so an app
// user can't reach secrets (docker.env), other agents, or the host filesystem.
const PATH_TOOLS = new Set(["read", "write", "edit"]);

function isAppUserSession(sessionKey) {
  return typeof sessionKey === "string" && /(?:^|:)app:/.test(sessionKey);
}

function pathEscapesWorkspace(p) {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (!s) return false;
  if (s.startsWith("/")) return true; // absolute
  if (s.startsWith("~")) return true; // home expansion (read tool expands ~)
  if (s.startsWith("@")) return true; // read tool strips a leading @
  if (s.includes("..")) return true; // parent traversal, any segment
  if (/^[A-Za-z]:[\\/]/.test(s)) return true; // windows-absolute (defensive)
  return false;
}

function pathArg(params) {
  if (!params || typeof params !== "object") return undefined;
  return params.path ?? params.file ?? params.filename ?? params.filepath;
}

export default {
  id: "life-access-scope",
  name: "Life Access Scope",
  description:
    "Denies enumeration/shell/subagent/out-of-workspace file tools for app-user sessions (stopgap until per-user workspace isolation).",
  version: "1.0.0",

  async activate(api) {
    const logger = api.logger;
    const handler = async (event, ctx) => {
      try {
        const toolName = (event && event.toolName) || (ctx && ctx.toolName) || "";
        const sessionKey = ctx && ctx.sessionKey;
        if (!isAppUserSession(sessionKey)) return; // only app users are restricted

        if (BLOCKED_TOOLS.has(toolName)) {
          logger?.info?.(`[life-access-scope] blocked ${toolName} for app session "${sessionKey}"`);
          return { block: true, blockReason: "That action isn't available in this chat." };
        }

        if (PATH_TOOLS.has(toolName)) {
          const p = pathArg(event && event.params);
          if (pathEscapesWorkspace(p)) {
            logger?.info?.(
              `[life-access-scope] blocked ${toolName} path "${p}" for app session "${sessionKey}"`,
            );
            return { block: true, blockReason: "That file isn't part of your space." };
          }
        }
        return; // allow
      } catch (err) {
        // FAIL CLOSED: the dispatch fails OPEN on a thrown handler, so never throw.
        // On internal error, deny the targeted tools; abstain for everything else.
        try {
          const toolName = (event && event.toolName) || (ctx && ctx.toolName) || "";
          if (BLOCKED_TOOLS.has(toolName) || PATH_TOOLS.has(toolName)) {
            return { block: true, blockReason: "blocked (access-scope error)" };
          }
        } catch (_e) {
          /* ignore */
        }
        return;
      }
    };

    if (typeof api.on === "function") {
      api.on("before_tool_call", handler, { priority: 200 });
      logger.info(
        "[life-access-scope] before_tool_call typed hook registered via api.on (app-user file boundary)",
      );
    } else {
      api.registerHook("before_tool_call", handler, { name: "life-access-scope", priority: 200 });
      logger.warn(
        "[life-access-scope] api.on unavailable — fell back to registerHook (may NOT fire on tools)",
      );
    }
  },
};

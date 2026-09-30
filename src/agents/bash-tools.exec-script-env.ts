import fs from "node:fs";
import path from "node:path";
import { logInfo } from "../logger.js";
import { OUTREACH_IDENTITY_VARS } from "./bash-tools.exec-runtime.js";
import { parseFrontmatter, resolveOpenClawMetadata } from "./skills/frontmatter.js";

/**
 * tools.exec.scriptEnv (openclaw-dashboard docs/plans/active/exec-secret-keys.md §2.3, I43): an
 * allowlisted script's environment. "declared" keeps only these names and its skill's keys.
 */
export const ALWAYS_PASSED_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "NODE_ENV",
  "OPENCLAW_SESSION_KEY",
  ...OUTREACH_IDENTITY_VARS,
];

/** The keys the skill a script belongs to declares: requires.env, primaryEnv and env. */
export function declaredEnvForScript(resolvedPath: string | undefined): string[] {
  if (!resolvedPath) {
    return [];
  }
  let dir = path.dirname(resolvedPath);
  // ponytail: a fixed walk up to the skill folder; skills nest scripts at most a few levels down.
  for (let i = 0; i < 4; i += 1) {
    const skillMd = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      const meta = resolveOpenClawMetadata(parseFrontmatter(fs.readFileSync(skillMd, "utf8")));
      return [
        ...(meta?.requires?.env ?? []),
        ...(meta?.primaryEnv ? [meta.primaryEnv] : []),
        ...(meta?.env ?? []),
      ];
    }
    if (path.basename(dir) === "skills") {
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      break;
    }
    dir = up;
  }
  return [];
}

export function applyScriptEnv(params: {
  env: Record<string, string>;
  mode: "all" | "report" | "declared" | undefined;
  resolvedPaths: Array<string | undefined>;
}): string[] {
  if (!params.mode || params.mode === "all") {
    return [];
  }
  const keep = new Set<string>(ALWAYS_PASSED_ENV);
  for (const p of params.resolvedPaths) {
    for (const key of declaredEnvForScript(p)) {
      keep.add(key);
    }
  }
  const dropped = Object.keys(params.env).filter(
    (key) => !keep.has(key.toUpperCase()) && !keep.has(key),
  );
  const scripts = params.resolvedPaths.map((p) => (p ? path.basename(p) : "?")).join(",");
  if (params.mode === "declared") {
    for (const key of dropped) {
      delete params.env[key];
    }
  } else {
    // Names only, never values.
    logInfo(
      `exec scriptEnv report: ${scripts} would lose ${dropped.length} keys: ${dropped.toSorted().join(",")}`,
    );
  }
  return dropped;
}

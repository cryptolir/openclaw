import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OUTREACH_IDENTITY_VARS,
  stripOutreachIdentity,
  withOutreachIdentity,
} from "./bash-tools.exec-runtime.js";

// Dashboard plan docs/plans/active/ceyo-outreach-phase2.md §6 T16 (override half) and T26.
const FABRICATED = {
  OPENCLAW_SESSION_KEY: "agent:x:cron:JOB1:run:9",
  OUTREACH_CRON_JOB: "JOB1",
  OUTREACH_ROLE: "verifier",
  PATH: "/model/path",
  FOO: "bar",
};

describe("outreach session identity (C10/C17)", () => {
  const saved = { job: process.env.OUTREACH_CRON_JOB, role: process.env.OUTREACH_ROLE };
  afterEach(() => {
    if (saved.job === undefined) {
      delete process.env.OUTREACH_CRON_JOB;
    } else {
      process.env.OUTREACH_CRON_JOB = saved.job;
    }
    if (saved.role === undefined) {
      delete process.env.OUTREACH_ROLE;
    } else {
      process.env.OUTREACH_ROLE = saved.role;
    }
  });

  it("strips exactly the three names from a model-controlled env, in any case, and nothing else", () => {
    const out = stripOutreachIdentity({
      ...FABRICATED,
      outreach_role: "x",
      Openclaw_Session_Key: "y",
    });
    expect(Object.keys(out).toSorted()).toEqual(["FOO", "PATH"]);
    expect(OUTREACH_IDENTITY_VARS).toEqual([
      "OPENCLAW_SESSION_KEY",
      "OUTREACH_CRON_JOB",
      "OUTREACH_ROLE",
    ]);
  });

  it("a matching fabrication in params.env loses to the runtime's values after the merge", () => {
    process.env.OUTREACH_CRON_JOB = "REALJOB";
    process.env.OUTREACH_ROLE = "researcher";
    const merged = withOutreachIdentity(
      { HOME: "/h", ...stripOutreachIdentity(FABRICATED) },
      "main",
    );
    expect(merged.OPENCLAW_SESSION_KEY).toBe("main");
    expect(merged.OUTREACH_CRON_JOB).toBe("REALJOB");
    expect(merged.OUTREACH_ROLE).toBe("researcher");
    expect(merged.PATH).toBe("/model/path");
    expect(merged.FOO).toBe("bar");
    expect(merged.HOME).toBe("/h");
  });

  it("a real sweep session key passes through, and a blank Role override cannot drop id-only mode", () => {
    process.env.OUTREACH_ROLE = "researcher";
    process.env.OUTREACH_CRON_JOB = "JOB1";
    const merged = withOutreachIdentity(
      stripOutreachIdentity({ OUTREACH_ROLE: "" }),
      "agent:x:cron:JOB1:run:1",
    );
    expect(merged.OPENCLAW_SESSION_KEY).toBe("agent:x:cron:JOB1:run:1");
    expect(merged.OUTREACH_ROLE).toBe("researcher");
  });

  it("on a non-outreach agent the two OUTREACH_* values are empty strings, never undefined", () => {
    delete process.env.OUTREACH_CRON_JOB;
    delete process.env.OUTREACH_ROLE;
    const merged = withOutreachIdentity({}, undefined);
    expect(merged).toEqual({ OPENCLAW_SESSION_KEY: "", OUTREACH_CRON_JOB: "", OUTREACH_ROLE: "" });
  });

  it("is wired in at the exec merge, not only defined", () => {
    const src = readFileSync(path.join(__dirname, "bash-tools.exec.ts"), "utf8");
    expect(src).toContain("stripOutreachIdentity(params.env)");
    expect(src).toMatch(
      /withOutreachIdentity\(\s*paramsEnv \? \{ \.\.\.baseEnv, \.\.\.paramsEnv \} : baseEnv,\s*defaults\?\.sessionKey,?\s*\)/,
    );
    // the strip happens BEFORE the merge and the re-assert AFTER it — order in the source
    expect(src.indexOf("stripOutreachIdentity(params.env)")).toBeLessThan(
      src.indexOf("withOutreachIdentity("),
    );
  });
});

describe("T26 — docker-compose passes the six Phase 2 variables to both services", () => {
  it("OUTREACH_CRON_JOB and the five provider keys reach the gateway and the cli containers", () => {
    const yml = readFileSync(path.join(__dirname, "..", "..", "docker-compose.yml"), "utf8");
    const services = yml.split(/^  [a-z-]+:$/m).slice(1);
    expect(services.length).toBeGreaterThanOrEqual(2);
    for (const key of [
      "OUTREACH_CRON_JOB",
      "APOLLO_API_KEY",
      "HUNTER_API_KEY",
      "DEBOUNCE_API_KEY",
      "APIFY_TOKEN",
      "LEMLIST_API_KEY",
    ]) {
      const n = (yml.match(new RegExp(`^\\s+${key}: \\$\\{${key}:-\\}$`, "gm")) ?? []).length;
      expect(n, key).toBe(2);
    }
  });
});

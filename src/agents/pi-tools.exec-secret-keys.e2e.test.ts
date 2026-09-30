import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";

// openclaw-dashboard docs/plans/active/exec-secret-keys.md, T36-T38: an allowlisted script gets its
// arguments literally, never the model's env, and (scriptEnv=declared) only its skill's keys.

const shared = vi.hoisted(() => ({ allowlist: [] as Array<{ pattern: string }> }));
const envSnapshot = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR", "PROBE_KEY", "OTHER_SECRET"]);

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 500),
  };
});

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  getPluginToolMeta: () => undefined,
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const policy = {
    security: "allowlist",
    ask: "off",
    askFallback: "deny",
    autoAllowSkills: false,
  } as const;
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: { ...policy },
    agent: { ...policy },
    allowlist: shared.allowlist,
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: { ...policy },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

type ExecTool = {
  execute(
    callId: string,
    params: { command: string; workdir: string; env?: Record<string, string> },
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

let tmpDir = "";
let probe = "";

beforeAll(() => {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(
    os.tmpdir(),
    "openclaw-test-no-bundled-extensions",
  );
  process.env.PROBE_KEY = "probe-value";
  process.env.OTHER_SECRET = "other-value";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-keys-"));
  const skillDir = path.join(tmpDir, "skills", "probe");
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    '---\nname: probe\ndescription: "test"\nmetadata:\n  { "openclaw": { "requires": { "env": ["PROBE_KEY"] } } }\n---\n# probe\n',
  );
  probe = path.join(skillDir, "scripts", "probe.sh");
  fs.writeFileSync(
    probe,
    '#!/bin/sh\nfor a in "$@"; do printf "ARG[%s]\\n" "$a"; done\nenv | cut -d= -f1 | sort | sed "s/^/ENV:/"\nprintf "HOMEVAL[%s]\\n" "$HOME"\n',
  );
  fs.chmodSync(probe, 0o755);
  shared.allowlist.push({ pattern: probe });
});

afterAll(() => {
  envSnapshot.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function execTool(scriptEnv?: "all" | "report" | "declared"): Promise<ExecTool> {
  const { createOpenClawCodingTools } = await import("./pi-tools.js");
  const cfg: OpenClawConfig = {
    tools: {
      exec: { host: "gateway", security: "allowlist", ask: "off", safeBins: [], scriptEnv },
    },
  };
  const tools = createOpenClawCodingTools({
    config: cfg,
    sessionKey: "agent:main:main",
    workspaceDir: tmpDir,
    agentDir: path.join(tmpDir, "agent"),
  });
  const tool = tools.find((t) => t.name === "exec");
  if (!tool) {
    throw new Error("exec tool missing");
  }
  return tool as ExecTool;
}

const text = (r: { content: Array<{ text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

describe("allowlisted scripts and secret keys", () => {
  it("passes every argument literally (T36)", async () => {
    const tool = await execTool();
    const out = text(
      await tool.execute("c1", {
        command: `${probe} "$OTHER_SECRET" \${PROBE_KEY:-x} ~/x *.py {a,b} 'plain'`,
        workdir: tmpDir,
      }),
    );
    for (const want of ["$OTHER_SECRET", "${PROBE_KEY:-x}", "~/x", "*.py", "{a,b}", "plain"]) {
      expect(out).toContain(`ARG[${want}]`);
    }
    expect(out).not.toContain("other-value");
    expect(out).not.toContain("probe-value");
  });

  it("keeps chains literal in every segment (T36)", async () => {
    const tool = await execTool();
    const out = text(
      await tool.execute("c2", {
        command: `${probe} "$OTHER_SECRET" && ${probe} $HOME`,
        workdir: tmpDir,
      }),
    );
    expect(out).toContain("ARG[$OTHER_SECRET]");
    expect(out).toContain("ARG[$HOME]");
    expect(out).not.toContain("other-value");
  });

  it("ignores the model's env (T37)", async () => {
    const tool = await execTool();
    const out = text(
      await tool.execute("c3", {
        command: probe,
        workdir: tmpDir,
        env: { MODEL_SET: "1", HOME: "/evil" },
      }),
    );
    expect(out).not.toContain("ENV:MODEL_SET");
    expect(out).not.toContain("HOMEVAL[/evil]");
    expect(out).toContain("ignored in allowlist mode");
  });

  it("passes only the declared keys with scriptEnv=declared (T38)", async () => {
    const tool = await execTool("declared");
    const out = text(await tool.execute("c4", { command: probe, workdir: tmpDir }));
    expect(out).toContain("ENV:PROBE_KEY");
    expect(out).toContain("ENV:PATH");
    expect(out).not.toContain("ENV:OTHER_SECRET");
  });

  it("keeps the whole environment with scriptEnv=report and all (T38)", async () => {
    for (const mode of ["report", "all", undefined] as const) {
      const tool = await execTool(mode);
      const out = text(await tool.execute(`c5-${mode}`, { command: probe, workdir: tmpDir }));
      expect(out).toContain("ENV:OTHER_SECRET");
    }
  });
});

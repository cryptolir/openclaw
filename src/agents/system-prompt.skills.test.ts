import type { Skill } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildAppSkillsPrompt } from "./skills.js";
import { buildSkillsSection } from "./system-prompt.js";

const SKILLS_PROMPT =
  "<available_skills>\n  <skill>\n    <name>x</name>\n  </skill>\n</available_skills>";

describe("buildSkillsSection", () => {
  it("normal session: read-by-<location> instruction, no load_skill (regression)", () => {
    const text = buildSkillsSection({
      skillsPrompt: SKILLS_PROMPT,
      isMinimal: false,
      readToolName: "read",
    }).join("\n");
    expect(text).toContain("read its SKILL.md at <location> with `read`");
    expect(text).not.toContain("load_skill");
  });

  it("app session: load_skill instruction, no read-by-<location>", () => {
    const text = buildSkillsSection({
      skillsPrompt: SKILLS_PROMPT,
      isMinimal: false,
      readToolName: "read",
      appSkillLoad: true,
    }).join("\n");
    expect(text).toContain("load it with `load_skill`");
    expect(text).not.toContain("read its SKILL.md at <location>");
  });

  it("minimal (subagent) session: no skills section either way", () => {
    expect(
      buildSkillsSection({ skillsPrompt: SKILLS_PROMPT, isMinimal: true, readToolName: "read" }),
    ).toEqual([]);
    expect(
      buildSkillsSection({
        skillsPrompt: SKILLS_PROMPT,
        isMinimal: true,
        readToolName: "read",
        appSkillLoad: true,
      }),
    ).toEqual([]);
  });
});

describe("buildAppSkillsPrompt", () => {
  const sk = (name: string, description: string, filePath: string): Skill =>
    ({ name, description, filePath, baseDir: "/x" }) as unknown as Skill;

  it("lists name + description but never a <location> or host path", () => {
    const out = buildAppSkillsPrompt([
      sk("alpha", "Do alpha", "/secret/host/skills/alpha/SKILL.md"),
    ]);
    expect(out).toContain("<name>alpha</name>");
    expect(out).toContain("<description>Do alpha</description>");
    expect(out).not.toContain("<location>");
    expect(out).not.toContain("/secret/host");
  });

  it("XML-escapes names and descriptions", () => {
    const out = buildAppSkillsPrompt([sk("a&b", "x<y>z", "/p")]);
    expect(out).toContain("a&amp;b");
    expect(out).toContain("x&lt;y&gt;z");
  });

  it("returns an empty string when there are no skills", () => {
    expect(buildAppSkillsPrompt([])).toBe("");
  });
});

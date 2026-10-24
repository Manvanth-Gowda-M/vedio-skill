import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_SKILL_DIRS, installSkill, skillsRootFor, type AgentId } from "../../packages/cli/src/skill/install.ts";
import { splitFrontmatter, validateSkillDir } from "../../packages/cli/src/skill/validate.ts";
import { SKILL_SOURCE_DIR } from "../../packages/cli/src/project.ts";
import { listCommandNames } from "../../packages/cli/src/main.ts";
import { makeTempDir } from "../helpers.ts";

async function writeSkill(root: string, name: string, frontmatter: string, body = "# Skill\n"): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

describe("skill validation (Agent Skills spec)", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("the shipped creatorflow skill is valid with no warnings", async () => {
    const v = await validateSkillDir(SKILL_SOURCE_DIR);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.name).toBe("creatorflow");
    expect(v.description!.length).toBeLessThanOrEqual(1024);
    expect(v.bodyLines).toBeLessThan(500);
    expect(v.referencedFiles).toEqual(expect.arrayContaining(["references/configuration.md", "references/safety.md"]));
  });

  it("the shipped skill advertises exactly the commands the CLI registers", async () => {
    const text = await fs.readFile(path.join(SKILL_SOURCE_DIR, "SKILL.md"), "utf8");
    const table = text.split("## Implemented commands")[1]!.split("\n## ")[0]!;
    const advertised = [...table.matchAll(/`creatorflow ([a-z-]+)/g)].map((m) => m[1]);
    expect(new Set(advertised)).toEqual(new Set(listCommandNames()));
  });

  it("handles CRLF and BOM frontmatter", () => {
    expect(splitFrontmatter("\uFEFF---\r\nname: a\r\n---\r\nbody").frontmatter).toBe("name: a");
  });

  it.each([
    ["Bad-Name", "name: Bad-Name\ndescription: Use when x."],
    ["a--b", "name: a--b\ndescription: Use when x."],
    ["other", "name: mismatch\ndescription: Use when x."],
    ["nodesc", "name: nodesc"],
    ["longdesc", `name: longdesc\ndescription: ${"x".repeat(1025)}`],
    ["badmeta", "name: badmeta\ndescription: Use when x.\nmetadata:\n  version: 1"],
  ])("rejects invalid frontmatter (%s)", async (dirName, fm) => {
    const v = await validateSkillDir(await writeSkill(tmp.dir, dirName, fm));
    expect(v.ok).toBe(false);
  });

  it("rejects missing SKILL.md, missing frontmatter, broken and escaping links", async () => {
    await fs.mkdir(path.join(tmp.dir, "empty"));
    expect((await validateSkillDir(path.join(tmp.dir, "empty"))).ok).toBe(false);
    const nofm = path.join(tmp.dir, "nofm");
    await fs.mkdir(nofm);
    await fs.writeFile(path.join(nofm, "SKILL.md"), "# no frontmatter");
    expect((await validateSkillDir(nofm)).ok).toBe(false);
    const links = await writeSkill(tmp.dir, "links", "name: links\ndescription: Use when x.", "[a](references/missing.md) [b](../outside.md) [c](https://example.com)");
    const v = await validateSkillDir(links);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.message).join("\n")).toMatch(/missing\.md[\s\S]*outside/);
  });

  it("warns on non-standard keys and missing 'use when'", async () => {
    const v = await validateSkillDir(await writeSkill(tmp.dir, "warn", "name: warn\ndescription: Does things.\ntriggers: x"));
    expect(v.ok).toBe(true);
    expect(v.issues.filter((i) => i.severity === "warning")).toHaveLength(2);
  });
});

describe("skill install (agent discovery paths)", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  const expected: Record<AgentId, { project: string[]; user: string[] }> = {
    kiro: { project: [".kiro", "skills"], user: [".kiro", "skills"] },
    "claude-code": { project: [".claude", "skills"], user: [".claude", "skills"] },
    opencode: { project: [".opencode", "skills"], user: [".config", "opencode", "skills"] },
    antigravity: { project: [".agents", "skills"], user: [".gemini", "config", "skills"] },
    "antigravity-cli": { project: [".agents", "skills"], user: [".gemini", "antigravity-cli", "skills"] },
    agents: { project: [".agents", "skills"], user: [".agents", "skills"] },
  };

  it("covers every supported agent", () => {
    expect(Object.keys(AGENT_SKILL_DIRS).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.keys(expected) as AgentId[])("installs a valid copy for %s (project and user scope)", async (agent) => {
    const project = path.join(tmp.dir, "proj");
    const home = path.join(tmp.dir, "home");
    for (const scope of ["project", "user"] as const) {
      const r = await installSkill({ source: SKILL_SOURCE_DIR, agent, scope, projectDir: project, home });
      const base = scope === "project" ? project : home;
      expect(r.target).toBe(path.join(base, ...expected[agent][scope], "creatorflow"));
      expect(skillsRootFor(agent, scope, project, home)).toBe(path.dirname(r.target));
      expect(r.status).toBe("installed");
      const v = await validateSkillDir(r.target);
      expect(v.ok).toBe(true);
      expect(v.issues).toEqual([]);
    }
  });

  it("refuses to overwrite without --force, then replaces with a backup", async () => {
    const opts = { source: SKILL_SOURCE_DIR, agent: "kiro" as const, scope: "project" as const, projectDir: tmp.dir };
    const first = await installSkill(opts);
    await fs.writeFile(path.join(first.target, "local-note.md"), "user edit");
    await expect(installSkill(opts)).rejects.toMatchObject({ code: "SKILL_ALREADY_INSTALLED" });
    const second = await installSkill({ ...opts, force: true });
    expect(second.status).toBe("replaced");
    await expect(fs.readFile(path.join(`${first.target}.bak`, "local-note.md"), "utf8")).resolves.toBe("user edit");
    expect((await fs.readdir(path.dirname(first.target))).filter((f) => f.includes("staging"))).toEqual([]);
  });

  it("never touches an unrelated directory with the same name", async () => {
    const target = path.join(tmp.dir, ".kiro", "skills", "creatorflow");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "data.txt"), "not a skill");
    await expect(
      installSkill({ source: SKILL_SOURCE_DIR, agent: "kiro", scope: "project", projectDir: tmp.dir, force: true }),
    ).rejects.toMatchObject({ code: "SKILL_TARGET_CONFLICT" });
    await expect(fs.readFile(path.join(target, "data.txt"), "utf8")).resolves.toBe("not a skill");
  });

  it("dry-run reports the target without writing", async () => {
    const r = await installSkill({ source: SKILL_SOURCE_DIR, agent: "opencode", scope: "project", projectDir: tmp.dir, dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(await fs.readdir(tmp.dir)).toEqual([]);
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyDir, CreatorFlowError, ExitCode, pathExists } from "@creatorflow/core";
import { validateSkillDir } from "./validate.ts";

export type AgentId = "claude-code" | "opencode" | "kiro" | "antigravity" | "antigravity-cli" | "agents";
export type InstallScope = "project" | "user";

/**
 * Skill discovery directories per agent. Sources (checked 2026-10-22):
 * - Agent Skills spec:   https://agentskills.io/specification
 * - OpenCode:            https://opencode.ai/docs/skills/  (.opencode/, .claude/ and .agents/ skills dirs)
 * - Antigravity:         https://antigravity.google/docs/skills (.agents/skills; ~/.gemini/config/skills; CLI: ~/.gemini/antigravity-cli/skills)
 * - Kiro CLI:            built-in docs (.kiro/skills, ~/.kiro/skills)
 * - Claude Code:         .claude/skills, ~/.claude/skills (documented by Anthropic; not exercised in this environment)
 */
export const AGENT_SKILL_DIRS: Record<AgentId, { project: string; user: string; label: string }> = {
  "claude-code": { project: ".claude/skills", user: "~/.claude/skills", label: "Claude Code" },
  opencode: { project: ".opencode/skills", user: "~/.config/opencode/skills", label: "OpenCode" },
  kiro: { project: ".kiro/skills", user: "~/.kiro/skills", label: "Kiro CLI" },
  antigravity: { project: ".agents/skills", user: "~/.gemini/config/skills", label: "Antigravity App/IDE" },
  "antigravity-cli": { project: ".agents/skills", user: "~/.gemini/antigravity-cli/skills", label: "Antigravity CLI" },
  agents: { project: ".agents/skills", user: "~/.agents/skills", label: "Generic .agents (OpenCode, Antigravity)" },
};

export function isAgentId(v: string): v is AgentId {
  return Object.hasOwn(AGENT_SKILL_DIRS, v);
}

export function skillsRootFor(agent: AgentId, scope: InstallScope, projectDir: string, home = os.homedir()): string {
  const rel = AGENT_SKILL_DIRS[agent][scope];
  return rel.startsWith("~/") ? path.join(home, ...rel.slice(2).split("/")) : path.join(projectDir, ...rel.split("/"));
}

export interface InstallOptions {
  source: string;
  agent: AgentId;
  scope: InstallScope;
  projectDir: string;
  home?: string;
  /** Replace an existing, different installation. */
  force?: boolean;
  dryRun?: boolean;
}

export interface InstallResult {
  agent: AgentId;
  scope: InstallScope;
  target: string;
  status: "installed" | "replaced" | "dry-run";
  files: number;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Copies the portable skill into an agent's discovery directory. Never overwrites silently. */
export async function installSkill(o: InstallOptions): Promise<InstallResult> {
  const validation = await validateSkillDir(o.source);
  if (!validation.ok) {
    throw new CreatorFlowError("The source skill is invalid; refusing to install.", {
      code: "SKILL_INVALID",
      hint: "Run `creatorflow skill validate` and fix the errors.",
      exitCode: ExitCode.CHECK_FAILED,
      details: validation.issues,
    });
  }
  const name = validation.name!;
  const target = path.join(skillsRootFor(o.agent, o.scope, path.resolve(o.projectDir), o.home), name);
  const files = (await listFiles(o.source)).length;
  const exists = await pathExists(target);

  if (exists) {
    const existing = await validateSkillDir(target);
    if (existing.name !== name) {
      throw new CreatorFlowError(`${target} exists and is not a ${name} skill; refusing to touch it.`, {
        code: "SKILL_TARGET_CONFLICT",
        exitCode: ExitCode.IO,
      });
    }
    if (!o.force) {
      throw new CreatorFlowError(`${name} is already installed at ${target}.`, {
        code: "SKILL_ALREADY_INSTALLED",
        hint: "Rerun with --force to replace it (the previous copy is kept as a .bak directory).",
        exitCode: ExitCode.IO,
      });
    }
  }
  if (o.dryRun) return { agent: o.agent, scope: o.scope, target, status: "dry-run", files };

  // Stage into a sibling directory, then swap, so a failed copy never leaves a half-installed skill.
  const staging = `${target}.staging-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  await copyDir(o.source, staging);
  if (exists) {
    const backup = `${target}.bak`;
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rename(target, backup);
  }
  await fs.rename(staging, target);
  return { agent: o.agent, scope: o.scope, target, status: exists ? "replaced" : "installed", files };
}

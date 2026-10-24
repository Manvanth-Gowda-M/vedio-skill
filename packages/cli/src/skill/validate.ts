import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isWithin, pathExists } from "@creatorflow/core";

export interface SkillIssue {
  severity: "error" | "warning";
  message: string;
  file?: string;
}

export interface SkillValidation {
  ok: boolean;
  dir: string;
  name?: string;
  description?: string;
  bodyLines: number;
  referencedFiles: string[];
  issues: SkillIssue[];
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
/** Agent Skills guidance: keep SKILL.md under ~500 lines; move detail to references. */
const MAX_BODY_LINES = 500;

export function splitFrontmatter(text: string): { frontmatter?: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  return m ? { frontmatter: m[1]!, body: m[2]! } : { body: normalized };
}

/** Relative markdown links / inline code paths into the skill directory. */
function referencedPaths(body: string): string[] {
  const refs = new Set<string>();
  for (const m of body.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    const target = m[1]!;
    if (!/^[a-z]+:/i.test(target) && !target.startsWith("/")) refs.add(target);
  }
  return [...refs];
}

/**
 * Validates a skill directory against the Agent Skills specification
 * (https://agentskills.io/specification) plus CreatorFlow's own rules.
 */
export async function validateSkillDir(dir: string): Promise<SkillValidation> {
  const abs = path.resolve(dir);
  const issues: SkillIssue[] = [];
  const result: SkillValidation = { ok: false, dir: abs, bodyLines: 0, referencedFiles: [], issues };
  const skillFile = path.join(abs, "SKILL.md");

  if (!(await pathExists(skillFile))) {
    issues.push({ severity: "error", message: "SKILL.md not found (file name must be upper-case SKILL.md)" });
    return result;
  }
  const { frontmatter, body } = splitFrontmatter(await fs.readFile(skillFile, "utf8"));
  if (frontmatter === undefined) {
    issues.push({ severity: "error", message: "SKILL.md must start with YAML frontmatter delimited by ---", file: "SKILL.md" });
    return result;
  }

  let meta: unknown;
  try {
    meta = parseYaml(frontmatter);
  } catch (error) {
    issues.push({ severity: "error", message: `Invalid YAML frontmatter: ${(error as Error).message}`, file: "SKILL.md" });
    return result;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    issues.push({ severity: "error", message: "Frontmatter must be a YAML mapping", file: "SKILL.md" });
    return result;
  }
  const fm = meta as Record<string, unknown>;

  for (const key of Object.keys(fm)) {
    if (!ALLOWED_KEYS.has(key)) {
      issues.push({ severity: "warning", message: `Non-standard frontmatter key "${key}"; put client-specific data under metadata`, file: "SKILL.md" });
    }
  }

  const name = fm["name"];
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || !NAME_RE.test(name)) {
    issues.push({ severity: "error", message: "name must be 1-64 chars of lowercase letters, digits and single hyphens", file: "SKILL.md" });
  } else {
    result.name = name;
    if (name !== path.basename(abs)) {
      issues.push({ severity: "error", message: `name "${name}" must match the directory name "${path.basename(abs)}"`, file: "SKILL.md" });
    }
  }

  const description = fm["description"];
  if (typeof description !== "string" || description.trim().length === 0 || description.length > 1024) {
    issues.push({ severity: "error", message: "description must be a non-empty string of at most 1024 characters", file: "SKILL.md" });
  } else {
    result.description = description;
    if (!/\buse (it )?when\b/i.test(description)) {
      issues.push({ severity: "warning", message: 'description should say when to use the skill (e.g. "Use when ...")', file: "SKILL.md" });
    }
  }

  const compatibility = fm["compatibility"];
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length < 1 || compatibility.length > 500)) {
    issues.push({ severity: "error", message: "compatibility must be a string of 1-500 characters", file: "SKILL.md" });
  }

  const metadata = fm["metadata"];
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      issues.push({ severity: "error", message: "metadata must be a mapping of string keys to string values", file: "SKILL.md" });
    } else {
      for (const [k, v] of Object.entries(metadata)) {
        if (typeof v !== "string") issues.push({ severity: "error", message: `metadata.${k} must be a string (quote it)`, file: "SKILL.md" });
      }
    }
  }

  result.bodyLines = body.split("\n").length;
  if (result.bodyLines > MAX_BODY_LINES) {
    issues.push({ severity: "warning", message: `SKILL.md body has ${result.bodyLines} lines; move detail into references/`, file: "SKILL.md" });
  }

  // Every relative link must resolve to a file inside the skill directory.
  const refs = referencedPaths(body);
  result.referencedFiles = refs;
  for (const ref of refs) {
    const target = path.resolve(abs, ref);
    if (!isWithin(abs, target)) {
      issues.push({ severity: "error", message: `Link "${ref}" points outside the skill directory; installed copies would break`, file: "SKILL.md" });
    } else if (!(await pathExists(target))) {
      issues.push({ severity: "error", message: `Linked file "${ref}" does not exist`, file: "SKILL.md" });
    }
  }

  result.ok = !issues.some((i) => i.severity === "error");
  return result;
}

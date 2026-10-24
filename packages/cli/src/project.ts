import path from "node:path";
import { fileURLToPath } from "node:url";
import { CreatorFlowError, ExitCode, pathExists, readJsonFile } from "@creatorflow/core";
import {
  validateConfig,
  validateProfile,
  type CreatorFlowConfig,
  type CreatorProfile,
  type ValidationIssue,
} from "@creatorflow/schemas";

export const CONFIG_FILENAME = "creatorflow.config.json";

/** Repository root (location of skills/, packages/, docs/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SKILL_SOURCE_DIR = path.join(REPO_ROOT, "skills", "creatorflow");
export const JSON_SCHEMA_DIR = path.join(REPO_ROOT, "packages", "schemas", "json");

export interface ProjectPaths {
  dir: string;
  configFile: string;
}

export function projectPaths(dir: string): ProjectPaths {
  const abs = path.resolve(dir);
  return { dir: abs, configFile: path.join(abs, CONFIG_FILENAME) };
}

export interface LoadedDoc<T> {
  file: string;
  exists: boolean;
  /** Present only when the file exists and is valid. */
  value?: T;
  /** Raw parsed JSON when the file exists (even if invalid). */
  raw?: unknown;
  issues: ValidationIssue[];
}

async function loadDoc<T>(
  file: string,
  validate: (d: unknown) => { ok: boolean; value?: T; issues: ValidationIssue[] },
): Promise<LoadedDoc<T>> {
  if (!(await pathExists(file))) return { file, exists: false, issues: [] };
  let raw: unknown;
  try {
    raw = await readJsonFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { file, exists: true, issues: [{ path: "(file)", message }] };
  }
  const result = validate(raw);
  return result.ok
    ? { file, exists: true, raw, value: result.value as T, issues: [] }
    : { file, exists: true, raw, issues: result.issues };
}

export function loadConfigFile(file: string): Promise<LoadedDoc<CreatorFlowConfig>> {
  return loadDoc(file, validateConfig);
}

export function loadProfileFile(file: string): Promise<LoadedDoc<CreatorProfile>> {
  return loadDoc(file, validateProfile);
}

export interface LoadedProject {
  paths: ProjectPaths;
  config: LoadedDoc<CreatorFlowConfig>;
  /** Undefined when the config is missing/invalid and the profile path is unknown. */
  profile?: LoadedDoc<CreatorProfile>;
  profileFile: string;
}

/** Loads config and profile without throwing; callers decide how to report issues. */
export async function loadProject(dir: string): Promise<LoadedProject> {
  const paths = projectPaths(dir);
  const config = await loadConfigFile(paths.configFile);
  const profileRel = config.value?.profilePath ?? "creator-profile.json";
  const profileFile = path.resolve(paths.dir, profileRel);
  const profile = await loadProfileFile(profileFile);
  return { paths, config, profile, profileFile };
}

/** Loads a project and throws an actionable error if anything is missing or invalid. */
export async function requireProject(dir: string): Promise<{
  paths: ProjectPaths;
  config: CreatorFlowConfig;
  profile: CreatorProfile;
}> {
  const p = await loadProject(dir);
  for (const doc of [p.config, p.profile]) {
    if (!doc) continue;
    if (!doc.exists) {
      throw new CreatorFlowError(`Missing ${path.basename(doc.file)} in ${p.paths.dir}.`, {
        code: "PROJECT_NOT_INITIALIZED",
        hint: "Run `creatorflow init` first.",
        exitCode: ExitCode.CONFIG,
      });
    }
    if (!doc.value) {
      throw new CreatorFlowError(`${path.basename(doc.file)} is invalid.`, {
        code: "PROJECT_INVALID",
        hint: "Run `creatorflow profile validate` for details.",
        exitCode: ExitCode.CONFIG,
        details: doc.issues,
      });
    }
  }
  return { paths: p.paths, config: p.config.value!, profile: p.profile!.value! };
}

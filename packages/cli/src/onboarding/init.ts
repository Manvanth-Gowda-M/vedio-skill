import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CreatorFlowError,
  ExitCode,
  isWithin,
  pathExists,
  readJsonFile,
  resolveWithin,
  stringifyJson,
  toPosix,
  writeFileAtomic,
} from "@creatorflow/core";
import {
  IanaTimezone,
  LanguageTag,
  PlatformId,
  validateConfig,
  validateProfile,
  type CreatorFlowConfig,
  type CreatorProfile,
} from "@creatorflow/schemas";
import { CONFIG_FILENAME, JSON_SCHEMA_DIR, loadConfigFile, loadProfileFile, REPO_ROOT } from "../project.ts";
import {
  CONFIG_DEFAULTS,
  ESSENTIAL_FIELDS,
  PRESETS,
  PROFILE_DEFAULTS,
  type ConfigDraft,
  type EssentialField,
  type ProfileDraft,
} from "./defaults.ts";
import { deepMerge, getPath, isMissing, isPlainObject, setPath } from "./merge.ts";
import type { Prompter } from "./prompter.ts";

export interface InitFlags {
  name?: string;
  niche?: string;
  topics?: string;
  audience?: string;
  language?: string;
  languages?: string;
  platform?: string;
  secondaryPlatforms?: string;
  timezone?: string;
  weeklyTarget?: string;
  brandName?: string;
}

export interface InitOptions {
  dir: string;
  preset?: string;
  answersFile?: string;
  flags?: InitFlags;
  /** When false, missing essentials cause a USAGE error instead of prompting. */
  interactive: boolean;
  prompter?: Prompter;
  dryRun?: boolean;
}

export type WriteStatus = "created" | "updated" | "unchanged" | "dry-run";

export interface InitResult {
  dir: string;
  profileFile: string;
  configFile: string;
  workspaceDir: string;
  profile: { status: WriteStatus; backup?: string };
  config: { status: WriteStatus; backup?: string };
  /** Essential fields that were asked interactively. */
  asked: string[];
  /** Essential fields that came from an existing profile (preserved). */
  preserved: string[];
}

const csv = (v: string | undefined): string[] | undefined =>
  v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean);

function flagsToDraft(f: InitFlags = {}): ProfileDraft {
  const weekly = f.weeklyTarget === undefined ? undefined : Number(f.weeklyTarget);
  if (weekly !== undefined && !Number.isInteger(weekly)) {
    throw new CreatorFlowError(`--weekly-target must be an integer (got "${f.weeklyTarget}").`, {
      code: "USAGE",
      exitCode: ExitCode.USAGE,
    });
  }
  return deepMerge<ProfileDraft>({
    creator: { displayName: f.name, niche: f.niche, topics: csv(f.topics), audience: { description: f.audience } },
    languages: { primary: f.language, additional: csv(f.languages) },
    platforms: { primary: f.platform, secondary: csv(f.secondaryPlatforms) },
    schedule: { timezone: f.timezone, weeklyTarget: weekly },
    brand: { name: f.brandName },
  });
}

function parseAnswer(field: EssentialField, answer: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const value = answer.trim();
  if (!value) return { ok: false, message: "A value is required." };
  const check = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown, msg: string) =>
    schema.safeParse(v).success ? ({ ok: true, value: v } as const) : ({ ok: false, message: msg } as const);
  switch (field.kind) {
    case "list": {
      const items = csv(value) ?? [];
      return items.length ? { ok: true, value: items } : { ok: false, message: "Enter at least one item." };
    }
    case "language":
      return check(LanguageTag, value, "Not a BCP 47 language tag (e.g. en, hi, pt-BR).");
    case "platform":
      return check(PlatformId, value, `Unknown platform. Choose one of: ${PlatformId.options.join(", ")}.`);
    case "timezone":
      return check(IanaTimezone, value, "Unknown IANA time zone.");
    default:
      return { ok: true, value };
  }
}

async function readAnswersFile(file: string): Promise<{ profile: ProfileDraft; config: ConfigDraft }> {
  const raw = await readJsonFile(path.resolve(file));
  if (!isPlainObject(raw) || !(isPlainObject(raw.profile) || isPlainObject(raw.config))) {
    throw new CreatorFlowError(`Answers file ${file} must be an object with "profile" and/or "config".`, {
      code: "ANSWERS_INVALID",
      exitCode: ExitCode.USAGE,
    });
  }
  return { profile: (raw.profile ?? {}) as ProfileDraft, config: (raw.config ?? {}) as ConfigDraft };
}

/** Relative $schema pointer, only for projects inside the CreatorFlow repo (otherwise it would be a brittle ../../ path). */
function schemaRef(fromDir: string, schemaFile: string): string | undefined {
  if (!isWithin(REPO_ROOT, fromDir)) return undefined;
  return toPosix(path.relative(fromDir, path.join(JSON_SCHEMA_DIR, schemaFile)));
}

async function writeIfChanged(file: string, content: string, dryRun: boolean): Promise<{ status: WriteStatus; backup?: string }> {
  const exists = await pathExists(file);
  const previous = exists ? await fs.readFile(file, "utf8") : undefined;
  if (previous === content) return { status: "unchanged" };
  if (dryRun) return { status: "dry-run" };
  let backup: string | undefined;
  if (previous !== undefined) {
    backup = `${file}.bak`;
    await writeFileAtomic(backup, previous);
  }
  await writeFileAtomic(file, content);
  return { status: exists ? "updated" : "created", ...(backup ? { backup } : {}) };
}

function invalid(label: string, issues: { path: string; message: string }[]): CreatorFlowError {
  return new CreatorFlowError(`The resulting ${label} is invalid; nothing was written.`, {
    code: "INIT_INVALID",
    hint: "Fix the listed fields (via flags, --answers or by editing the file) and rerun init.",
    exitCode: ExitCode.CONFIG,
    details: issues,
  });
}

/**
 * Creates or updates creator-profile.json and creatorflow.config.json.
 * Precedence (low -> high): defaults, --preset, existing files, --answers, flags, prompts.
 * Existing values are preserved unless explicitly overridden.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const dir = path.resolve(options.dir);
  const configFile = path.join(dir, CONFIG_FILENAME);

  if (options.preset && !PRESETS[options.preset]) {
    throw new CreatorFlowError(`Unknown preset "${options.preset}".`, {
      code: "USAGE",
      hint: `Available presets: ${Object.keys(PRESETS).join(", ")}.`,
      exitCode: ExitCode.USAGE,
    });
  }

  const answers = options.answersFile ? await readAnswersFile(options.answersFile) : { profile: {}, config: {} };

  // ----- config -----
  const existingConfig = await loadConfigFile(configFile);
  if (existingConfig.exists && existingConfig.raw === undefined) {
    throw invalid(CONFIG_FILENAME, existingConfig.issues);
  }
  const configDraft = deepMerge<Record<string, unknown>>(CONFIG_DEFAULTS, existingConfig.raw, answers.config, {
    $schema: schemaRef(dir, "creatorflow.config.schema.json"),
  });
  const configResult = validateConfig(configDraft);
  if (!configResult.ok) throw invalid(CONFIG_FILENAME, configResult.issues);
  const config: CreatorFlowConfig = configResult.value;

  const profileFile = resolveWithin(dir, config.profilePath);
  const workspaceDir = resolveWithin(dir, config.workspaceDir);

  // ----- profile -----
  const existingProfile = await loadProfileFile(profileFile);
  if (existingProfile.exists && existingProfile.raw === undefined) {
    throw invalid(path.basename(profileFile), existingProfile.issues);
  }
  const draft = deepMerge<Record<string, unknown>>(
    PROFILE_DEFAULTS,
    options.preset ? PRESETS[options.preset] : undefined,
    existingProfile.raw,
    answers.profile,
    flagsToDraft(options.flags),
    { $schema: schemaRef(path.dirname(profileFile), "creator-profile.schema.json") },
  );

  const preserved = ESSENTIAL_FIELDS.filter((f) => !isMissing(getPath(existingProfile.raw, f.path))).map((f) => f.path);
  const missing = ESSENTIAL_FIELDS.filter((f) => isMissing(getPath(draft, f.path)));
  const asked: string[] = [];

  if (missing.length > 0) {
    if (!options.interactive || !options.prompter) {
      throw new CreatorFlowError(`Missing essential profile fields: ${missing.map((f) => f.path).join(", ")}.`, {
        code: "INIT_MISSING_FIELDS",
        hint: "Provide them with flags (see `creatorflow init --help`), an --answers file, --preset, or run init interactively.",
        exitCode: ExitCode.USAGE,
        details: missing.map((f) => ({ path: f.path, question: f.question })),
      });
    }
    for (const field of missing) {
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
        const answer = await options.prompter.ask(field.question, field.suggest?.(draft as ProfileDraft));
        const parsed = parseAnswer(field, answer);
        if (parsed.ok) {
          setPath(draft, field.path, parsed.value);
          asked.push(field.path);
          accepted = true;
        } else {
          options.prompter.warn(parsed.message);
        }
      }
      if (!accepted) {
        throw new CreatorFlowError(`No valid answer for ${field.path}.`, { code: "INIT_ABORTED", exitCode: ExitCode.USAGE });
      }
    }
  }

  const profileResult = validateProfile(draft);
  if (!profileResult.ok) throw invalid(path.basename(profileFile), profileResult.issues);
  const profile: CreatorProfile = profileResult.value;

  // ----- write -----
  const dryRun = options.dryRun ?? false;
  if (!dryRun) {
    await fs.mkdir(path.join(workspaceDir, "logs"), { recursive: true });
  }
  const configWrite = await writeIfChanged(configFile, stringifyJson(config), dryRun);
  const profileWrite = await writeIfChanged(profileFile, stringifyJson(profile), dryRun);

  return {
    dir,
    profileFile,
    configFile,
    workspaceDir,
    profile: profileWrite,
    config: configWrite,
    asked,
    preserved,
  };
}

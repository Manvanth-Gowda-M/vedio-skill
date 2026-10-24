import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "@creatorflow/core";
import type { CreatorFlowConfig, CreatorProfile, JobRecord, WeeklyPlanContentInput } from "@creatorflow/schemas";
import { runInit } from "../packages/cli/src/onboarding/init.ts";
import { requireProject } from "../packages/cli/src/project.ts";
import { workflowPaths, type WorkflowPaths } from "@creatorflow/orchestrator";
import { CONTROL_FILE, EXEC_LOG, type FixtureControl } from "./fixtures/fixture-pipeline.ts";

export const WEEK = "2026-W44";
const MONDAY = Date.UTC(2026, 9, 26);

export function makePlan(n = 3, overrides: Record<number, Record<string, unknown>> = {}, week = WEEK): WeeklyPlanContentInput {
  const categories = ["news", "explainer", "tutorial", "comparison", "experiment", "recap", "explainer"] as const;
  return {
    weekId: week,
    items: Array.from({ length: n }, (_, i) => ({
      contentId: `topic-${i + 1}`,
      publishDate: new Date(MONDAY + i * 86_400_000).toISOString().slice(0, 10),
      topic: `Fixture topic number ${i + 1}`,
      hook: `Hook ${i + 1}`,
      category: categories[i % categories.length]!,
      platform: "youtube-shorts" as const,
      language: "en",
      durationSec: 45,
      ...overrides[i],
    })),
  };
}

export interface FixtureProject {
  dir: string;
  ws: string;
  paths: WorkflowPaths;
  profile: CreatorProfile;
  config: CreatorFlowConfig;
}

/** A real project directory created through `init`, with fast retry settings for tests. */
export async function setupProject(dir: string, workflow: Record<string, unknown> = {}, profile?: Record<string, unknown>): Promise<FixtureProject> {
  const answers = path.join(dir, "answers.json");
  await writeJsonAtomic(answers, {
    profile: profile ?? {
      creator: { displayName: "Fixture", niche: "AI dev tools", topics: ["agents"], audience: { description: "Developers" } },
      languages: { primary: "en", additional: ["hi"] },
      platforms: { primary: "youtube-shorts" },
      brand: { name: "Fixture Brand" },
      schedule: { timezone: "UTC" },
    },
    config: { workflow: { maxAttempts: 3, backoffBaseMs: 10, backoffMaxMs: 40, defaultStepTimeoutMs: 15_000, ...workflow } },
  });
  await runInit({ dir, interactive: false, answersFile: answers });
  const p = await requireProject(dir);
  const ws = path.join(dir, "workspace");
  return { dir, ws, paths: workflowPaths(ws), profile: p.profile, config: p.config };
}

export async function writeControl(ws: string, control: FixtureControl): Promise<void> {
  await writeJsonAtomic(path.join(ws, CONTROL_FILE), control);
}

export interface ExecEntry {
  pid: number;
  jobId: string;
  step: string;
  attempt: number;
}

export async function execLog(ws: string): Promise<ExecEntry[]> {
  try {
    return (await fs.readFile(path.join(ws, EXEC_LOG), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ExecEntry);
  } catch {
    return [];
  }
}

export async function readJob(paths: WorkflowPaths, jobId: string): Promise<JobRecord> {
  return (await readJsonFile(paths.jobFile(jobId))) as JobRecord;
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export const exists = (p: string) => fs.stat(p).then(() => true, () => false);

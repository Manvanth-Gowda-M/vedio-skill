// Shared setup for render tests: a real project, FICTIONAL research, an approved plan.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile, runProcess, writeJsonAtomic } from "@creatorflow/core";
import { definePipeline, PlanStore, resumeWorkflow, type Pipeline } from "@creatorflow/orchestrator";
import { importIntoSession, ManualSourcesProvider, planWeek, researchPaths } from "@creatorflow/research";
import type { CreatorFlowConfig, WeeklyPlanContent } from "@creatorflow/schemas";
import { buildProductionPipeline } from "../packages/cli/src/pipeline.ts";
import { FIXTURE_WEEK, RESEARCH_PROFILE, writeResearchFixture } from "./fixtures/research-fixture.ts";
import { setupProject, type FixtureProject } from "./workflow-helpers.ts";

export const FAKE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-render-worker.ts");

/** English-only, text-led profile: no diagram/code scenes unless a test asks for them. */
export const RENDER_PROFILE = { ...RESEARCH_PROFILE, languages: { primary: "en", additional: [] }, visual: { styles: ["motion-typography"] }, schedule: { timezone: "UTC", weeklyTarget: 14 } };

export async function renderProject(dir: string, opts: { profile?: Record<string, unknown>; keep?: string[]; workflow?: Record<string, unknown>; extraCandidates?: Record<string, unknown>[] } = {}) {
  const p = await setupProject(dir, opts.workflow ?? {}, opts.profile ?? RENDER_PROFILE);
  const inDir = path.join(dir, "in");
  await writeResearchFixture(inDir, opts.extraCandidates ? { extraCandidates: opts.extraCandidates } : {});
  const r = await new ManualSourcesProvider().importLocal({ path: inDir });
  if (!r.ok) throw new Error("import");
  const session = (await importIntoSession({ paths: researchPaths(p.ws), sessionId: "main", bundle: r.value, providerId: "manual-sources" })).session;
  const keep = opts.keep ?? ["hooks-explained"];
  const plan = (edit?: (c: WeeklyPlanContent) => void) => {
    const content = planWeek({ session, profile: p.profile, config: p.config, weekId: FIXTURE_WEEK }).content!;
    content.items = content.items.filter((i) => keep.includes(i.contentId));
    edit?.(content);
    return content;
  };
  const approve = async (content: WeeklyPlanContent) => {
    const store = new PlanStore(p.paths);
    const v = await store.addVersion(content);
    await store.decide({ weekId: FIXTURE_WEEK, version: v.version, hash: v.contentHash, decision: "approved", by: "test" });
    return v;
  };
  await approve(plan());
  return { p, plan, approve };
}

export interface FakeControl {
  mode: string;
  log: string;
  pidFile: string;
}

/**
 * Production pipeline whose render worker is the SIMULATED fake worker. The QA step is declared
 * WITHOUT an executor (so jobs stop at qa with EXECUTOR_UNAVAILABLE, as before Stage H) unless `qa`
 * is given, because most fake renders are deliberately not real-looking video. QA tests pass
 * `qa: {}` (the real QA executor) together with a "qa-*" fake mode.
 */
export function fakeRenderPipeline(ctl: FakeControl, extra: { ffprobe?: null; voice?: import("@creatorflow/voice").VoiceProvider; qa?: import("@creatorflow/qa").QaOptions } = {}): Pipeline {
  const { voice, qa, ...render } = extra;
  const pipe = buildProductionPipeline({
    ...(qa ? { qa } : {}),
    render: {
      worker: (jobFile, signal) => runProcess(process.execPath, [FAKE_WORKER, jobFile], { signal, env: { ...process.env, CF_FAKE_RENDER: ctl.mode, CF_FAKE_LOG: ctl.log, CF_FAKE_PIDFILE: ctl.pidFile } }),
      ...render,
    },
    ...(voice ? { voice: { provider: () => voice } } : {}),
  });
  if (qa) return pipe;
  return definePipeline(pipe.id, pipe.steps.map((s) => (s.id === "qa" ? { ...s, execute: undefined, unavailableReason: "QA is not exercised by this simulated-renderer test" } : s)));
}

export function resumeWith(p: FixtureProject, pipeline: Pipeline, extra: Partial<Parameters<typeof resumeWorkflow>[0]> = {}, config: CreatorFlowConfig = p.config) {
  return resumeWorkflow({ paths: p.paths, pipeline, profile: p.profile, config, sleep: async () => {}, ...extra });
}

/** An explainer with two supported facts, so its second explanation becomes a technical-diagram scene. */
export const DIAGRAM_CANDIDATE = { key: "hooks-config-explained", topic: "How hook configuration files shape agent tool calls", category: "explainer", hook: "Hooks are configured, not coded.", claims: ["c-hooks", "c-changelog"] };

/** Render temp dirs owned by THIS process (other test files may render in parallel). */
export async function ownRenderTmpDirs(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return (await readdir(tmpdir())).filter((n) => n.startsWith(`cf-render-${process.pid}-`));
}

/**
 * Real Remotion renders in tests are serialised across test files (one browser at a time on
 * low-memory machines), matching the default render concurrency of 1.
 */
export async function withRealRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  const { acquireLock } = await import("@creatorflow/core");
  const { tmpdir } = await import("node:os");
  const lock = await acquireLock(path.join(tmpdir(), "creatorflow-test-real-render.lock"), { purpose: "real render test", waitMs: 600_000, pollMs: 500 });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export async function patchConfig(p: FixtureProject, edit: (c: any) => void): Promise<void> {
  const file = path.join(p.dir, "creatorflow.config.json");
  const c = await readJsonFile(file);
  edit(c);
  await writeJsonAtomic(file, c);
}

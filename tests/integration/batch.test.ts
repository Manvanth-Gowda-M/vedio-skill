import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateBatchReport, runBatch, PlanStore } from "@creatorflow/orchestrator";
import { BatchReportSchema, validateArtifact } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { fakeRenderPipeline, renderProject, type FakeControl } from "../render-helpers.ts";
import { FIXTURE_WEEK } from "../fixtures/research-fixture.ts";

const SEVEN_ITEMS = [
  "hooks-explained",
  "subagents-release",
  "changelog-recap",
  "mcp-comparison",
  "hooks-tutorial",
  "skills-explainer",
  "subagent-experiment",
];

describe("Stage I: Weekly Batch Orchestration (7 videos)", { timeout: 300_000 }, () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let ctl: FakeControl;

  beforeEach(async () => {
    tmp = await makeTempDir("cf-batch-int-");
    ctl = { mode: "qa-ok", log: path.join(tmp.dir, "fake.jsonl"), pidFile: path.join(tmp.dir, "pid") };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const pipe = () => fakeRenderPipeline(ctl, { qa: {} });

  it("coordinates seven jobs for an approved weekly plan and generates a validated batch report", async () => {
    // 1. Setup project with all 7 items kept
    const { p } = await renderProject(tmp.dir, { keep: SEVEN_ITEMS });

    // Initial batch report inspection (read-only, before execution)
    const initialReport = await generateBatchReport(p.paths, FIXTURE_WEEK);
    expect(initialReport.summary.total).toBe(7);
    expect(initialReport.summary.planned).toBe(7);
    expect(initialReport.jobs.length).toBe(7);

    for (const j of initialReport.jobs) {
      expect(j.state).toBe("PLANNED");
      expect(j.jobId).toMatch(new RegExp(`^2026-w44-[a-z0-9-]+$`));
    }

    // 2. Run batch execution up to "script" step
    const { resumeReport, batchReport } = await runBatch({
      paths: p.paths,
      pipeline: pipe(),
      profile: p.profile,
      config: p.config,
      weekId: FIXTURE_WEEK,
      stopAfter: "script",
    });

    expect(resumeReport.jobs.length).toBe(7);
    expect(batchReport.summary.total).toBe(7);
    expect(batchReport.jobs.every((j) => j.stepsCompleted.includes("script"))).toBe(true);

    // Validate generated batch-report.json on disk
    const onDiskRaw = await fs.readFile(path.join(p.paths.weekDir(FIXTURE_WEEK), "batch-report.json"), "utf8");
    const onDiskReport = validateArtifact(BatchReportSchema, JSON.parse(onDiskRaw));
    expect(onDiskReport.ok).toBe(true);
    if (!onDiskReport.ok) throw new Error("validation failed");
    expect(onDiskReport.value.summary.total).toBe(7);

    // 3. Batch resume reuses verified work
    const resume2 = await runBatch({
      paths: p.paths,
      pipeline: pipe(),
      profile: p.profile,
      config: p.config,
      weekId: FIXTURE_WEEK,
      stopAfter: "script",
    });

    // Unchanged jobs should reuse the script output
    for (const j of resume2.resumeReport.jobs) {
      expect(j.result).toBe("unchanged");
      expect(j.stepsRun).toEqual([]);
    }
  });

  it("isolates a failed job while allowing independent eligible jobs to proceed", async () => {
    // Keep 3 items to verify failure isolation fast
    const items = ["hooks-explained", "subagents-release", "changelog-recap"];
    const { p } = await renderProject(tmp.dir, { keep: items });

    // Inject a step wrapper into the pipeline that causes the second job to fail during script
    const faultyPipeline = fakeRenderPipeline(ctl);
    const originalScript = faultyPipeline.steps.find((s) => s.id === "script")!.execute!;
    const wrappedPipeline = {
      ...faultyPipeline,
      steps: faultyPipeline.steps.map((s) => {
        if (s.id !== "script") return s;
        return {
          ...s,
          execute: async (ctx: any) => {
            if (ctx.item.contentId === "subagents-release") {
              const { StepError } = await import("@creatorflow/orchestrator");
              throw new StepError("Injected failure for subagents-release", {
                kind: "permanent",
                code: "INJECTED_FAILURE",
              });
            }
            return originalScript(ctx);
          },
        };
      }),
    };

    const res = await runBatch({
      paths: p.paths,
      pipeline: wrappedPipeline,
      profile: p.profile,
      config: p.config,
      weekId: FIXTURE_WEEK,
      stopAfter: "script",
    });

    // subagents-release failed permanently, but the other two jobs succeeded!
    expect(res.batchReport.summary.total).toBe(3);
    expect(res.batchReport.summary.failed).toBe(1);

    const failedJob = res.batchReport.jobs.find((j) => j.contentId === "subagents-release")!;
    expect(failedJob.state).toBe("FAILED");
    expect(failedJob.failure?.code).toBe("INJECTED_FAILURE");

    const goodJob1 = res.batchReport.jobs.find((j) => j.contentId === "hooks-explained")!;
    expect(goodJob1.state).toBe("SCRIPTED");
    expect(goodJob1.stepsCompleted).toContain("script");

    const goodJob2 = res.batchReport.jobs.find((j) => j.contentId === "changelog-recap")!;
    expect(goodJob2.state).toBe("SCRIPTED");
    expect(goodJob2.stepsCompleted).toContain("script");
  });
});

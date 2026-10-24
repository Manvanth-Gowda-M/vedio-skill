// In-process integration tests: real files, real locks, real fixture executors.
// The process does not restart here; real cross-process recovery is covered by
// tests/e2e/workflow.test.ts. Tests that fabricate an interrupted record say so.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, readJsonFile, writeJsonAtomic } from "@creatorflow/core";
import {
  checkTransition,
  PlanStore,
  resumeWorkflow,
  runJob,
  type ResumeOptions,
} from "@creatorflow/orchestrator";
import type { JobRecord } from "@creatorflow/schemas";
import { fixturePipeline } from "../fixtures/fixture-pipeline.ts";
import { makeTempDir } from "../helpers.ts";
import { execLog, makePlan, readJob, setupProject, WEEK, writeControl, type FixtureProject } from "../workflow-helpers.ts";

const J1 = "2026-w44-topic-1";
const J2 = "2026-w44-topic-2";

async function approvePlan(p: FixtureProject, plan = makePlan(2)) {
  const store = new PlanStore(p.paths);
  const v = await store.addVersion(plan);
  await store.decide({ weekId: WEEK, version: v.version, hash: v.contentHash, decision: "approved", by: "test" });
  return v;
}

function resume(p: FixtureProject, extra: Partial<ResumeOptions> = {}) {
  return resumeWorkflow({ paths: p.paths, pipeline: fixturePipeline, profile: p.profile, config: p.config, graceMs: 200, ...extra });
}

/** Every recorded transition must be legal under the central rules. */
function assertLegalHistory(job: JobRecord) {
  let resume: string | undefined;
  for (const e of job.history.filter((h) => h.type === "transition")) {
    const r = checkTransition(e.from!, e.to!, resume as any);
    expect(r.ok, `${e.from} -> ${e.to}`).toBe(true);
    resume = e.to === "BLOCKED" || e.to === "FAILED" ? e.from : undefined;
  }
}

const runsOf = async (ws: string, jobId: string, step?: string) => (await execLog(ws)).filter((e) => e.jobId === jobId && (!step || e.step === step));

describe("runner (in-process, fixture executors)", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-run-");
    p = await setupProject(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  it("runs every step once, verifies outputs, and reuses all of them on the next run", async () => {
    await approvePlan(p);
    const r1 = await resume(p);
    expect(r1.summary).toMatchObject({ completed: 2 });
    const job = await readJob(p.paths, J1);
    expect(job.state).toBe("ASSETS_READY");
    expect(job.lastSuccessfulStep).toBe("assets");
    expect(Object.values(job.steps).every((s) => s.status === "succeeded" && s.outputs[0]!.bytes > 0)).toBe(true);
    expect(job.artifacts).toEqual({ research: `jobs/${J1}/research/out.json`, script: `jobs/${J1}/script/out.json` });
    assertLegalHistory(job);
    const before = (await execLog(p.ws)).length;

    const r2 = await resume(p);
    expect(r2.jobs.map((j) => j.result)).toEqual(["unchanged", "unchanged"]);
    expect(r2.jobs[0]!.stepsReused).toEqual(["research", "script", "localize", "narrate", "assets"]);
    expect((await execLog(p.ws)).length).toBe(before);
    expect((await readJob(p.paths, J1)).revision).toBe(job.revision); // nothing rewritten
  });

  it("retries retryable failures with backoff and records every attempt", async () => {
    await writeControl(p.ws, { steps: { script: { jobs: ["topic-1"], failAttempts: [1, 2] } } });
    await approvePlan(p);
    const sleeps: number[] = [];
    const r = await resume(p, { sleep: async (ms) => void sleeps.push(ms) });
    expect(r.summary.completed).toBe(2);
    const job = await readJob(p.paths, J1);
    expect(job.steps["script"]!.attempts.map((a) => a.outcome)).toEqual(["failed-retryable", "failed-retryable", "succeeded"]);
    expect(job.steps["script"]!.attempts[0]!.error).toMatchObject({ code: "INJECTED" });
    expect(sleeps).toEqual([10, 20]); // base 10 ms, doubled, capped at 40
    expect((await runsOf(p.ws, J2, "script")).length).toBe(1);
  });

  it("stops at the retry limit, marks FAILED, and does not retry until explicitly allowed", async () => {
    await writeControl(p.ws, { steps: { script: { jobs: ["topic-1"], failAttempts: [1, 2, 3, 4] } } });
    await approvePlan(p);
    const r1 = await resume(p, { sleep: async () => {} });
    expect(r1.jobs.map((j) => j.result)).toEqual(["failed", "completed"]);
    let job = await readJob(p.paths, J1);
    expect(job).toMatchObject({ state: "FAILED", resumeState: "RESEARCHED", failure: { step: "script", kind: "retries-exhausted" } });
    expect(job.steps["script"]!.attempts).toHaveLength(3);

    const r2 = await resume(p, { sleep: async () => {} });
    expect(r2.jobs[0]).toMatchObject({ result: "failed", attempts: 0 });
    expect((await runsOf(p.ws, J1, "script")).length).toBe(3);

    const r3 = await resume(p, { retryFailed: true, sleep: async () => {} }); // attempt 4 fails, 5 succeeds
    expect(r3.jobs[0]!.result).toBe("completed");
    job = await readJob(p.paths, J1);
    expect(job.steps["script"]!.budgetStart).toBe(3);
    expect(job.history.some((h) => h.type === "retry-granted" && h.reason === "explicit --retry-failed")).toBe(true);
    expect((await runsOf(p.ws, J1, "research")).length).toBe(1); // upstream never rerun
    assertLegalHistory(job);
  });

  it("never retries permanent failures automatically, but does after the inputs change", async () => {
    await writeControl(p.ws, { steps: { script: { jobs: ["topic-1"], failAttempts: [1], failKind: "permanent" } } });
    await approvePlan(p);
    await resume(p);
    let job = await readJob(p.paths, J1);
    expect(job.steps["script"]!.attempts.map((a) => a.outcome)).toEqual(["failed-permanent"]);
    expect(job.failure).toMatchObject({ kind: "permanent", code: "INJECTED" });
    await resume(p);
    expect((await runsOf(p.ws, J1, "script")).length).toBe(1);

    // Changing the hook changes the script step's inputs -> a fresh budget is granted automatically.
    await approvePlan(p, makePlan(2, { 0: { hook: "Better hook" } }));
    const r = await resume(p);
    expect(r.jobs[0]!.result).toBe("completed");
    job = await readJob(p.paths, J1);
    expect(job.history.find((h) => h.type === "retry-granted")?.reason).toBe("inputs changed since the failure");
    expect((await runsOf(p.ws, J1, "research")).length).toBe(1);
  });

  it("blocks without consuming retries and re-checks on resume", async () => {
    await writeControl(p.ws, { steps: { research: { jobs: ["topic-2"], blockAttempts: [1, 2] } } });
    await approvePlan(p);
    expect((await resume(p)).jobs[1]).toMatchObject({ result: "blocked", state: "BLOCKED" });
    let job = await readJob(p.paths, J2);
    expect(job.blocked).toMatchObject({ step: "research", code: "NEEDS_SOURCES" });
    expect((await resume(p)).jobs[1]!.result).toBe("blocked");
    expect((await resume(p)).jobs[1]!.result).toBe("completed");
    job = await readJob(p.paths, J2);
    expect(job.steps["research"]!.attempts.map((a) => a.outcome)).toEqual(["blocked", "blocked", "succeeded"]);
    assertLegalHistory(job);
  });

  it.each([
    ["missing output", { skipOutput: true }, "is missing"],
    ["empty output", { emptyOutput: true }, "is empty"],
  ])("never accepts a claimed success with %s", async (_l, behaviour, msg) => {
    await writeControl(p.ws, { steps: { research: { jobs: ["topic-1"], ...behaviour } } });
    await approvePlan(p, makePlan(1));
    const r = await resume(p, { sleep: async () => {} });
    expect(r.jobs[0]!.result).toBe("failed");
    const job = await readJob(p.paths, J1);
    expect(job.state).toBe("FAILED");
    expect(job.steps["research"]!.attempts.map((a) => a.outcome)).toEqual(["verification-failed", "verification-failed", "verification-failed"]);
    expect(job.steps["research"]!.attempts[0]!.error!.message).toContain(msg);
    expect(job.lastSuccessfulStep).toBeNull();
  });

  it("rejects an output that is a symbolic link out of the workspace", async () => {
    await approvePlan(p, makePlan(1));
    await resume(p);
    const out = path.join(p.paths.jobDir(J1), "research", "out.json");
    const outside = path.join(tmp.dir, "outside.json");
    await fs.writeFile(outside, "{}");
    await fs.rm(out);
    try {
      await fs.symlink(outside, out, "file");
    } catch {
      return; // creating symlinks needs Developer Mode/admin on Windows; the check is then untestable here
    }
    await writeControl(p.ws, { steps: { research: { skipOutput: true } } });
    const r = await resume(p, { sleep: async () => {} });
    expect(r.jobs[0]!.result).toBe("failed");
    expect((await readJob(p.paths, J1)).steps["research"]!.attempts.at(-1)!.error!.message).toContain("symbolic link");
  });

  it("times out a hung step, kills its child process, and counts it as a retryable attempt", async () => {
    await writeControl(p.ws, { steps: { research: { jobs: ["topic-1"], spawnChildPidFile: "child.pid" } } });
    await approvePlan(p, makePlan(1));
    const policy = { ...p.config.workflow, maxAttempts: 1, stepTimeoutMs: { research: 1500 } };
    const t0 = Date.now();
    const r = await resume(p, { policy });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.jobs[0]!.result).toBe("failed");
    const job = await readJob(p.paths, J1);
    expect(job.steps["research"]!.attempts[0]).toMatchObject({ outcome: "timeout", error: { code: "TIMEOUT" } });
    expect(job.failure).toMatchObject({ kind: "retries-exhausted" });
    const childPid = Number(await fs.readFile(path.join(p.ws, "child.pid"), "utf8"));
    for (let i = 0; i < 100 && isProcessAlive(childPid); i++) await new Promise((res) => setTimeout(res, 20));
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it("cancellation stops cleanly, does not consume retries, and keeps completed work", async () => {
    await writeControl(p.ws, { steps: { script: { jobs: ["topic-1"], hangOnAttempts: [1] } } });
    await approvePlan(p, makePlan(1));
    const ac = new AbortController();
    const marker = path.join(p.ws, `hang-${J1}-script-1.marker`);
    const run = resume(p, { signal: ac.signal });
    for (let i = 0; i < 500 && !(await fs.stat(marker).catch(() => undefined)); i++) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const r = await run;
    expect(r.jobs[0]!.result).toBe("cancelled");
    let job = await readJob(p.paths, J1);
    expect(job.state).toBe("RESEARCHED");
    expect(job.steps["script"]!.attempts[0]!.outcome).toBe("cancelled");
    await expect(fs.stat(p.paths.jobLock(J1))).rejects.toThrow();

    await writeControl(p.ws, {});
    expect((await resume(p)).jobs[0]!.result).toBe("completed");
    job = await readJob(p.paths, J1);
    expect(job.steps["script"]!.attempts.map((a) => a.outcome)).toEqual(["cancelled", "succeeded"]);
    expect((await runsOf(p.ws, J1, "research")).length).toBe(1);
  });

  it("[simulated crash record] treats an open attempt as interrupted and counts it", async () => {
    await approvePlan(p, makePlan(1));
    await resume(p);
    // Fabricate the record a killed process would leave: script "running" with an open attempt.
    const job = await readJob(p.paths, J1);
    job.steps["script"] = { ...job.steps["script"]!, status: "running", attempts: [...job.steps["script"]!.attempts, { n: 2, startedAt: job.updatedAt, runner: { pid: 999999, hostname: "h" } }] };
    await writeJsonAtomic(p.paths.jobFile(J1), job);
    const r = await resume(p, { forceSteps: new Set(["script"]) });
    expect(r.jobs[0]!.notes.join(" ")).toContain("script: attempt 2 was interrupted");
    const after = await readJob(p.paths, J1);
    expect(after.steps["script"]!.attempts.map((a) => a.outcome)).toEqual(["succeeded", "interrupted", "succeeded"]);
  });
});

describe("dependency-aware invalidation", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-inv-");
    p = await setupProject(tmp.dir);
    await approvePlan(p, makePlan(3));
    await resume(p);
  });
  afterEach(() => tmp.cleanup());

  const counts = async () => {
    const log = await execLog(p.ws);
    const c: Record<string, number> = {};
    for (const e of log) c[`${e.jobId.replace("2026-w44-", "")}:${e.step}`] = (c[`${e.jobId.replace("2026-w44-", "")}:${e.step}`] ?? 0) + 1;
    return c;
  };

  it("a changed item reruns only that video; unchanged items are not touched", async () => {
    const before = await counts();
    const j1Before = await readJob(p.paths, J1);
    await approvePlan(p, makePlan(3, { 1: { topic: "A completely different topic" } }));
    const r = await resume(p);
    expect(r.jobs.map((j) => [j.jobId, j.result])).toEqual([[J1, "unchanged"], [J2, "completed"], ["2026-w44-topic-3", "unchanged"]]);
    const after = await counts();
    for (const s of ["research", "script", "localize", "narrate", "assets"]) {
      expect(after[`topic-1:${s}`]).toBe(before[`topic-1:${s}`]);
      expect(after[`topic-2:${s}`]).toBe(before[`topic-2:${s}`]! + 1);
    }
    // J1 only records the new plan reference.
    const j1 = await readJob(p.paths, J1);
    expect(j1.steps).toEqual(j1Before.steps);
    expect(j1.history.at(-1)).toMatchObject({ type: "plan-updated", reason: expect.stringContaining("item unchanged") });
    const j2 = await readJob(p.paths, J2);
    expect(j2.history.filter((h) => h.type === "invalidated").map((h) => h.step)).toEqual(["research", "script", "localize", "narrate", "assets"]);
    assertLegalHistory(j2);
  });

  it("a change that only affects a later step keeps earlier verified steps", async () => {
    const before = await counts();
    await approvePlan(p, makePlan(3, { 0: { hook: "Sharper hook" } }));
    await resume(p);
    const after = await counts();
    expect(after["topic-1:research"]).toBe(before["topic-1:research"]);
    expect(after["topic-1:script"]).toBe(before["topic-1:script"]! + 1);
    expect(after["topic-1:localize"]).toBe(before["topic-1:localize"]! + 1); // its upstream output changed
    expect(after["topic-2:script"]).toBe(before["topic-2:script"]);
    const j1 = await readJob(p.paths, J1);
    expect(j1.history.find((h) => h.type === "invalidated")).toMatchObject({ step: "script", reason: "step inputs changed" });
  });

  it("a relevant profile change invalidates only the steps that depend on it", async () => {
    const before = await counts();
    const profileFile = path.join(p.dir, "creator-profile.json");
    const prof = (await readJsonFile(profileFile)) as any;
    prof.brand.name = "Renamed Brand";
    await writeJsonAtomic(profileFile, prof);
    const { requireProject } = await import("../../packages/cli/src/project.ts");
    const fresh = await requireProject(p.dir);
    await resume({ ...p, profile: fresh.profile });
    const after = await counts();
    for (const id of ["topic-1", "topic-2", "topic-3"]) {
      expect(after[`${id}:research`]).toBe(before[`${id}:research`]);
      expect(after[`${id}:script`]).toBe(before[`${id}:script`]! + 1);
    }
    const j = await readJob(p.paths, J1);
    expect(j.history.find((h) => h.type === "invalidated")?.reason).toBe("relevant configuration changed");
  });

  it("an irrelevant profile change, new timestamps or a new plan version with identical items rerun nothing", async () => {
    const before = await counts();
    const prof = { ...p.profile, creator: { ...p.profile.creator, niche: "Something else entirely" } };
    await approvePlan(p, { ...makePlan(3), notes: "only the notes changed" });
    const r = await resume({ ...p, profile: prof });
    expect(r.planVersion).toBe(2);
    expect(r.jobs.every((j) => j.result === "unchanged")).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it("an edited or deleted output is detected and only that step onwards reruns", async () => {
    const before = await counts();
    await fs.writeFile(path.join(p.paths.jobDir(J1), "script", "out.json"), "tampered");
    await fs.rm(path.join(p.paths.jobDir(J2), "assets", "out.json"));
    await resume(p);
    const after = await counts();
    expect(after["topic-1:research"]).toBe(before["topic-1:research"]);
    expect(after["topic-1:script"]).toBe(before["topic-1:script"]! + 1);
    expect(after["topic-1:localize"]).toBe(before["topic-1:localize"]); // regenerated script is byte-identical -> reused
    expect(after["topic-2:assets"]).toBe(before["topic-2:assets"]! + 1);
    expect(after["topic-2:localize"]).toBe(before["topic-2:localize"]);
    expect((await readJob(p.paths, J1)).history.find((h) => h.type === "invalidated")?.reason).toContain("was modified after verification");
  });

  it("--force-step reruns a step; byte-identical output lets downstream steps be reused", async () => {
    const before = await counts();
    const r = await resume(p, { jobId: J1, forceSteps: new Set(["research"]) });
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ stepsRun: ["research"], stepsReused: ["script", "localize", "narrate", "assets"], state: "ASSETS_READY" });
    const job = await readJob(p.paths, J1);
    expect(job).toMatchObject({ state: "ASSETS_READY", lastSuccessfulStep: "assets" });
    assertLegalHistory(job);
    const after = await counts();
    expect(after["topic-1:research"]).toBe(before["topic-1:research"]! + 1);
    expect(after["topic-1:script"]).toBe(before["topic-1:script"]);
  });
});

describe("secret redaction and locking", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-sec-");
    p = await setupProject(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  it("redacts secrets from stored error messages", async () => {
    const secret = "my-env-secret-value-12345";
    await writeControl(p.ws, { steps: { research: { failAttempts: [1], failKind: "permanent", message: `auth failed key=sk-abcdefghijklmnopqrstuvwx env=${secret}` } } });
    await approvePlan(p, makePlan(1));
    await resume(p, { knownSecrets: [secret] });
    const raw = await fs.readFile(p.paths.jobFile(J1), "utf8");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("auth failed key=[REDACTED] env=[REDACTED]");
  });

  it("a job locked by a live process is reported as locked and left untouched", async () => {
    const v = await approvePlan(p, makePlan(1));
    await resume(p);
    const before = await fs.readFile(p.paths.jobFile(J1), "utf8");
    await fs.writeFile(p.paths.jobLock(J1), JSON.stringify({ token: "x", pid: process.pid, hostname: "elsewhere", acquiredAt: new Date().toISOString(), purpose: "other" }));
    const plan = await new PlanStore(p.paths).approvedPlan(WEEK);
    const r = await runJob({ paths: p.paths, pipeline: fixturePipeline, plan, item: plan.content.items[0]!, profile: p.profile, config: p.config, forceSteps: new Set(["research"]) });
    expect(r).toMatchObject({ result: "locked", message: expect.stringContaining("elsewhere") });
    expect(await fs.readFile(p.paths.jobFile(J1), "utf8")).toBe(before);
    expect(v.version).toBe(1);
  });
});

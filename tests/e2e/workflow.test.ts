// End-to-end workflow tests with REAL child processes (no mocked restarts).
// Production code paths throughout; only step executors are fixtures, injected
// by tests/fixtures/fixture-cli.ts which calls the real CLI main().
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, sha256File, writeJsonAtomic } from "@creatorflow/core";
import { makeTempDir } from "../helpers.ts";
import { execLog, exists, makePlan, readJob, setupProject, waitFor, WEEK, writeControl, type FixtureProject } from "../workflow-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_CLI = path.join(repoRoot, "tests", "fixtures", "fixture-cli.ts");
const PROD_CLI = path.join(repoRoot, "packages", "cli", "bin", "creatorflow.js");
const J1 = "2026-w44-topic-1";
const J2 = "2026-w44-topic-2";

interface Proc {
  pid: number;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
  kill(): void;
}

function start(args: string[], launcher = FIXTURE_CLI): Proc {
  const child = spawn(process.execPath, [launcher, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { pid: child.pid!, done, kill: () => child.kill("SIGKILL") };
}

const run = (args: string[], launcher?: string) => start(args, launcher).done;
const json = (s: string) => JSON.parse(s) as Record<string, any>;

async function addAndApprove(p: FixtureProject, plan = makePlan(2)) {
  const planFile = path.join(p.dir, `plan-${Date.now()}.json`);
  await writeJsonAtomic(planFile, plan);
  const added = await run(["-C", p.dir, "--json", "plan", "add", "--file", planFile]);
  expect(added.code, added.stderr).toBe(0);
  const { version, contentHash } = json(added.stdout);
  const approved = await run(["-C", p.dir, "--json", "approve-plan", "--plan-version", String(version), "--hash", contentHash, "--by", "e2e"]);
  expect(approved.code, approved.stdout + approved.stderr).toBe(0);
  return { version, contentHash };
}

describe("ACCEPTANCE: resume after a killed process preserves verified work (real processes)", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-acc-");
    p = await setupProject(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  it("kills process 1 mid-step, resumes in process 2, and never reruns the completed step", async () => {
    // script (topic-1): attempt 1 fails (retryable), attempt 2 hangs until killed, attempt 3 succeeds.
    await writeControl(p.ws, { steps: { script: { jobs: ["topic-1"], failAttempts: [1], hangOnAttempts: [2] } } });
    await addAndApprove(p);

    // ---- process 1: research succeeds, script fails once, then hangs; we kill it.
    const p1 = start(["-C", p.dir, "--json", "resume"]);
    const marker = path.join(p.ws, `hang-${J1}-script-2.marker`);
    await waitFor(() => exists(marker), 20_000, "process 1 to reach script attempt 2");
    p1.kill();
    const r1 = await p1.done;
    expect(r1.code === null || r1.code !== 0).toBe(true); // terminated, not a clean exit
    await waitFor(async () => !isProcessAlive(p1.pid), 5_000, "process 1 to die");

    // Persisted state at the moment of the crash.
    const crashed = await readJob(p.paths, J1);
    expect(crashed.state).toBe("RESEARCHED");
    expect(crashed.lastSuccessfulStep).toBe("research");
    expect(crashed.steps["script"]!.status).toBe("running");
    expect(crashed.steps["script"]!.attempts.map((a) => a.outcome ?? "OPEN")).toEqual(["failed-retryable", "OPEN"]);
    expect(await exists(p.paths.jobLock(J1))).toBe(true); // left behind by the killed process
    const researchOut = path.join(p.paths.jobDir(J1), "research", "out.json");
    const researchHash = (await sha256File(researchOut)).sha256;
    const researchMtime = (await fs.stat(researchOut)).mtimeMs;
    expect(crashed.steps["research"]!.outputs[0]!.sha256).toBe(researchHash);
    expect(await exists(p.paths.jobFile(J2))).toBe(true); // created at approval, never started
    expect((await readJob(p.paths, J2)).state).toBe("PLANNED");

    // ---- process 2: same control file; the policy alone decides the retry.
    const r2 = await run(["-C", p.dir, "--json", "resume"]);
    expect(r2.code, r2.stderr).toBe(0);
    const report = json(r2.stdout);
    expect(report.summary).toMatchObject({ completed: 2, failed: 0, blocked: 0, locked: 0 });
    expect(report.jobs[0]).toMatchObject({ jobId: J1, result: "completed", stepsReused: ["research"], stepsRun: ["script", "localize", "narrate", "assets"] });
    expect(report.jobs[0].notes.join(" ")).toMatch(/stale lock from dead pid .*script: attempt 2 was interrupted/s);

    // The completed step was not rerun and its output is byte-for-byte intact.
    const log = await execLog(p.ws);
    const research1 = log.filter((e) => e.jobId === J1 && e.step === "research");
    expect(research1).toHaveLength(1);
    expect(research1[0]!.pid).toBe(p1.pid);
    expect((await sha256File(researchOut)).sha256).toBe(researchHash);
    expect((await fs.stat(researchOut)).mtimeMs).toBe(researchMtime);

    // The failed step was retried by policy: 3 attempts total, the interrupted one counted.
    const final = await readJob(p.paths, J1);
    expect(final.state).toBe("ASSETS_READY");
    expect(final.steps["script"]!.attempts.map((a) => a.outcome)).toEqual(["failed-retryable", "interrupted", "succeeded"]);
    expect(final.steps["script"]!.attempts[2]!.runner.pid).not.toBe(p1.pid);
    expect(log.filter((e) => e.jobId === J1 && e.step === "script").map((e) => [e.attempt, e.pid === p1.pid ? "p1" : "p2"])).toEqual([[1, "p1"], [2, "p1"], [3, "p2"]]);
    expect(final.history.map((h) => h.type)).toEqual(expect.arrayContaining(["recovered", "interrupted-attempt"]));
    expect((await readJob(p.paths, J2)).state).toBe("ASSETS_READY");

    // Clean filesystem: lock released, no temp files.
    expect(await exists(p.paths.jobLock(J1))).toBe(false);
    const leftovers = (await fs.readdir(p.paths.jobDir(J1))).filter((f) => f.endsWith(".tmp") || f.includes(".stale-"));
    expect(leftovers).toEqual([]);

    // ---- process 3: status reports the truth; resuming again does nothing.
    const s = await run(["-C", p.dir, "--json", "status"]);
    expect(s.code).toBe(0);
    expect(json(s.stdout).jobs.map((j: any) => [j.jobId, j.state, j.progress.verified])).toEqual([[J1, "ASSETS_READY", 5], [J2, "ASSETS_READY", 5]]);
    const again = await run(["-C", p.dir, "--json", "resume"]);
    expect(again.code).toBe(0);
    expect(json(again.stdout).summary.unchanged).toBe(2);
    expect((await execLog(p.ws)).length).toBe(log.length);
  });

  it("enforces the retry budget across processes: exhausted -> FAILED (exit 1), only --retry-failed continues", async () => {
    await writeControl(p.ws, { steps: { script: { jobs: ["topic-1"], failAttempts: [1, 3], hangOnAttempts: [2] } } });
    await addAndApprove(p, makePlan(1));
    const p1 = start(["-C", p.dir, "resume"]);
    await waitFor(() => exists(path.join(p.ws, `hang-${J1}-script-2.marker`)), 20_000, "hang");
    p1.kill();
    await p1.done;

    const r2 = await run(["-C", p.dir, "--json", "resume"]);
    expect(r2.code).toBe(1);
    expect(json(r2.stdout).jobs[0]).toMatchObject({ result: "failed", state: "FAILED" });
    expect((await readJob(p.paths, J1)).steps["script"]!.attempts.map((a) => a.outcome)).toEqual(["failed-retryable", "interrupted", "failed-retryable"]);

    const r3 = await run(["-C", p.dir, "--json", "resume"]);
    expect(r3.code).toBe(1);
    expect(json(r3.stdout).jobs[0].attempts).toBe(0);

    const r4 = await run(["-C", p.dir, "--json", "resume", "--retry-failed"]);
    expect(r4.code, r4.stdout).toBe(0);
    const job = await readJob(p.paths, J1);
    expect(job.state).toBe("ASSETS_READY");
    expect((await execLog(p.ws)).filter((e) => e.step === "research")).toHaveLength(1);
  });
});

describe("concurrency between real processes", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-conc-");
    p = await setupProject(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  it("a second resume of the same job exits 5 (locked) and cannot corrupt it", async () => {
    await writeControl(p.ws, { steps: { research: { gateFile: "open-gate" } } });
    await addAndApprove(p, makePlan(1));
    const a = start(["-C", p.dir, "--json", "resume"]);
    await waitFor(() => exists(path.join(p.ws, `waiting-${J1}-research.marker`)), 20_000, "process A to hold the job");
    const b = await run(["-C", p.dir, "--json", "resume"]);
    expect(b.code).toBe(5);
    expect(json(b.stdout).jobs[0]).toMatchObject({ result: "locked", message: expect.stringContaining(`pid ${a.pid}`) });
    const status = json((await run(["-C", p.dir, "--json", "status"])).stdout);
    expect(status.jobs[0].runningPid).toBe(a.pid);

    await fs.writeFile(path.join(p.ws, "open-gate"), "");
    const ra = await a.done;
    expect(ra.code, ra.stderr).toBe(0);
    const job = await readJob(p.paths, J1);
    expect(job.state).toBe("ASSETS_READY");
    expect(job.steps["research"]!.attempts).toHaveLength(1);
    expect((await execLog(p.ws)).filter((e) => e.step === "research")).toHaveLength(1);
  });

  it("concurrent `plan add` processes each get their own version (no lost update)", async () => {
    const files = await Promise.all([1, 2, 3].map(async (n) => {
      const f = path.join(p.dir, `plan-${n}.json`);
      await writeJsonAtomic(f, makePlan(n));
      return f;
    }));
    const results = await Promise.all(files.map((f) => run(["-C", p.dir, "--json", "plan", "add", "--file", f])));
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(results.map((r) => json(r.stdout).version).sort()).toEqual([1, 2, 3]);
    const s = json((await run(["-C", p.dir, "--json", "status"])).stdout);
    expect(s.plan.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
  });
});

describe("CLI exit codes and messages (real processes)", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-cli-");
    p = await setupProject(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  it("reports missing plans/jobs as NOT_FOUND (6) instead of an empty success", async () => {
    for (const args of [["status"], ["resume"], ["approve-plan", "--plan-version", "1", "--hash", "abcdefabcdef"]]) {
      const r = await run(["-C", p.dir, "--json", ...args]);
      expect(r.code, args.join(" ")).toBe(6);
      expect(json(r.stdout)).toMatchObject({ ok: false, error: "PLAN_NOT_FOUND" });
    }
    await addAndApprove(p, makePlan(1));
    const r = await run(["-C", p.dir, "--json", "resume", "--job", "2026-w44-not-planned"]);
    expect(r.code).toBe(6);
    expect(json(r.stdout).error).toBe("JOB_NOT_FOUND");
  });

  it("approval gate and plan validation codes", async () => {
    const bad = path.join(p.dir, "bad.json");
    await writeJsonAtomic(bad, { weekId: WEEK, items: [] });
    expect((await run(["-C", p.dir, "plan", "add", "--file", bad])).code).toBe(1);

    const planFile = path.join(p.dir, "plan.json");
    await writeJsonAtomic(planFile, makePlan(2));
    const added = json((await run(["-C", p.dir, "--json", "plan", "add", "--file", planFile])).stdout);
    const unapproved = await run(["-C", p.dir, "--json", "resume"]);
    expect(unapproved.code).toBe(1);
    expect(json(unapproved.stdout)).toMatchObject({ error: "PLAN_NOT_APPROVED", hint: expect.stringContaining(added.contentHash) });
    expect((await run(["-C", p.dir, "approve-plan", "--plan-version", "1", "--hash", "0123456789abcdef"])).code).toBe(5);
    expect((await run(["-C", p.dir, "approve-plan", "--plan-version", "x", "--hash", added.contentHash])).code).toBe(2);
    expect((await run(["-C", p.dir, "approve-plan", "--plan-version", "1"])).code).toBe(2); // --hash required
    const ok = await run(["-C", p.dir, "approve-plan", "--plan-version", "1", "--hash", added.contentHash.slice(0, 20)]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("Nothing is published automatically");
    expect((await run(["-C", p.dir, "resume", "--force-step", "render"])).code).toBe(2);
    expect((await run(["-C", p.dir, "status", "--week", "bogus"])).code).toBe(2);
  });

  it("status flags a corrupt job (exit 1); resume quarantines it and recovers from the backup", async () => {
    await addAndApprove(p, makePlan(1));
    expect((await run(["-C", p.dir, "resume"])).code).toBe(0);
    await fs.writeFile(p.paths.jobFile(J1), '{"schemaVersion": 1, "kind": "video-job", "jobId": "2026-w44-top');
    const s = await run(["-C", p.dir, "status"]);
    expect(s.code).toBe(1);
    expect(s.stdout).toContain("CORRUPT");
    const r = await run(["-C", p.dir, "--json", "resume"]);
    expect(r.code, r.stdout).toBe(0);
    expect(json(r.stdout).jobs[0].notes.join(" ")).toContain("recovered from job.prev.json");
    const files = await fs.readdir(p.paths.jobDir(J1));
    expect(files.some((f) => f.startsWith("job.json.corrupt-"))).toBe(true);
    expect((await readJob(p.paths, J1)).state).toBe("ASSETS_READY");
    expect((await run(["-C", p.dir, "status"])).code).toBe(0);
  });

  it("the production CLI blocks honestly: unresearched items need research (exit 1, NEEDS_RESEARCH)", async () => {
    await addAndApprove(p, makePlan(1));
    const r = await run(["-C", p.dir, "--json", "resume"], PROD_CLI);
    expect(r.code).toBe(1);
    const report = json(r.stdout);
    expect(report.jobs[0]).toMatchObject({ result: "blocked", state: "BLOCKED", message: expect.stringContaining("no research reference") });
    const job = await readJob(p.paths, J1);
    expect(job.blocked).toMatchObject({ step: "research", code: "NEEDS_RESEARCH" });
    expect(job.lastSuccessfulStep).toBeNull();
    // Re-checked on every resume; blocked attempts never consume the retry budget.
    expect((await run(["-C", p.dir, "resume"], PROD_CLI)).code).toBe(1);
    const again = await readJob(p.paths, J1);
    expect(again.steps["research"]!.attempts.map((a) => a.outcome)).toEqual(["blocked", "blocked"]);
    expect(again.state).toBe("BLOCKED");
    const s = await run(["-C", p.dir, "status"], PROD_CLI);
    expect(s.code).toBe(0);
    expect(s.stdout).toMatch(/BLOCKED .*0\/10.*NEEDS_RESEARCH/);
  });
});

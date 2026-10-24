// ACCEPTANCE (Stage F), REAL processes and a REAL Remotion render. Process 1 is SIGKILLed while
// its render step is in progress (the real executor is wrapped by tests/fixtures/fixture-cli.ts to
// pause on attempt 1); process 2 recovers and renders for real. FICTIONAL research; no network.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProcessAlive, readJsonFile, sha256File, writeJsonAtomic } from "@creatorflow/core";
import { RenderReportSchema } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { FIXTURE_WEEK } from "../fixtures/research-fixture.ts";
import { RENDER_PROFILE, withRealRenderSlot } from "../render-helpers.ts";
import { exists, readJob, setupProject, waitFor, type FixtureProject } from "../workflow-helpers.ts";
import { writeResearchFixture } from "../fixtures/research-fixture.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_CLI = path.join(repoRoot, "packages", "cli", "bin", "creatorflow.js");
const FIXTURE_CLI = path.join(repoRoot, "tests", "fixtures", "fixture-cli.ts");
const ENV = { CF_FIXTURE_PIPELINE: "production" };
const J = "2026-w44-hooks-explained";

function start(args: string[], launcher = PROD_CLI, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [launcher, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  return { pid: child.pid!, done, kill: () => child.kill("SIGKILL") };
}
const run = (args: string[], launcher?: string, env?: NodeJS.ProcessEnv) => start(args, launcher, env).done;
const json = (s: string) => JSON.parse(s) as Record<string, any>;
const execs = async (ws: string) => (await fs.readFile(path.join(ws, "exec.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; step: string; attempt: number });

describe("ACCEPTANCE: real render through the CLI with kill-and-resume", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  const C = () => ["-C", p.dir];
  beforeAll(async () => {
    tmp = await makeTempDir("cf-e2e-render-");
    p = await setupProject(tmp.dir, {}, RENDER_PROFILE);
    await writeResearchFixture(path.join(tmp.dir, "sources"), { onlyCandidates: ["hooks-explained", "hooks-tutorial"] });
    expect((await run([...C(), "research", "--input", path.join(tmp.dir, "sources")])).code).toBe(0);
    const pl = json((await run([...C(), "--json", "plan-week", "--week", FIXTURE_WEEK])).stdout);
    expect((await run([...C(), "approve-plan", "--week", FIXTURE_WEEK, "--plan-version", "1", "--hash", pl.plan.contentHash])).code).toBe(0);
  }, 120_000);
  afterAll(() => tmp.cleanup());

  it("render config reports the local toolchain honestly", async () => {
    const r = await run([...C(), "--json", "render", "config"]);
    expect(r.code).toBe(0);
    const c = json(r.stdout);
    expect(c).toMatchObject({ ok: true, remotion: "4.0.538", settings: { codec: "h264", concurrency: 1, captions: "burn-in" }, browser: { ok: true }, voice: { mode: "none", provider: "none", ready: null } });
    expect(c.ffprobe.description).toMatch(/ffprobe/);
    expect(c.ffmpeg.description).toMatch(/ffmpeg/);
    expect(c.fonts.map((f: any) => [f.slot, f.ok])).toEqual([["heading", true], ["body", true], ["mono", true]]);
    expect(c.licensing).toContain("up to 3 people");
  });

  it("a killed render is recovered by a new process, verified, reused, and exported", async () => {
    await writeJsonAtomic(path.join(p.ws, "hang.json"), { render: { jobs: ["hooks-explained"], attempts: [1] } });
    const p1 = start([...C(), "--json", "render", "run", "--job", J], FIXTURE_CLI, ENV);
    await waitFor(() => exists(path.join(p.ws, `hang-${J}-render-1.marker`)), 120_000, "render step to start");
    p1.kill();
    await p1.done;
    await waitFor(async () => !isProcessAlive(p1.pid), 5_000, "process 1 to exit");
    const crashed = await readJob(p.paths, J);
    expect(crashed.state).toBe("RENDER_QUEUED");
    expect(crashed.steps["render"]!.attempts.map((a) => a.outcome ?? "OPEN")).toEqual(["OPEN"]);
    await expect(fs.stat(path.join(p.paths.jobDir(J), "render", "output.mp4"))).rejects.toThrow();

    // Status before recovery: not rendered -> exit 1.
    expect((await run([...C(), "render", "status", "--job", J])).code).toBe(1);

    const out = path.join(tmp.dir, "export", "hooks.mp4");
    let pid2 = 0;
    const r2 = await withRealRenderSlot(async () => {
      const s = start([...C(), "--json", "render", "run", "--job", J, "--out", out], FIXTURE_CLI, ENV);
      pid2 = s.pid;
      return s.done;
    });
    expect(r2.code, r2.stdout + r2.stderr).toBe(0);
    const res = json(r2.stdout);
    // Stage H: `render run` stops after the render step; technical QA is its own command (`qa run`).
    expect(res).toMatchObject({ ok: true, rendered: "now", nextBlocked: null });
    expect((await readJob(p.paths, J)).state).toBe("RENDERED");
    expect(res.report.mediaInspection).toMatchObject({ performed: true, matchesRequest: true, video: { codec: "h264", width: 1080, height: 1920, fps: 30 } });
    const job = await readJob(p.paths, J);
    expect(job.steps["render"]!.attempts.map((a) => a.outcome)).toEqual(["interrupted", "succeeded"]);
    const report = RenderReportSchema.parse(await readJsonFile(path.join(p.paths.jobDir(J), "render", "report.json")));
    const video = path.join(p.paths.jobDir(J), "render", "output.mp4");
    expect(report.output.sha256).toBe((await sha256File(video)).sha256);
    expect((await sha256File(out)).sha256).toBe(report.output.sha256);
    expect(report.mediaInspection.video!.frames).toBe(report.expected.durationInFrames);
    const renders = (await execs(p.ws)).filter((e) => e.step === "render");
    expect(renders.map((e) => [e.attempt, e.pid === p1.pid ? "p1" : "p2"])).toEqual([[1, "p1"], [2, "p2"]]);

    // Status and reuse.
    const st = await run([...C(), "--json", "render", "status", "--job", J]);
    expect(st.code).toBe(0);
    expect(json(st.stdout).report.technicalQa).toBe("pending");
    const again = await run([...C(), "--json", "render", "run", "--job", J]);
    expect(again.code).toBe(0);
    expect(json(again.stdout).rendered).toBe("reused");
    expect((await readJob(p.paths, J)).steps["render"]!.attempts).toHaveLength(2);

    // Tampering with the video is detected and not reported as rendered.
    const orig = await fs.readFile(video);
    await fs.appendFile(video, "x");
    const bad = await run([...C(), "--json", "render", "status", "--job", J]);
    expect(bad.code).toBe(1);
    expect(json(bad.stdout).problem).toContain("modified after verification");
    await fs.writeFile(video, orig);
    // The render process removed its private temp dir (cf-render-<pid>-*).
    const { tmpdir } = await import("node:os");
    expect((await fs.readdir(tmpdir())).filter((n) => n.startsWith(`cf-render-${pid2}-`) || n.startsWith(`cf-render-${p1.pid}-`))).toEqual([]);
  }, 900_000);

  it("REAL technical QA through the CLI: a killed QA run resumes without re-rendering; review gates delivery", async () => {
    const before = await readJob(p.paths, J);
    const renderAttempts = before.steps["render"]!.attempts.length;
    expect((await run([...C(), "qa", "show", "--job", J])).code).toBe(1); // no QA yet
    expect((await run([...C(), "--json", "review", "approve", "--job", J, "--qa-hash", "0123456789abcd"])).code).toBe(1); // nothing verified to approve

    // Process 1 is killed while its QA step runs; process 2 resumes it.
    await writeJsonAtomic(path.join(p.ws, "hang.json"), { qa: { jobs: ["hooks-explained"], attempts: [1] } });
    const p1 = start([...C(), "--json", "qa", "run", "--job", J], FIXTURE_CLI, ENV);
    await waitFor(() => exists(path.join(p.ws, `hang-${J}-qa-1.marker`)), 60_000, "QA step to start");
    p1.kill();
    await p1.done;
    const t0 = Date.now();
    const r2 = await run([...C(), "--json", "qa", "run", "--job", J], FIXTURE_CLI, ENV);
    const qaMs = Date.now() - t0;
    expect(r2.code, r2.stdout + r2.stderr).toBe(0);
    const res = json(r2.stdout);
    expect(res).toMatchObject({ ok: true, ran: "now", renderedNow: false, source: "verified", stale: false, state: "QA_PASSED", qa: { technicalQa: { status: "passed" }, humanReview: { status: "pending" } } });
    const job = await readJob(p.paths, J);
    expect(job.steps["qa"]!.attempts.map((a) => a.outcome)).toEqual(["interrupted", "succeeded"]);
    expect(job.steps["render"]!.attempts).toHaveLength(renderAttempts); // no re-render
    const qaHash = res.qaReportSha256 as string;
    console.log(`[real qa cli] qa run after a kill: ${qaMs} ms wall clock (process start included); ${res.qa.checks.length} checks, ${res.qa.frames.samples.length} frames`);

    // Unchanged inputs: QA is reused; show exits 0.
    const again = await run([...C(), "--json", "qa", "run", "--job", J]);
    expect(json(again.stdout)).toMatchObject({ ok: true, ran: "reused" });
    expect((await run([...C(), "qa", "show", "--job", J])).code).toBe(0);

    // Review gate: pending -> wrong hash (5) -> approve -> resume -> PACKAGE_READY.
    expect((await run([...C(), "review", "show", "--job", J])).code).toBe(1);
    expect((await run([...C(), "review", "approve", "--job", J, "--qa-hash", "ffffffffffffffff", "--by", "E2E Reviewer"])).code).toBe(5);
    expect((await run([...C(), "review", "approve", "--job", J, "--qa-hash", qaHash.slice(7, 23), "--by", "E2E Reviewer"])).code).toBe(0);
    const resumed = await run([...C(), "--json", "resume", "--job", J]);
    expect(json(resumed.stdout).jobs[0]).toMatchObject({ stepsRun: ["review", "package"], state: "PACKAGE_READY" });
    expect((await readJob(p.paths, J)).state).toBe("PACKAGE_READY");
    const shown = await run([...C(), "--json", "review", "show", "--job", J]);
    expect(shown.code).toBe(0);
    expect(json(shown.stdout)).toMatchObject({ review: "approved", deliveryReadiness: "ready-for-packaging" });

    // Tampering with the MP4 makes the QA report stale: it can no longer be shown as a pass.
    const video = path.join(p.paths.jobDir(J), "render", "output.mp4");
    const orig = await fs.readFile(video);
    await fs.appendFile(video, "x");
    const stale = await run([...C(), "--json", "qa", "show", "--job", J]);
    expect(stale.code).toBe(1);
    expect(json(stale.stdout)).toMatchObject({ ok: false, stale: true });
    await fs.writeFile(video, orig);
  }, 600_000);

  it("a job that cannot render reports why (exit 1), with no fake output", async () => {
    const r = await run([...C(), "--json", "render", "run", "--job", "2026-w44-hooks-tutorial"]);
    expect(r.code).toBe(1);
    const res = json(r.stdout);
    expect(res).toMatchObject({ ok: false, error: "NOT_RENDERED", blocked: { step: "assets", code: "ASSETS_MISSING" } });
    expect(res.blocked.reason).toContain("screen-recording");
    expect(res.blocked.reason).toContain("creatorflow assets register");
    expect((await run([...C(), "render", "run", "--job", "2026-w44-nope"])).code).toBe(6);
  }, 120_000);
});

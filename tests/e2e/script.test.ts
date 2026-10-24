// ACCEPTANCE (Stage E): research-backed videos go through the REAL script and localize steps in
// REAL child processes. Research data is FICTIONAL; the Hindi text is a FIXTURE sentence written for
// this test, not a production translation. No network, no paid APIs.
// The hang uses tests/fixtures/fixture-cli.ts (CF_FIXTURE_PIPELINE=production), which wraps the real
// production executors; process 1 is SIGKILLed mid-step.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, readJsonFile, sha256File, writeJsonAtomic } from "@creatorflow/core";
import { CanonicalScriptSchema, SceneManifestSchema, StoryboardSchema } from "@creatorflow/schemas";
import { makeTempDir } from "../helpers.ts";
import { FIXTURE_WEEK, RESEARCH_PROFILE, writeResearchFixture } from "../fixtures/research-fixture.ts";
import { exists, readJob, setupProject, waitFor, type FixtureProject } from "../workflow-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_CLI = path.join(repoRoot, "packages", "cli", "bin", "creatorflow.js");
const FIXTURE_CLI = path.join(repoRoot, "tests", "fixtures", "fixture-cli.ts");
const ENV = { CF_FIXTURE_PIPELINE: "production" };

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
const execLog = async (ws: string) => (await fs.readFile(path.join(ws, "exec.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; jobId: string; step: string; attempt: number });

describe("ACCEPTANCE: evidence-grounded scripts and honest localization (real processes)", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let p: FixtureProject;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-e2e-script-");
    p = await setupProject(tmp.dir, {}, RESEARCH_PROFILE);
    // No real render in this test (tests/e2e/render.test.ts does that): point the browser at a missing file.
    const cfgFile = path.join(p.dir, "creatorflow.config.json");
    const cfg = (await readJsonFile(cfgFile)) as any;
    cfg.hardware.browserExecutable = path.join(tmp.dir, "no-such-browser.exe");
    await writeJsonAtomic(cfgFile, cfg);
    await writeResearchFixture(path.join(tmp.dir, "sources"));
  });
  afterEach(() => tmp.cleanup());

  it("scripts, storyboards and manifests are written, verified, reused, recovered after a kill, and localization never fakes success", async () => {
    const C = ["-C", p.dir];
    expect((await run([...C, "research", "--input", path.join(tmp.dir, "sources")])).code).toBe(0);
    const pl = json((await run([...C, "--json", "plan-week", "--week", FIXTURE_WEEK])).stdout);
    expect((await run([...C, "approve-plan", "--week", FIXTURE_WEEK, "--plan-version", "1", "--hash", pl.plan.contentHash])).code).toBe(0);
    const ids: string[] = pl.items.map((i: any) => i.contentId);
    const english = pl.items.filter((i: any) => i.language === "en").map((i: any) => i.contentId as string);
    const target = english[1]!;
    const J = (c: string) => `2026-w44-${c}`;

    // ---- process 1: script of `target` hangs on attempt 1 and the process is killed.
    await writeJsonAtomic(path.join(p.ws, "hang.json"), { script: { jobs: [target], attempts: [1] } });
    const p1 = start([...C, "--json", "resume"], FIXTURE_CLI, ENV);
    await waitFor(() => exists(path.join(p.ws, `hang-${J(target)}-script-1.marker`)), 30_000, "script step to hang");
    p1.kill();
    await p1.done;
    await waitFor(async () => !isProcessAlive(p1.pid), 5_000, "process 1 to exit");
    const crashed = await readJob(p.paths, J(target));
    expect(crashed.state).toBe("RESEARCHED");
    expect(crashed.steps["script"]!.attempts.map((a) => a.outcome ?? "OPEN")).toEqual(["OPEN"]);
    const firstJob = await readJob(p.paths, J(english[0]!));
    expect(firstJob.steps["script"]!.status).toBe("succeeded");
    const firstHashes = firstJob.steps["script"]!.outputs.map((o) => o.sha256);

    // ---- process 2: recovers; the finished job is reused, the interrupted script is retried.
    const r2 = await run([...C, "--json", "resume"], FIXTURE_CLI, ENV);
    expect(r2.code).toBe(1); // nothing can be fully done: localization needs translations
    const rep2 = json(r2.stdout);
    const t2 = rep2.jobs.find((j: any) => j.contentId === target);
    expect(t2.stepsRun).toEqual(["script", "localize"]);
    expect(t2.notes.join(" ")).toMatch(/stale lock .*script: attempt 1 was interrupted/s);
    expect(rep2.jobs.find((j: any) => j.contentId === english[0]).stepsReused).toEqual(["research", "script"]);
    const recovered = await readJob(p.paths, J(target));
    expect(recovered.steps["script"]!.attempts.map((a) => a.outcome)).toEqual(["interrupted", "succeeded"]);
    const log = await execLog(p.ws);
    expect(log.filter((e) => e.jobId === J(english[0]!) && e.step === "script")).toHaveLength(1);
    expect((await readJob(p.paths, J(english[0]!))).steps["script"]!.outputs.map((o) => o.sha256)).toEqual(firstHashes);

    // Every English job has verified script artifacts whose hashes match the files; localization is blocked.
    for (const id of english) {
      const job = await readJob(p.paths, J(id));
      expect(job).toMatchObject({ lastSuccessfulStep: "script", state: "BLOCKED", blocked: { step: "localize", code: "NEEDS_TRANSLATION" } });
      for (const o of job.steps["script"]!.outputs) expect((await sha256File(path.join(p.paths.jobDir(J(id)), o.path))).sha256).toBe(o.sha256);
      CanonicalScriptSchema.parse(await readJsonFile(path.join(p.paths.jobDir(J(id)), "script", "script.json")));
      StoryboardSchema.parse(await readJsonFile(path.join(p.paths.jobDir(J(id)), "script", "storyboard.json")));
      SceneManifestSchema.parse(await readJsonFile(path.join(p.paths.jobDir(J(id)), "script", "scene-manifest.json")));
    }
    // The Hindi-canonical item is honestly blocked: no script provider for that language.
    for (const id of ids.filter((x) => !english.includes(x))) {
      expect((await readJob(p.paths, J(id))).blocked).toMatchObject({ step: "script", code: "SCRIPT_LANGUAGE_UNSUPPORTED" });
    }

    // ---- inspection commands (production CLI)
    const val = await run([...C, "--json", "script", "validate"]);
    expect(val.code, val.stdout).toBe(0);
    expect(json(val.stdout).jobs).toHaveLength(english.length);
    const show = await run([...C, "script", "show", "--job", J(english[0]!)]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("ESTIMATE until narration exists");
    expect(show.stdout).toMatch(/Claims: clm-/);
    const sb = await run([...C, "storyboard", "inspect", "--job", J(english[0]!)]);
    expect(sb.code).toBe(0);
    expect(sb.stdout).toMatch(/scn-01 .*hook-typography/);
    expect(sb.stdout).toContain("none are registered yet");
    expect((await run([...C, "script", "show", "--job", J(ids.find((x) => !english.includes(x))!)])).code).toBe(1); // no script, not a fake one

    // Tampering with a verified artifact is detected.
    const sbFile = path.join(p.paths.jobDir(J(english[0]!)), "script", "storyboard.json");
    const original = await fs.readFile(sbFile, "utf8");
    await fs.writeFile(sbFile, original.replace('"faceless": true', '"faceless": true '));
    const bad = await run([...C, "--json", "script", "validate", "--job", J(english[0]!)]);
    expect(bad.code).toBe(1);
    expect(json(bad.stdout).jobs[0].errors.join(" ")).toContain("modified after verification");
    await fs.writeFile(sbFile, original);

    // ---- process 3: no translation -> no false success; verified work is reused.
    const r3 = json((await run([...C, "--json", "resume"])).stdout);
    for (const j of r3.jobs.filter((x: any) => english.includes(x.contentId))) {
      expect(j.stepsReused).toEqual(["research", "script"]);
      expect(j.stepsRun).toEqual(["localize"]);
      expect(j.result).toBe("blocked");
    }
    const st = await run([...C, "status"]);
    expect(st.stdout).toMatch(new RegExp(`${J(english[0]!)}\\s+BLOCKED\\s+2/10\\s+next: localize.*NEEDS_TRANSLATION`));

    // ---- localize: template -> rejected copy -> valid import -> localized, then a later step blocks honestly.
    const lj = J(english[0]!);
    const tpl = json((await run([...C, "--json", "localize", "template", "--job", lj, "--lang", "hi"])).stdout).file as string;
    const t = (await readJsonFile(tpl)) as any;
    t.translator.name = "Fixture translator";
    const copied = { ...t, segments: t.segments.map((s: any) => ({ segmentId: s.segmentId, narration: s.source.narration, onScreenText: s.source.onScreenText })) };
    await writeJsonAtomic(path.join(tmp.dir, "copied.json"), copied);
    const rej = await run([...C, "--json", "localize", "import", "--job", lj, "--file", path.join(tmp.dir, "copied.json")]);
    expect(rej.code).toBe(1);
    expect(json(rej.stdout).issues.map((i: any) => i.code)).toContain("UNTRANSLATED_SEGMENT");
    t.segments = t.segments.map((s: any, i: number) => ({ segmentId: s.segmentId, narration: `यह खंड ${i + 1} का परीक्षण अनुवाद है।`, onScreenText: `खंड ${i + 1}` }));
    await writeJsonAtomic(path.join(tmp.dir, "hi.json"), t);
    const imp = await run([...C, "--json", "localize", "import", "--job", lj, "--file", path.join(tmp.dir, "hi.json")]);
    expect(imp.code, imp.stdout).toBe(0);
    expect(json(imp.stdout)).toMatchObject({ status: "imported", review: "unreviewed" });
    expect((await run([...C, "localize", "validate", "--job", lj])).code).toBe(0);
    expect((await run([...C, "--json", "subtitles", "export", "--job", lj, "--lang", "hi", "--format", "srt"])).code).toBe(6); // not localized yet

    const r4 = json((await run([...C, "--json", "resume"])).stdout);
    const r4j = r4.jobs.find((j: any) => j.jobId === lj);
    expect(r4j.stepsReused).toEqual(["research", "script"]);
    expect(r4j.stepsRun[0]).toBe("localize");
    expect(r4j.stepsRun).not.toContain("render");
    const done = await readJob(p.paths, lj);
    expect(done.steps["localize"]!.status).toBe("succeeded");
    // Stage F: assets either needs an unregistered diagram, or succeeds and queue-render finds no browser.
    expect([`assets:ASSETS_MISSING`, `queue-render:BROWSER_UNAVAILABLE`]).toContain(`${done.blocked!.step}:${done.blocked!.code}`);
    expect(done.steps["render"]).toBeUndefined();
    for (const id of english.slice(1)) expect((await readJob(p.paths, J(id))).blocked!.code).toBe("NEEDS_TRANSLATION");

    for (const fmt of ["srt", "vtt"]) {
      const ex = await run([...C, "--json", "subtitles", "export", "--job", lj, "--lang", "hi", "--format", fmt]);
      expect(ex.code, ex.stderr).toBe(0);
      expect(json(ex.stdout)).toMatchObject({ timing: "estimated", source: "localize/subtitles.json" });
      expect(ex.stderr).toContain("ESTIMATED");
      const body = await fs.readFile(json(ex.stdout).file, "utf8");
      expect(body).toContain("यह खंड 1 का परीक्षण अनुवाद है।");
      if (fmt === "vtt") expect(body.startsWith("WEBVTT")).toBe(true);
    }
    // Future steps remain unavailable.
    const final = json((await run([...C, "--json", "status"])).stdout);
    const fj = final.jobs.find((j: any) => j.jobId === lj);
    expect(fj.progress.verified).toBeGreaterThanOrEqual(3);
    expect(["assets", "queue-render"]).toContain(fj.nextStep);
  }, 180_000);
});

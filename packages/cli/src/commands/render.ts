import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId, CreatorFlowError, ExitCode, resolveWithin, sha256File, type ExitCodeValue } from "@creatorflow/core";
import { JobStore, resumeWorkflow, weekFromJobId, workflowPaths, type Pipeline } from "@creatorflow/orchestrator";
import { RenderReportSchema, validateArtifact, type JobRecord } from "@creatorflow/schemas";
import { chooseBrowser, findFfmpeg, findFfprobe, projectDirOf, remotionVersion, RENDER_OUTPUTS, renderSettings, resolveFont } from "@creatorflow/video-engine";
import { voiceProviderFor } from "@creatorflow/voice";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

const RENDER_STEPS = ["narrate", "assets", "queue-render", "render"] as const;

async function jobAndPaths(dir: string, jobId: string) {
  assertSafeId(jobId, "job id");
  const project = await requireProject(dir);
  const ws = resolveWithin(project.paths.dir, project.config.workspaceDir);
  const paths = workflowPaths(ws);
  return { project, ws, paths };
}

async function loadJob(paths: ReturnType<typeof workflowPaths>, jobId: string): Promise<JobRecord> {
  const l = await new JobStore(paths).load(jobId);
  if (l.status === "missing") throw new CreatorFlowError(`Job ${jobId} does not exist.`, { code: "JOB_NOT_FOUND", hint: "Run `creatorflow status` to list job ids.", exitCode: ExitCode.NOT_FOUND });
  if (l.status === "corrupt") throw new CreatorFlowError(`Job ${jobId} has a corrupt record.`, { code: "JOB_CORRUPT", hint: "Run `creatorflow resume` to recover it.", exitCode: ExitCode.CHECK_FAILED });
  return l.job;
}

/** Reads and verifies the render report and video against the job record. */
async function verifiedRender(paths: ReturnType<typeof workflowPaths>, job: JobRecord) {
  const rec = job.steps["render"];
  if (rec?.status !== "succeeded") return { ok: false as const, problem: `render step status: ${rec?.status ?? "not started"}` };
  const dir = paths.jobDir(job.jobId);
  for (const o of rec.outputs) {
    const f = path.join(dir, o.path);
    const actual = await sha256File(f).catch(() => undefined);
    if (!actual) return { ok: false as const, problem: `${o.path} is missing` };
    if (actual.sha256 !== o.sha256) return { ok: false as const, problem: `${o.path} was modified after verification` };
  }
  const v = validateArtifact(RenderReportSchema, JSON.parse(await fs.readFile(path.join(dir, RENDER_OUTPUTS.report), "utf8")));
  if (!v.ok) return { ok: false as const, problem: `report.json is invalid: ${v.issues[0]?.message}` };
  return { ok: true as const, report: v.value, video: path.join(dir, RENDER_OUTPUTS.video) };
}

function stepLines(o: Output, job: JobRecord): void {
  for (const id of RENDER_STEPS) {
    const r = job.steps[id];
    const last = r?.attempts.at(-1);
    o.line(`  ${id.padEnd(13)} ${(r?.status ?? "not started").padEnd(10)}${r?.attempts.length ? ` attempts ${r.attempts.length}` : ""}${last?.error ? ` — last: ${last.error.code}: ${last.error.message.slice(0, 200)}` : ""}${r?.blocked ? ` — blocked: ${r.blocked.code}: ${r.blocked.reason.slice(0, 300)}` : ""}${r?.failure ? ` — failed: ${r.failure.code}: ${r.failure.message.slice(0, 300)}` : ""}`);
  }
}

// ------------------------------------------------------------------ render run

export async function renderRunCommand(o: Output, dir: string, pipeline: Pipeline, f: { job: string; force?: boolean; out?: string }): Promise<ExitCodeValue> {
  const { project, paths } = await jobAndPaths(dir, f.job);
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  let report;
  try {
    report = await resumeWorkflow({
      paths,
      pipeline,
      profile: project.profile,
      config: project.config,
      jobId: f.job,
      ...(weekFromJobId(f.job) ? { weekId: weekFromJobId(f.job)! } : {}),
      signal: ac.signal,
      ...(f.force ? { forceSteps: new Set(["render"]) } : {}),
      stopAfter: "render",
    });
  } finally {
    process.off("SIGINT", onSigint);
  }
  const outcome = report.jobs[0]!;
  const job = await loadJob(paths, f.job);
  const v = await verifiedRender(paths, job);
  if (outcome.result === "cancelled") return ExitCode.INTERRUPTED;
  if (outcome.result === "locked") {
    o.result({ ok: false, error: "LOCK_HELD", message: outcome.message });
    o.warn(outcome.message ?? "job is locked");
    return ExitCode.CONFLICT;
  }
  if (!v.ok) {
    o.result({ ok: false, error: "NOT_RENDERED", state: job.state, blocked: job.blocked ?? null, failure: job.failure ?? null, outcome });
    o.line(`${f.job}: NOT rendered (state ${job.state}).`);
    if (outcome.message) o.line(`  ${outcome.message}`);
    stepLines(o, job);
    return ExitCode.CHECK_FAILED;
  }
  let exported: string | undefined;
  if (f.out) {
    exported = path.resolve(f.out);
    await fs.mkdir(path.dirname(exported), { recursive: true });
    await fs.copyFile(v.video, exported);
  }
  const r = v.report;
  const ran = outcome.stepsRun.includes("render");
  o.result({ ok: true, rendered: ran ? "now" : "reused", video: v.video, exported: exported ?? null, report: r, nextBlocked: job.blocked ?? null });
  o.line(`${f.job}: ${ran ? "rendered" : "reused verified render"} -> ${v.video}`);
  o.line(`  ${r.expected.width}x${r.expected.height} @ ${r.expected.fps} fps, ${r.expected.durationInFrames} frames (${r.expected.durationSec}s), ${r.output.bytes} bytes, ${r.output.sha256.slice(0, 19)}…`);
  const mi = r.mediaInspection;
  o.line(mi.performed ? `  inspected with ${mi.tool}: ${mi.video?.codec} ${mi.video?.width}x${mi.video?.height} ${mi.video?.fps} fps ${mi.video?.frames ?? "?"} frames, ${mi.audioStreams} audio stream(s) — ${mi.matchesRequest ? "matches request" : "MISMATCH"}` : `  media streams NOT inspected (${mi.reason}); container check: ${mi.container.ok ? "ok" : mi.container.problem}`);
  o.line(`  audio: ${r.audio.expected === "narration" ? `narration ${r.audio.verified ? "VERIFIED" : "NOT verified"}${mi.audio ? ` (${mi.audio.codec} ${mi.audio.sampleRate ?? "?"} Hz ${mi.audio.channels ?? "?"} ch, ${mi.audio.durationSec ?? "?"} s)` : ""}` : `none (silent by request${r.audio.verified ? ", verified: no audio stream" : ""})`}; captions ${r.captions.timing}${r.videoClips?.length ? `; ${r.videoClips.length} video clip(s)` : ""}`);
  for (const c of r.audio.checks ?? []) if (!c.ok) o.line(`    check ${c.check}: ${c.detail}`);
  for (const w of r.warnings) o.line(`  warning: ${w}`);
  if (exported) o.line(`  copied to ${exported}`);
  o.line("  Technical QA has not run in this command: use `creatorflow qa run --job <id>` (or `resume`). Nothing has been published.");
  return ExitCode.OK;
}

// ------------------------------------------------------------------ render status

export async function renderStatusCommand(o: Output, dir: string, f: { job: string }): Promise<ExitCodeValue> {
  const { paths } = await jobAndPaths(dir, f.job);
  const job = await loadJob(paths, f.job);
  const v = await verifiedRender(paths, job);
  o.result({ ok: v.ok, jobId: job.jobId, state: job.state, steps: Object.fromEntries(RENDER_STEPS.map((id) => [id, job.steps[id] ?? null])), report: v.ok ? v.report : null, problem: v.ok ? null : v.problem });
  o.line(`${job.jobId}: state ${job.state}${job.blocked ? ` (blocked at ${job.blocked.step}: ${job.blocked.code})` : ""}${job.failure ? ` (failed at ${job.failure.step}: ${job.failure.code})` : ""}`);
  stepLines(o, job);
  if (v.ok) {
    const r = v.report;
    o.line(`Render: ${r.output.path} ${r.expected.width}x${r.expected.height}@${r.expected.fps} ${r.expected.durationSec}s, rendered ${r.completedAt} in ${Math.round(r.renderDurationMs / 1000)}s; media inspection ${r.mediaInspection.performed ? "performed" : "not performed"}; audio ${r.audio.expected ?? (r.audio.present ? "present" : "none")}${r.audio.verified ? " (verified)" : ""}; captions ${r.captions.timing}; technical QA ${r.technicalQa}`);
  } else o.line(`Render: not available (${v.problem})`);
  return v.ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

// ------------------------------------------------------------------ render config

export async function renderConfigCommand(o: Output, dir: string): Promise<ExitCodeValue> {
  const project = await requireProject(dir);
  const ws = resolveWithin(project.paths.dir, project.config.workspaceDir);
  const browser = await chooseBrowser(project.config);
  const ffprobe = await findFfprobe(project.config);
  const fonts = [];
  for (const slot of ["heading", "body", "mono"] as const) {
    const r = await resolveFont(slot, project.profile.brand.fonts[slot], projectDirOf(ws, project.config));
    fonts.push(r.ok ? { slot, family: r.family, ok: true, files: r.files.length, license: r.license } : { slot, family: r.family, ok: false, code: r.code, message: r.message });
  }
  const settings = renderSettings(project.config, browser.ok ? browser.chromeMode : "chrome-for-testing");
  const timeoutMs = project.config.workflow.stepTimeoutMs["render"] ?? 30 * 60_000;
  const ok = browser.ok && fonts.every((x) => x.ok);
  const ffmpeg = await findFfmpeg(project.config);
  const provider = (() => {
    try {
      return voiceProviderFor(project.config);
    } catch {
      return undefined;
    }
  })();
  const vh = project.profile.voice.mode === "tts" && provider ? await provider.health() : undefined;
  o.result({ ok, remotion: remotionVersion(), settings, timeoutMs, browser, ffprobe: ffprobe ?? null, ffmpeg: ffmpeg ?? null, fonts, voice: { mode: project.profile.voice.mode, provider: project.config.providers.tts.id, ready: vh ? vh.ready : null, ...(vh && !vh.ready ? { problem: vh.message } : {}) }, assetLimits: project.config.assets, outputContract: RENDER_OUTPUTS, licensing: "Remotion is free for individuals and companies of up to 3 people; larger organisations need a company licence (remotion.dev/docs/license). No licenseKey is set, so server-side renders send no telemetry (remotion.dev/docs/telemetry)." });
  o.line(`Remotion ${remotionVersion()} · codec ${settings.codec} crf ${settings.crf} ${settings.pixelFormat} · concurrency ${settings.concurrency} · captions ${settings.captions} · timeout ${Math.round(timeoutMs / 60000)} min`);
  o.line(`Browser: ${browser.ok ? `${browser.description} (${browser.chromeMode})` : `UNAVAILABLE — ${browser.message}`}`);
  o.line(`Media inspection: ${ffprobe ? ffprobe.description : "no ffprobe found; renders get a container check only"}; decoding: ${ffmpeg ? ffmpeg.description : "no ffmpeg found (video assets and narrated renders cannot be verified)"}`);
  for (const ft of fonts) o.line(`Font ${ft.slot}: ${ft.family} — ${ft.ok ? `${ft.files} local file(s), licence ${ft.license}` : `${ft.code}: ${ft.message}`}`);
  const vm = project.profile.voice.mode;
  o.line(`Voice: ${vm}${vm === "none" ? " (intentionally silent video with burned-in captions, estimated timing)" : vm === "user-recorded" ? " (not supported yet: the narrate step blocks)" : ` via ${project.config.providers.tts.id} — ${vh?.ready ? "ready (sentence-aligned captions)" : `UNAVAILABLE: ${vh && !vh.ready ? vh.message : "unknown provider"}`}`}`);
  const L = project.config.assets;
  o.line(`Video assets: ${L.videoCodecs.join("/")} up to ${L.maxVideoWidth}x${L.maxVideoHeight}, ${L.maxVideoFps} fps, ${L.maxVideoDurationSec} s, ${Math.round(L.maxVideoBytes / 1048576)} MiB; decode check ${L.decodeCheck}`);
  o.line("Licensing: Remotion is free for individuals and companies of up to 3 people; larger organisations need a company licence. No licenseKey is set, so no render telemetry is sent.");
  return ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

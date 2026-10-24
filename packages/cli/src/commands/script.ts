import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertSafeId,
  CreatorFlowError,
  ExitCode,
  fingerprint,
  isCreatorFlowError,
  readJsonFile,
  resolveWithin,
  sha256Hex,
  stringifyJson,
  writeFileAtomic,
  type ExitCodeValue,
} from "@creatorflow/core";
import { JobStore, PlanStore, weekFromJobId, workflowPaths, type WorkflowPaths } from "@creatorflow/orchestrator";
import { buildGlossary, checkTranslation, LOCALIZE_OUTPUTS, translationPath, translationTargets, translationTemplate } from "@creatorflow/localization";
import {
  CanonicalScriptSchema,
  CaptionsFileSchema,
  LanguageTag,
  LocalizationSetSchema,
  NarrationRecordSchema,
  ResearchEvidencePackSchema,
  SceneManifestSchema,
  StoryboardSchema,
  validateArtifact,
  type CanonicalScript,
  type CreatorFlowConfig,
  type CreatorProfile,
  type EditorialIssue,
  type JobRecord,
  type SubtitleTrack,
} from "@creatorflow/schemas";
import { checkSubtitleTrack, EVIDENCE_PATH, SCRIPT_OUTPUTS, SubtitleExportError, toSrt, toVtt, validateScriptAgainstEvidence } from "@creatorflow/scriptwriter";
import { NARRATION_OUTPUTS, retimeToNarration } from "@creatorflow/voice";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

interface JobContext {
  paths: WorkflowPaths;
  job: JobRecord;
  profile: CreatorProfile;
  config: CreatorFlowConfig;
  jobDir: string;
}

async function loadJob(dir: string, jobId: string): Promise<JobContext> {
  assertSafeId(jobId, "job id");
  const project = await requireProject(dir);
  const paths = workflowPaths(resolveWithin(project.paths.dir, project.config.workspaceDir));
  const loaded = await new JobStore(paths).load(jobId);
  if (loaded.status === "missing") {
    throw new CreatorFlowError(`Job ${jobId} does not exist.`, { code: "JOB_NOT_FOUND", hint: "Run `creatorflow status` to list job ids.", exitCode: ExitCode.NOT_FOUND });
  }
  if (loaded.status === "corrupt") {
    throw new CreatorFlowError(`Job ${jobId} has a corrupt record.`, { code: "JOB_CORRUPT", hint: "Run `creatorflow resume` to recover it from its backup.", exitCode: ExitCode.CHECK_FAILED, details: loaded.issues });
  }
  return { paths, job: loaded.job, profile: project.profile, config: project.config, jobDir: paths.jobDir(jobId) };
}

function requireStep(c: JobContext, step: string, hint: string): void {
  if (c.job.steps[step]?.status !== "succeeded") {
    throw new CreatorFlowError(`Job ${c.job.jobId} has no verified ${step} output (step status: ${c.job.steps[step]?.status ?? "not started"}).`, {
      code: step === "script" ? "SCRIPT_NOT_GENERATED" : "LOCALIZATION_NOT_DONE",
      hint,
      exitCode: ExitCode.CHECK_FAILED,
    });
  }
}

/** Reads a verified step output and checks it still matches the hash recorded in the job. */
async function readVerified(c: JobContext, step: string, rel: string): Promise<{ raw: string; data: unknown; sha256: string; problem?: string }> {
  const rec = c.job.steps[step]?.outputs.find((o) => o.path === rel);
  let raw: string;
  try {
    raw = await fs.readFile(resolveWithin(c.jobDir, rel), "utf8");
  } catch {
    return { raw: "", data: undefined, sha256: "", problem: `${rel} is missing` };
  }
  const sha256 = `sha256:${sha256Hex(raw)}`;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { raw, data: undefined, sha256, problem: `${rel} is not valid JSON` };
  }
  return { raw, data, sha256, ...(rec && rec.sha256 !== sha256 ? { problem: `${rel} was modified after verification (hash differs from the job record)` } : {}), ...(!rec ? { problem: `${rel} is not a recorded output of ${step}` } : {}) };
}

async function loadScript(c: JobContext): Promise<{ script: CanonicalScript; sha256: string }> {
  requireStep(c, "script", `Run \`creatorflow resume --job ${c.job.jobId}\`.`);
  const r = await readVerified(c, "script", SCRIPT_OUTPUTS.script);
  if (r.problem) throw new CreatorFlowError(`Cannot use the script: ${r.problem}.`, { code: "SCRIPT_MODIFIED", hint: "Run `creatorflow resume` to regenerate it.", exitCode: ExitCode.CHECK_FAILED });
  const v = validateArtifact(CanonicalScriptSchema, r.data);
  if (!v.ok) throw new CreatorFlowError("script.json failed schema validation.", { code: "SCRIPT_INVALID", exitCode: ExitCode.CHECK_FAILED, details: v.issues });
  return { script: v.value, sha256: r.sha256 };
}

function assertLanguage(lang: string): string {
  if (!LanguageTag.safeParse(lang).success) throw new CreatorFlowError(`Invalid language tag "${lang}".`, { code: "USAGE", hint: "Use a BCP 47 tag such as hi-IN or kn-IN.", exitCode: ExitCode.USAGE });
  return lang;
}

const issueLine = (i: EditorialIssue) => `${i.severity.toUpperCase().padEnd(7)} ${i.code}${i.segmentId ? ` [${i.segmentId}]` : ""}: ${i.message}`;

// ------------------------------------------------------------------ script show

export async function scriptShowCommand(o: Output, dir: string, jobId: string): Promise<ExitCodeValue> {
  const c = await loadJob(dir, jobId);
  const { script, sha256 } = await loadScript(c);
  o.result({ ok: true, sha256, script });
  o.line(`${script.title} — ${script.format}, ${script.language}, ${script.platform} ${script.aspectRatio}`);
  o.line(`Estimated ${script.estimatedDurationSec}s (target ${script.targetDurationSec}s, ${script.speechRateWpm} wpm; ESTIMATE until narration exists) — editorial status: ${script.editorial.status}`);
  o.line(`Evidence as of ${script.evidenceAsOf} (scheduled publish date, not the time it was generated); provider ${script.provider.id} v${script.provider.version}`);
  for (const s of script.segments) {
    o.line(`\n[${s.segmentId}] ${s.purpose} · ~${s.timing.estimatedSec}s · ${s.visual.sceneType} · text: ${s.textOrigin.join("+")}`);
    o.line(`  VO: ${s.narration}`);
    o.line(`  On screen: ${s.onScreenText}`);
    if (s.claimRefs.length) o.line(`  Claims: ${s.claimRefs.map((r) => `${r.claimId} (${r.kind}, ${r.support}, ${r.usage})`).join("; ")}`);
    for (const n of s.editorialNotes) o.line(`  note: ${n}`);
  }
  if (script.droppedSegments.length) o.line(`\nDropped: ${script.droppedSegments.map((d) => `${d.segmentId} (${d.reason})`).join("; ")}`);
  o.line("\nSources:");
  for (const a of script.attributions) o.line(`  ${a.sourceId}: ${a.publisher ?? a.title}${a.publishedAt ? `, ${a.publishedAt}` : ""}${a.requiredText ? ` — attribution: "${a.requiredText}"` : ""}${a.usageRestrictions.length ? ` — restrictions: ${a.usageRestrictions.join("; ")}` : ""}`);
  if (script.editorial.issues.length) {
    o.line("\nEditorial issues:");
    for (const i of script.editorial.issues) o.line(`  ${issueLine(i)}`);
  }
  o.line("\nA passing script is evidence-consistent, not necessarily well written: review it before production.");
  return ExitCode.OK;
}

// ------------------------------------------------------------------ script validate

export interface JobValidation {
  jobId: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export async function validateJobArtifacts(c: JobContext): Promise<JobValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const out = { jobId: c.job.jobId, ok: false, errors, warnings };
  if (c.job.steps["script"]?.status !== "succeeded") {
    errors.push(`script step has not succeeded (status: ${c.job.steps["script"]?.status ?? "not started"})`);
    return out;
  }
  const files = {
    evidence: await readVerified(c, "research", EVIDENCE_PATH),
    script: await readVerified(c, "script", SCRIPT_OUTPUTS.script),
    storyboard: await readVerified(c, "script", SCRIPT_OUTPUTS.storyboard),
    captions: await readVerified(c, "script", SCRIPT_OUTPUTS.captions),
    manifest: await readVerified(c, "script", SCRIPT_OUTPUTS.manifest),
  };
  for (const f of Object.values(files)) if (f.problem) errors.push(f.problem);
  const ev = validateArtifact(ResearchEvidencePackSchema, files.evidence.data);
  const sc = validateArtifact(CanonicalScriptSchema, files.script.data);
  const sb = validateArtifact(StoryboardSchema, files.storyboard.data);
  const cp = validateArtifact(CaptionsFileSchema, files.captions.data);
  const mf = validateArtifact(SceneManifestSchema, files.manifest.data);
  for (const [name, v] of [["evidence", ev], ["script", sc], ["storyboard", sb], ["captions", cp], ["manifest", mf]] as const) {
    if (!v.ok) errors.push(...v.issues.slice(0, 5).map((i) => `${name}: ${i.path}: ${i.message}`));
  }
  if (ev.ok && sc.ok) {
    for (const i of validateScriptAgainstEvidence(sc.value, ev.value)) (i.severity === "error" ? errors : warnings).push(`script ${issueLine(i)}`);
    if (sc.value.evidence.sha256 !== files.evidence.sha256) errors.push("script was written from a different evidence file");
    for (const i of sc.value.editorial.issues) if (i.severity !== "info") warnings.push(`editorial ${issueLine(i)}`);
  }
  if (sb.ok && sb.value.script.sha256 !== files.script.sha256) errors.push("storyboard references a different script");
  if (cp.ok) {
    if (cp.value.script.sha256 !== files.script.sha256) errors.push("captions reference a different script");
    for (const t of cp.value.tracks) errors.push(...checkSubtitleTrack(t).map((p) => `captions ${t.language}: ${p}`));
  }
  if (mf.ok) {
    if (mf.value.script.sha256 !== files.script.sha256) errors.push("manifest references a different script");
    if (mf.value.storyboard.sha256 !== files.storyboard.sha256) errors.push("manifest references a different storyboard");
    if (mf.value.subtitles.canonical.sha256 !== files.captions.sha256) errors.push("manifest references different captions");
    if (sb.ok) {
      const scenes = new Set(sb.value.scenes.map((s) => s.sceneId));
      for (const s of mf.value.scenes) if (!scenes.has(s.sceneId)) errors.push(`manifest scene ${s.sceneId} is not in the storyboard`);
    }
    if (cp.ok) {
      const cues = new Set(cp.value.tracks.flatMap((t) => t.cues.map((x) => x.cueId)));
      for (const s of mf.value.scenes) for (const id of s.captionCueIds) if (!cues.has(id)) errors.push(`manifest scene ${s.sceneId} references unknown cue ${id}`);
    }
    const missing = mf.value.assets.filter((a) => a.required && a.status === "required-unregistered").length;
    if (missing) warnings.push(`${missing} required asset(s) are declared but not registered yet (asset registry: later stage)`);
  }
  if (sc.ok) {
    try {
      const plan = await new PlanStore(c.paths).approvedPlan(c.job.weekId);
      const item = plan.content.items.find((i) => i.contentId === c.job.contentId);
      if (!item) warnings.push("the content item is no longer in the approved plan");
      else if (fingerprint(item) !== sc.value.plan.itemHash) warnings.push(`the approved plan (v${plan.version}) changed this item since the script was generated; \`creatorflow resume\` re-evaluates it`);
    } catch (error) {
      if (!isCreatorFlowError(error)) throw error;
      warnings.push(`approved plan check skipped: ${error.message}`);
    }
  }
  out.ok = errors.length === 0;
  return out;
}

export async function scriptValidateCommand(o: Output, dir: string, f: { job?: string; week?: string }): Promise<ExitCodeValue> {
  let jobIds: string[];
  if (f.job) jobIds = [f.job];
  else {
    const project = await requireProject(dir);
    const paths = workflowPaths(resolveWithin(project.paths.dir, project.config.workspaceDir));
    const week = f.week ?? (await new PlanStore(paths).latestWeek());
    if (!week) throw new CreatorFlowError("No weekly plans found.", { code: "PLAN_NOT_FOUND", exitCode: ExitCode.NOT_FOUND });
    const all = await new JobStore(paths).list();
    jobIds = [];
    for (const id of all.filter((j) => weekFromJobId(j) === week)) {
      const l = await new JobStore(paths).load(id);
      if (l.status === "ok" && l.job.steps["script"]?.status === "succeeded") jobIds.push(id);
    }
    if (jobIds.length === 0) throw new CreatorFlowError(`No job in ${week} has a generated script.`, { code: "SCRIPT_NOT_GENERATED", hint: "Run `creatorflow resume`.", exitCode: ExitCode.NOT_FOUND });
  }
  const results: JobValidation[] = [];
  for (const id of jobIds) results.push(await validateJobArtifacts(await loadJob(dir, id)));
  const ok = results.every((r) => r.ok);
  o.result({ ok, jobs: results });
  for (const r of results) {
    o.line(`${r.ok ? "VALID  " : "INVALID"} ${r.jobId}: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
    for (const e of r.errors) o.line(`  error: ${e}`);
    for (const w of r.warnings) o.line(`  warning: ${w}`);
  }
  return ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

// ------------------------------------------------------------------ storyboard inspect

export async function storyboardInspectCommand(o: Output, dir: string, jobId: string): Promise<ExitCodeValue> {
  const c = await loadJob(dir, jobId);
  requireStep(c, "script", `Run \`creatorflow resume --job ${jobId}\`.`);
  const r = await readVerified(c, "script", SCRIPT_OUTPUTS.storyboard);
  const m = await readVerified(c, "script", SCRIPT_OUTPUTS.manifest);
  for (const x of [r, m]) if (x.problem) throw new CreatorFlowError(`Cannot use the storyboard: ${x.problem}.`, { code: "STORYBOARD_MODIFIED", exitCode: ExitCode.CHECK_FAILED });
  const sb = validateArtifact(StoryboardSchema, r.data);
  const mf = validateArtifact(SceneManifestSchema, m.data);
  if (!sb.ok || !mf.ok) throw new CreatorFlowError("Storyboard or manifest failed schema validation.", { code: "STORYBOARD_INVALID", exitCode: ExitCode.CHECK_FAILED, details: [...(sb.ok ? [] : sb.issues), ...(mf.ok ? [] : mf.issues)] });
  const b = sb.value;
  const f = mf.value.format;
  o.result({ ok: true, storyboard: b, manifest: mf.value });
  o.line(`${b.contentId}: ${b.scenes.length} scenes, ~${b.estimatedDurationSec}s (estimated), ${f.width}x${f.height} @ ${f.fps} fps (${f.aspectRatio}), ${mf.value.durationInFrames} frames`);
  for (const s of b.scenes) {
    o.line(`  ${s.sceneId} ${s.startSec.toFixed(2).padStart(6)}s +${s.durationSec.toFixed(2)}s  ${s.type.padEnd(19)} ${s.motion.intent}/${s.motion.intensity}  "${s.text.primary.slice(0, 60)}"${s.text.fits ? "" : "  [TEXT TOO LONG]"}`);
    if (s.assetIds.length) o.line(`         assets: ${s.assetIds.join(", ")}`);
  }
  o.line("Asset requirements (none are registered yet; the asset registry is a later stage):");
  for (const a of b.assets) o.line(`  ${a.assetId} ${a.kind} ${a.status}${a.required ? " required" : " optional"} — ${a.description}${a.licenseNotes ? ` (${a.licenseNotes})` : ""}`);
  return ExitCode.OK;
}

// ------------------------------------------------------------------ localize

export async function localizeTemplateCommand(o: Output, dir: string, f: { job: string; lang: string; out?: string }): Promise<ExitCodeValue> {
  const lang = assertLanguage(f.lang);
  const c = await loadJob(dir, f.job);
  const { script, sha256 } = await loadScript(c);
  const needed = translationTargets(c.config, c.profile, script.language);
  if (lang.split("-")[0] === script.language.split("-")[0]) {
    throw new CreatorFlowError(`${lang} has the same base language as the canonical script (${script.language}); no translation is needed.`, { code: "USAGE", exitCode: ExitCode.USAGE });
  }
  const out = f.out ? path.resolve(f.out) : resolveWithin(path.dirname(translationPath(c.paths.workspaceDir, c.job.jobId, lang)), `${lang.toLowerCase()}.template.json`);
  await writeFileAtomic(out, stringifyJson(translationTemplate(script, sha256, lang)));
  o.result({ ok: true, file: out, language: lang, segments: script.segments.length, requiredByConfig: needed.includes(lang) });
  o.line(`Wrote translation template for ${lang} (${script.segments.length} segments): ${out}`);
  if (!needed.includes(lang)) o.warn(`Note: ${lang} is not a configured localization target (targets needing translation: ${needed.join(", ") || "none"}).`);
  o.line(`Fill it in, then: creatorflow localize import --job ${c.job.jobId} --file "${out}"`);
  return ExitCode.OK;
}

export async function localizeImportCommand(o: Output, dir: string, f: { job: string; file: string }): Promise<ExitCodeValue> {
  const c = await loadJob(dir, f.job);
  const canonical = await loadScript(c);
  const data = await readJsonFile(path.resolve(f.file));
  const check = checkTranslation(data, canonical, buildGlossary(c.profile), { wpm: c.config.script.speechRateWpm, speakingRate: c.profile.voice.speakingRate });
  if (!check.ok || !check.value) {
    o.result({ ok: false, error: check.stale ? "TRANSLATION_STALE" : "TRANSLATION_INVALID", issues: check.issues });
    o.warn(`Translation rejected (${check.issues.filter((i) => i.severity === "error").length} error(s)); nothing was imported.`);
    for (const i of check.issues) o.line(`  ${issueLine(i)}`);
    return ExitCode.CHECK_FAILED;
  }
  const dest = translationPath(c.paths.workspaceDir, c.job.jobId, check.value.language);
  const body = stringifyJson(check.value);
  const prev = await fs.readFile(dest, "utf8").catch(() => undefined);
  const status = prev === body ? "unchanged" : prev === undefined ? "imported" : "replaced";
  if (status !== "unchanged") await writeFileAtomic(dest, body);
  o.result({ ok: true, status, file: dest, language: check.value.language, review: check.value.review ? "reviewed-claimed-by-importer" : "unreviewed", issues: check.issues });
  o.line(`${status}: ${check.value.language} translation for ${c.job.jobId} -> ${dest}`);
  o.line(`Review status: ${check.value.review ? `reviewed by ${check.value.review.reviewer} (as stated by the importer; not verified)` : "UNREVIEWED"}`);
  for (const i of check.issues) o.line(`  ${issueLine(i)}`);
  o.line("Run `creatorflow resume` to build the localized variant and subtitles.");
  return ExitCode.OK;
}

export async function localizeValidateCommand(o: Output, dir: string, f: { job: string }): Promise<ExitCodeValue> {
  const c = await loadJob(dir, f.job);
  const canonical = await loadScript(c);
  const glossary = buildGlossary(c.profile);
  const needed = translationTargets(c.config, c.profile, canonical.script.language);
  const results: { language: string; status: "valid" | "missing" | "stale" | "invalid"; issues: EditorialIssue[] }[] = [];
  for (const lang of needed) {
    const file = translationPath(c.paths.workspaceDir, c.job.jobId, lang);
    let data: unknown;
    try {
      data = await readJsonFile(file);
    } catch {
      results.push({ language: lang, status: "missing", issues: [] });
      continue;
    }
    const check = checkTranslation(data, canonical, glossary, { wpm: c.config.script.speechRateWpm, speakingRate: c.profile.voice.speakingRate, expectedLanguage: lang });
    results.push({ language: lang, status: check.ok ? "valid" : check.stale ? "stale" : "invalid", issues: check.issues });
  }
  let localized: { variants: number; unreviewed: number } | undefined;
  if (c.job.steps["localize"]?.status === "succeeded") {
    const v = await readVerified(c, "localize", LOCALIZE_OUTPUTS.variants);
    const p = validateArtifact(LocalizationSetSchema, v.data);
    if (!v.problem && p.ok) localized = { variants: p.value.variants.length, unreviewed: p.value.variants.filter((x) => x.review === "unreviewed").length };
  }
  const ok = results.every((r) => r.status === "valid");
  o.result({ ok, canonicalLanguage: canonical.script.language, canonicalScriptSha256: canonical.sha256, translations: results, localized: localized ?? null });
  o.line(`${c.job.jobId}: canonical ${canonical.script.language}; translations needed: ${needed.join(", ") || "none"}`);
  for (const r of results) {
    o.line(`  ${r.language}: ${r.status.toUpperCase()}`);
    for (const i of r.issues) o.line(`    ${issueLine(i)}`);
  }
  if (localized) o.line(`Localized variants built: ${localized.variants} (${localized.unreviewed} unreviewed)`);
  return ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

// ------------------------------------------------------------------ subtitles export

export async function subtitlesExportCommand(o: Output, dir: string, f: { job: string; lang: string; format: "srt" | "vtt"; out?: string }): Promise<ExitCodeValue> {
  const lang = assertLanguage(f.lang);
  const c = await loadJob(dir, f.job);
  requireStep(c, "script", `Run \`creatorflow resume --job ${f.job}\`.`);
  // Narrated (sentence-aligned) canonical track first, then localized tracks, then the script's estimate.
  const sources: [string, string][] = [];
  if (c.job.steps["narrate"]?.status === "succeeded") sources.push(["narrate", NARRATION_OUTPUTS.subtitles]);
  if (c.job.steps["localize"]?.status === "succeeded") sources.push(["localize", LOCALIZE_OUTPUTS.subtitles]);
  sources.push(["script", SCRIPT_OUTPUTS.captions]);
  let track: SubtitleTrack | undefined;
  let from = "";
  for (const [step, rel] of sources) {
    const r = await readVerified(c, step, rel);
    if (r.problem) throw new CreatorFlowError(`Cannot export subtitles: ${r.problem}.`, { code: "SUBTITLES_MODIFIED", hint: "Run `creatorflow resume` to regenerate them.", exitCode: ExitCode.CHECK_FAILED });
    const v = validateArtifact(CaptionsFileSchema, r.data);
    if (!v.ok) throw new CreatorFlowError(`${rel} failed schema validation.`, { code: "SUBTITLES_INVALID", exitCode: ExitCode.CHECK_FAILED, details: v.issues });
    track = v.value.tracks.find((t) => t.language === lang);
    if (track) {
      from = rel;
      break;
    }
  }
  if (!track) {
    throw new CreatorFlowError(`No ${lang} subtitles for ${f.job}.`, {
      code: "SUBTITLES_NOT_AVAILABLE",
      hint: c.job.steps["localize"]?.status === "succeeded" ? `${lang} is not a localization target.` : `Localization has not completed (it needs translations). See \`creatorflow localize validate --job ${f.job}\`.`,
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  // A localized (un-narrated) track of a narrated job is moved onto the narrated timeline, still as an estimate.
  let retimed = false;
  if (from === LOCALIZE_OUTPUTS.subtitles && c.job.steps["narrate"]?.status === "succeeded") {
    const n = await readVerified(c, "narrate", NARRATION_OUTPUTS.record);
    const sb = await readVerified(c, "script", SCRIPT_OUTPUTS.storyboard);
    const nv = validateArtifact(NarrationRecordSchema, n.data);
    const sv = validateArtifact(StoryboardSchema, sb.data);
    if (!n.problem && !sb.problem && nv.ok && sv.ok && nv.value.status === "generated") {
      track = retimeToNarration(track, sv.value, nv.value);
      retimed = true;
    }
  }
  let body: string;
  try {
    body = f.format === "srt" ? toSrt(track) : toVtt(track);
  } catch (error) {
    if (error instanceof SubtitleExportError) throw new CreatorFlowError(error.message, { code: "SUBTITLES_INVALID", exitCode: ExitCode.CHECK_FAILED, details: error.problems });
    throw error;
  }
  const out = f.out ? path.resolve(f.out) : resolveWithin(c.jobDir, `export/subtitles.${lang.toLowerCase()}.${f.format}`);
  await writeFileAtomic(out, Buffer.from(body, "utf8"));
  o.result({ ok: true, file: out, language: lang, format: f.format, cues: track.cues.length, timing: track.timing, retimedToNarration: retimed, source: from, warnings: track.warnings });
  o.line(`Wrote ${track.cues.length} ${lang} cues (${f.format.toUpperCase()}, UTF-8) to ${out}`);
  if (track.timing === "sentence-aligned") o.line("Timing: SENTENCE-ALIGNED to the narration audio (not word-aligned; cue splits inside a sentence are interpolated).");
  else if (retimed) o.warn("Timing is ESTIMATED: this language is not narrated; cues were mapped onto the narrated scene timeline by proportion.");
  else o.warn("Timing is ESTIMATED from text length; there is no narration audio for this job.");
  for (const w of track.warnings) o.line(`  warning ${w.cueId} ${w.code}: ${w.message}`);
  return ExitCode.OK;
}

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprint, resolveWithin, sha256Hex, stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { readVerifiedOutput, StepError, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import {
  CanonicalScriptSchema,
  CaptionsFileSchema,
  NarrationRecordSchema,
  SceneManifestSchema,
  StoryboardSchema,
  validateArtifact,
  type CaptionsFile,
  type CreatorFlowConfig,
  type CreatorProfile,
  type NarrationRecord,
  type SubtitleTrack,
} from "@creatorflow/schemas";
import { buildAlignedTrack, checkSubtitleTrack, retimeTrack, SCRIPT_OUTPUTS, sentences } from "@creatorflow/scriptwriter";
import { composeTimeline, type SentenceClip } from "./align.ts";
import { baseLang, chooseVoice, type VoiceProvider } from "./provider.ts";
import { voiceProviderFor } from "./registry.ts";
import { applyGain, audioStats, parseWav, speechBounds, WavError, writeWav, type PcmAudio } from "./wav.ts";

export const NARRATION_OUTPUTS = { record: "narration/narration.json", audio: "narration/voice.wav", subtitles: "narration/subtitles.json" } as const;
export const VOICE_CACHE_DIR = "cache/voice";

export interface NarrateOptions {
  /** Override provider construction (tests inject simulated providers). */
  provider?: (config: CreatorFlowConfig) => VoiceProvider;
}

export const narrateStepInputs = (ctx: FingerprintContext): unknown => ({ contentId: ctx.item.contentId });

/** Only what changes the narration: silent jobs ignore every voice setting. */
export function narrateStepConfig(ctx: FingerprintContext): unknown {
  const v = ctx.profile.voice;
  const base = { mode: v.mode, subtitles: ctx.config.localization.subtitles, fps: ctx.config.script.fps };
  if (v.mode === "none") return base;
  return { ...base, provider: ctx.config.providers.tts.id, voiceId: v.voiceId ?? null, speakingRate: v.speakingRate, pronunciations: activePronunciations(ctx.profile, null), voice: ctx.config.voice };
}

/** Provider identity, engine version and installed voices/model: a change re-generates narration. */
export function makeNarrateStepExternalInputs(opts: NarrateOptions = {}) {
  return async (ctx: FingerprintContext & { workspaceDir: string }): Promise<unknown> => {
    if (ctx.profile.voice.mode !== "tts") return null;
    const provider = (opts.provider ?? voiceProviderFor)(ctx.config);
    const h = await provider.health();
    return h.ready ? { provider: provider.id, ...h.fingerprint } : { provider: provider.id, unavailable: h.code };
  };
}

function activePronunciations(profile: CreatorProfile, language: string | null) {
  return profile.voice.glossary
    .filter((g) => g.pronunciation && (!language || !g.languages || g.languages.some((l) => l === language || baseLang(l) === baseLang(language))))
    .map((g) => ({ term: g.term, pronunciation: g.pronunciation! }))
    .sort((a, b) => b.term.length - a.term.length || (a.term < b.term ? -1 : 1));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces whole-word glossary terms with their respelling in the text sent to the engine only. */
export function applyPronunciations(text: string, prons: readonly { term: string; pronunciation: string }[], counts: Map<string, number>): string {
  let out = text;
  for (const p of prons) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(p.term)}(?![\\p{L}\\p{N}_])`, "gu");
    out = out.replace(re, () => {
      counts.set(p.term, (counts.get(p.term) ?? 0) + 1);
      return p.pronunciation;
    });
  }
  return out;
}

const ref = (p: string, body: string | Buffer) => ({ path: p, sha256: `sha256:${sha256Hex(body)}` });

/**
 * Re-times an estimated (localized) track onto a narrated timeline by mapping
 * each storyboard scene window onto the narrated scene window. The result is
 * still an estimate: only the canonical language is narrated.
 */
export function retimeToNarration(track: SubtitleTrack, storyboard: import("@creatorflow/schemas").Storyboard, narration: NarrationRecord): SubtitleTrack {
  if (narration.status !== "generated") return track;
  const fps = narration.timing.fps;
  const windows = new Map<string, { from: [number, number]; to: [number, number] }>();
  for (const sb of storyboard.scenes) {
    const nw = narration.timing.scenes.find((x) => x.sceneId === sb.sceneId);
    if (!nw) continue;
    const to: [number, number] = [Math.round((nw.startFrame * 1000) / fps), Math.round(((nw.startFrame + nw.durationInFrames) * 1000) / fps)];
    for (const seg of sb.segmentIds) windows.set(seg, { from: [Math.round(sb.startSec * 1000), Math.round((sb.startSec + sb.durationSec) * 1000)], to });
  }
  return retimeTrack(track, windows);
}

async function readJson<T>(ctx: StepContext, step: string, rel: string, schema: Parameters<typeof validateArtifact>[0], code: string): Promise<{ ok: true; value: T; raw: string; sha256: string } | { ok: false; code: string; reason: string }> {
  const r = await readVerifiedOutput(ctx, step, rel);
  if (!r.ok) return r;
  const v = validateArtifact(schema, JSON.parse(r.file.raw));
  if (!v.ok) return { ok: false, code, reason: `${rel}: ${v.issues[0]?.path}: ${v.issues[0]?.message}` };
  return { ok: true, value: v.value as T, raw: r.file.raw, sha256: r.file.sha256 };
}

export function makeNarrateStepExecute(opts: NarrateOptions = {}): (ctx: StepContext) => Promise<StepResult> {
  return async (ctx): Promise<StepResult> => {
    const script = await readJson<import("@creatorflow/schemas").CanonicalScript>(ctx, "script", SCRIPT_OUTPUTS.script, CanonicalScriptSchema, "SCRIPT_INVALID");
    const storyboard = await readJson<import("@creatorflow/schemas").Storyboard>(ctx, "script", SCRIPT_OUTPUTS.storyboard, StoryboardSchema, "STORYBOARD_INVALID");
    const manifest = await readJson<import("@creatorflow/schemas").SceneManifest>(ctx, "script", SCRIPT_OUTPUTS.manifest, SceneManifestSchema, "MANIFEST_INVALID");
    const captions = await readJson<CaptionsFile>(ctx, "script", SCRIPT_OUTPUTS.captions, CaptionsFileSchema, "CAPTIONS_INVALID");
    for (const r of [script, storyboard, manifest, captions]) if (!r.ok) return { status: "blocked", code: r.code, reason: r.reason };
    if (!script.ok || !storyboard.ok || !manifest.ok || !captions.ok) throw new Error("unreachable");
    const m = manifest.value;
    const lang = script.value.language;
    const canonical = captions.value.tracks.find((t) => t.language === lang) ?? captions.value.tracks[0]!;
    const v = ctx.profile.voice;
    const scriptRef = { path: SCRIPT_OUTPUTS.script, sha256: script.sha256 };
    const manifestRef = { path: SCRIPT_OUTPUTS.manifest, sha256: manifest.sha256 };
    const requested = { mode: v.mode, provider: v.mode === "tts" ? ctx.config.providers.tts.id : null, voiceId: v.voiceId ?? null, speakingRate: v.speakingRate, language: lang };
    const audioAbs = ctx.outputPath(NARRATION_OUTPUTS.audio);

    const writeOut = async (record: Omit<NarrationRecord, "subtitles">, subs: CaptionsFile) => {
      const sv = validateArtifact(CaptionsFileSchema, subs);
      if (!sv.ok) throw new StepError(`narration subtitles invalid: ${sv.issues[0]?.path}: ${sv.issues[0]?.message}`, { kind: "permanent", code: "SUBTITLES_INVALID" });
      const subsBody = stringifyJson(sv.value);
      const full = { ...record, subtitles: ref(NARRATION_OUTPUTS.subtitles, subsBody) };
      const rv = validateArtifact(NarrationRecordSchema, full);
      if (!rv.ok) throw new StepError(`narration record invalid: ${rv.issues[0]?.path}: ${rv.issues[0]?.message}`, { kind: "permanent", code: "NARRATION_INVALID" });
      if (ctx.signal.aborted) throw ctx.signal.reason;
      await fs.mkdir(path.dirname(ctx.outputPath(NARRATION_OUTPUTS.record)), { recursive: true });
      await writeFileAtomic(ctx.outputPath(NARRATION_OUTPUTS.subtitles), subsBody);
      await writeFileAtomic(ctx.outputPath(NARRATION_OUTPUTS.record), stringifyJson(rv.value));
    };

    // ---------------------------------------------------------------- silent
    if (v.mode === "none") {
      await fs.rm(audioAbs, { force: true }); // never let a stale voice track be picked up as an optional output
      await writeOut(
        {
          schemaVersion: 1,
          kind: "narration",
          jobId: ctx.jobId,
          contentId: m.contentId,
          script: scriptRef,
          manifest: manifestRef,
          status: "silent",
          requested,
          timing: { method: "estimated", fps: m.format.fps, durationInFrames: m.durationInFrames, durationMs: Math.round((m.durationInFrames * 1000) / m.format.fps), scenes: m.scenes.map((s) => ({ sceneId: s.sceneId, startFrame: s.startFrame, durationInFrames: s.durationInFrames })), note: "voice.mode is \"none\": the video is intentionally silent; scene and caption timing are estimated from text length" },
          segments: [],
          pronunciations: [],
          warnings: [],
        },
        { schemaVersion: 1, kind: "subtitle-tracks", contentId: m.contentId, script: scriptRef, tracks: [canonical] },
      );
      return { status: "succeeded", metadata: { status: "silent", timing: "estimated" } };
    }
    if (v.mode === "user-recorded") {
      return { status: "blocked", code: "VOICE_MODE_UNSUPPORTED", reason: 'voice.mode "user-recorded" (importing your own narration recordings) is not implemented yet. Use "tts" with a local provider, or "none" for a silent video' };
    }

    // ---------------------------------------------------------------- tts
    const providerId = ctx.config.providers.tts.id;
    if (!ctx.config.providers.tts.enabled) return { status: "blocked", code: "VOICE_PROVIDER_UNAVAILABLE", reason: `providers.tts (${providerId}) is disabled; enable it or set voice.mode to "none"` };
    let provider: VoiceProvider;
    try {
      provider = (opts.provider ?? voiceProviderFor)(ctx.config);
    } catch (e) {
      return { status: "blocked", code: "VOICE_PROVIDER_UNKNOWN", reason: (e as Error).message };
    }
    const health = await provider.health(ctx.signal);
    if (!health.ready) return { status: "blocked", code: health.code, reason: health.message };
    const caps = health.capabilities;
    const chosen = chooseVoice(caps.voices, lang, v.voiceId);
    if (!chosen.ok) return { status: "blocked", code: chosen.code, reason: `${provider.id}: ${chosen.message}` };
    const rc = caps.controls.speakingRate;
    if (v.speakingRate !== 1 && !rc.supported) return { status: "blocked", code: "VOICE_OPTION_UNSUPPORTED", reason: `${provider.id} cannot change the speaking rate (requested ${v.speakingRate}); set voice.speakingRate to 1` };
    if ((rc.min !== undefined && v.speakingRate < rc.min - 1e-9) || (rc.max !== undefined && v.speakingRate > rc.max + 1e-9)) return { status: "blocked", code: "VOICE_OPTION_UNSUPPORTED", reason: `${provider.id} supports speaking rates ${rc.min}–${rc.max}; requested ${v.speakingRate}` };
    const vc = ctx.config.voice;
    const sampleRate = caps.output.sampleRates === "any" ? vc.sampleRate : caps.output.sampleRates[0]!;
    const warnings: string[] = [];
    if (sampleRate !== vc.sampleRate) warnings.push(`${provider.id} produces ${sampleRate} Hz audio; voice.sampleRate ${vc.sampleRate} cannot be honoured (no resampling is done)`);

    // Sentences from the verified script, scene by scene. Nothing is added to the script text.
    const segText = new Map(script.value.segments.map((s) => [s.segmentId, s.narration]));
    const prons = activePronunciations(ctx.profile, lang);
    const counts = new Map<string, number>();
    type Plan = { sceneId: string; segments: { segmentId: string; sentences: { index: number; text: string; spoken: string }[] }[] };
    const plan: Plan[] = [];
    for (const s of m.scenes) {
      const segs = s.segmentIds.map((segmentId) => {
        const text = segText.get(segmentId);
        if (!text) throw new StepError(`scene ${s.sceneId} references segment ${segmentId}, which the script does not contain`, { kind: "permanent", code: "MANIFEST_INVALID" });
        return { segmentId, sentences: sentences(text, lang).map((t, index) => ({ index, text: t, spoken: applyPronunciations(t, prons, counts) })) };
      });
      plan.push({ sceneId: s.sceneId, segments: segs });
    }
    const flat = plan.flatMap((p) => p.segments.flatMap((g) => g.sentences.map((x) => ({ ...x, segmentId: g.segmentId, sceneId: p.sceneId }))));
    const tooLong = flat.find((x) => x.spoken.length > Math.min(vc.maxSentenceChars, caps.limits.maxCharsPerRequest));
    if (tooLong) throw new StepError(`a sentence in ${tooLong.segmentId} has ${tooLong.spoken.length} characters (limit ${Math.min(vc.maxSentenceChars, caps.limits.maxCharsPerRequest)}); shorten it in the plan or script`, { kind: "permanent", code: "NARRATION_TEXT_TOO_LONG" });

    // Synthesis with a content-addressed cache: unchanged sentences are not re-synthesised.
    const cacheDir = resolveWithin(ctx.workspaceDir, VOICE_CACHE_DIR);
    await fs.mkdir(cacheDir, { recursive: true });
    const keyOf = (spoken: string) => fingerprint({ provider: provider.id, engine: health.fingerprint, voice: chosen.voice.id, rate: v.speakingRate, sampleRate, spoken }).slice(7);
    const audio = new Map<string, PcmAudio>();
    const todo: { id: string; text: string; out: string; key: string }[] = [];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `cf-voice-${process.pid}-`));
    let reused = 0;
    const appliedRate = provider.describeRate(v.speakingRate);
    try {
      for (const [i, x] of flat.entries()) {
        const key = keyOf(x.spoken);
        const cached = await fs.readFile(path.join(cacheDir, `${key}.wav`)).catch(() => undefined);
        if (cached) {
          try {
            const a = parseWav(cached);
            if (a.sampleRate === sampleRate && a.samples.length > 0 && speechBounds(a)) {
              audio.set(key, a);
              reused++;
              continue;
            }
          } catch {
            // corrupt cache entry: synthesise again
          }
        }
        if (!todo.some((t) => t.key === key)) todo.push({ id: `s${i}`, text: x.spoken, out: path.join(tmp, `s-${String(i).padStart(4, "0")}.wav`), key });
      }
      if (todo.length) {
        const r = await provider.synthesize({ voice: chosen.voice, speakingRate: v.speakingRate, sampleRate, items: todo, tmpDir: tmp, signal: ctx.signal });
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (!r.ok) {
          if (r.code === "VOICE_PROVIDER_UNAVAILABLE") return { status: "blocked", code: r.code, reason: r.message };
          throw new StepError(`${provider.id}: ${r.message}`, { kind: r.retryable ? "retryable" : "permanent", code: r.code });
        }
        for (const t of todo) {
          let a: PcmAudio;
          try {
            a = parseWav(await fs.readFile(t.out));
          } catch (e) {
            throw new StepError(`${provider.id} wrote no valid audio for "${t.text.slice(0, 60)}": ${e instanceof WavError ? e.message : (e as Error).message}`, { kind: "retryable", code: "VOICE_OUTPUT_INVALID" });
          }
          if (a.sampleRate !== sampleRate) throw new StepError(`${provider.id} produced ${a.sampleRate} Hz audio, expected ${sampleRate} Hz`, { kind: "permanent", code: "VOICE_OUTPUT_INVALID" });
          // Validate before caching: silent or empty engine output must never be reused later.
          if (!speechBounds(a)) throw new StepError(`${provider.id} produced silence for "${t.text.slice(0, 60)}"`, { kind: "permanent", code: "VOICE_OUTPUT_SILENT" });
          audio.set(t.key, a);
          await writeFileAtomic(path.join(cacheDir, `${t.key}.wav`), writeWav(a.samples, a.sampleRate));
        }
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    }

    // Measure every sentence: speech must be audible; trim surrounding silence.
    const margin = Math.round(sampleRate * 0.03);
    const clipsRaw = flat.map((x) => {
      const a = audio.get(keyOf(x.spoken))!;
      const b = speechBounds(a);
      if (!b) throw new StepError(`${provider.id} produced silence for "${x.text.slice(0, 60)}" (${x.segmentId})`, { kind: "permanent", code: "VOICE_OUTPUT_SILENT" });
      const st = audioStats(a);
      if (st.clippedSamples > a.samples.length * 0.001) warnings.push(`${x.segmentId} sentence ${x.index + 1}: ${st.clippedSamples} clipped samples in the engine output`);
      const from = Math.max(0, b.start - margin);
      const to = Math.min(a.samples.length, b.end + margin * 2);
      return { x, samples: a.samples.subarray(from, to), speechStart: b.start - from, speechEnd: b.end - from };
    });
    let peak = 1;
    for (const c of clipsRaw) for (const s of c.samples) peak = Math.max(peak, Math.abs(s));
    const target = 32768 * 10 ** (vc.targetPeakDbfs / 20);
    const gain = Math.min(target / peak, 10 ** (vc.maxGainDb / 20));
    const gainDb = Math.round(20 * Math.log10(gain) * 100) / 100;
    const clips = new Map<string, SentenceClip[]>();
    for (const c of clipsRaw) {
      const list = clips.get(c.x.segmentId) ?? [];
      list.push({ segmentId: c.x.segmentId, sceneId: c.x.sceneId, index: c.x.index, text: c.x.text, ...(c.x.spoken !== c.x.text ? { spoken: c.x.spoken } : {}), samples: applyGain(c.samples, gain), speechStart: c.speechStart, speechEnd: c.speechEnd });
      clips.set(c.x.segmentId, list);
    }
    const tl = composeTimeline(
      plan.map((p) => ({ sceneId: p.sceneId, segments: p.segments.map((g) => ({ segmentId: g.segmentId, clips: clips.get(g.segmentId) ?? [] })) })),
      { sampleRate, fps: m.format.fps, leadInMs: vc.leadInMs, sceneLeadMs: Math.min(150, vc.leadInMs), sentencePauseMs: vc.sentencePauseMs, segmentPauseMs: vc.segmentPauseMs, tailMs: vc.tailMs, minSceneMs: vc.minSceneMs, captionHoldMs: 600 },
    );
    if (tl.durationMs > vc.maxTotalSec * 1000) throw new StepError(`narration is ${(tl.durationMs / 1000).toFixed(1)} s, above voice.maxTotalSec ${vc.maxTotalSec}`, { kind: "permanent", code: "NARRATION_TOO_LONG" });

    // Captions from measured speech. Cue ids and texts must equal the estimated track's.
    const aligned = buildAlignedTrack(
      canonical.language,
      "canonical",
      tl.segments.flatMap((s) => s.sentences.map((x) => ({ segmentId: x.segmentId, sceneId: x.sceneId, text: x.text, speechStartMs: x.speechStartMs, speechEndMs: x.speechEndMs, displayEndMs: x.displayEndMs }))),
      ctx.config.localization.subtitles,
    );
    const same = aligned.cues.length === canonical.cues.length && aligned.cues.every((c, i) => c.cueId === canonical.cues[i]!.cueId && c.segmentId === canonical.cues[i]!.segmentId && c.lines.join("\n") === canonical.cues[i]!.lines.join("\n"));
    if (!same) throw new StepError("sentence-aligned captions do not match the script's caption cues (segmentation mismatch)", { kind: "permanent", code: "CAPTION_ALIGNMENT_MISMATCH" });
    const problems = [...checkSubtitleTrack(aligned), ...aligned.cues.filter((c) => c.endMs > tl.durationMs).map((c) => `${c.cueId} ends after the audio`)];
    if (problems.length) throw new StepError(`aligned captions invalid: ${problems.join("; ")}`, { kind: "permanent", code: "CAPTIONS_INVALID" });

    // Write and re-measure the final track.
    const wav = writeWav(tl.samples, sampleRate);
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await fs.mkdir(path.dirname(audioAbs), { recursive: true });
    await writeFileAtomic(audioAbs, wav);
    const back = parseWav(await fs.readFile(audioAbs));
    const st = audioStats(back);
    if (back.samples.length !== tl.samples.length) throw new StepError("narration audio changed while writing", { kind: "retryable", code: "VOICE_OUTPUT_INVALID" });
    const prov = { id: provider.id, version: `${caps.adapterVersion} (${caps.engineVersion})`, engine: caps.displayName, offline: true as const, voice: { id: chosen.voice.id, name: chosen.voice.name, language: chosen.voice.language, ...(chosen.voice.gender ? { gender: chosen.voice.gender } : {}) }, license: { engine: caps.license.engine, voice: caps.license.voices, notes: caps.license.notes } };
    await writeOut(
      {
        schemaVersion: 1,
        kind: "narration",
        jobId: ctx.jobId,
        contentId: m.contentId,
        script: scriptRef,
        manifest: manifestRef,
        status: "generated",
        requested,
        provider: prov,
        settings: { speakingRate: { requested: v.speakingRate, applied: appliedRate }, sampleRate, channels: 1, bitsPerSample: 16, sentencePauseMs: vc.sentencePauseMs, segmentPauseMs: vc.segmentPauseMs, leadInMs: vc.leadInMs, tailMs: vc.tailMs, gainDb },
        audio: { path: NARRATION_OUTPUTS.audio, sha256: `sha256:${sha256Hex(wav)}`, bytes: wav.length, format: "wav-pcm-s16le", sampleRate, channels: 1, durationMs: st.durationMs, peakDbfs: st.peakDbfs, rmsDbfs: st.rmsDbfs, clippedSamples: st.clippedSamples },
        timing: {
          method: "sentence-aligned",
          fps: m.format.fps,
          durationInFrames: tl.durationInFrames,
          durationMs: tl.durationMs,
          scenes: tl.scenes.map((s) => ({ sceneId: s.sceneId, startFrame: s.startFrame, durationInFrames: s.durationInFrames })),
          note: "Each sentence was synthesised separately and placed on the frame grid; sentence start/end are measured from the audio energy. Cue boundaries inside a multi-cue sentence are interpolated by text length. Not word-aligned. Localized subtitle tracks are not narrated; `subtitles export` re-times them onto this timeline as estimates.",
        },
        segments: tl.segments.map((s) => ({ segmentId: s.segmentId, sceneId: s.sceneId, startMs: s.startMs, endMs: Math.max(s.startMs + 1, s.endMs), sentences: s.sentences.map(({ displayEndMs: _d, segmentId: _s, sceneId: _c, ...x }) => x) })),
        pronunciations: prons.map((p) => ({ ...p, occurrences: counts.get(p.term) ?? 0 })).filter((p) => p.occurrences > 0),
        warnings,
      },
      { schemaVersion: 1, kind: "subtitle-tracks", contentId: m.contentId, script: scriptRef, tracks: [aligned] },
    );
    return { status: "succeeded", metadata: { status: "generated", provider: provider.id, voice: chosen.voice.name, sentences: flat.length, synthesized: todo.length, reusedFromCache: reused, durationMs: tl.durationMs, frames: tl.durationInFrames, timing: "sentence-aligned" } };
  };
}


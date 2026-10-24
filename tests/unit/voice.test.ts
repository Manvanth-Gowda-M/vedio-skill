// Unit tests for packages/voice: WAV handling, measurements, timeline composition, aligned captions,
// provider contract and the "unavailable" providers. No real TTS engine runs here (see narration-real).
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreatorFlowConfigSchema, SubtitleTrackSchema } from "@creatorflow/schemas";
import { buildAlignedTrack, buildSubtitleTrack, checkSubtitleTrack, retimeTrack, toVtt } from "@creatorflow/scriptwriter";
import {
  applyGain,
  applyPronunciations,
  audioStats,
  chooseVoice,
  composeTimeline,
  NoVoiceProvider,
  parseWav,
  PiperProvider,
  piperLanguage,
  sapiRate,
  speechBounds,
  voiceProviderFor,
  WavError,
  WindowsSapiProvider,
  windowRmsDbfs,
  writeWav,
  type SentenceClip,
  type VoiceProvider,
} from "@creatorflow/voice";
import { makeTempDir } from "../helpers.ts";

const config = (over: Record<string, unknown> = {}) => CreatorFlowConfigSchema.parse({ schemaVersion: 1, ...over });
const SR = 16000;
/** Silence, then a tone burst, then silence. */
function burst(silenceMs: number, toneMs: number, tailMs: number, amp = 0.4): Int16Array {
  const n = (ms: number) => Math.round((ms * SR) / 1000);
  const s = new Int16Array(n(silenceMs) + n(toneMs) + n(tailMs));
  for (let i = 0; i < n(toneMs); i++) s[n(silenceMs) + i] = Math.round(Math.sin((2 * Math.PI * 300 * i) / SR) * amp * 32767);
  return s;
}

describe("WAV parsing and writing", () => {
  it("round-trips 16-bit mono PCM and averages stereo input", () => {
    const s = burst(10, 50, 10);
    const a = parseWav(writeWav(s, SR));
    expect(a).toMatchObject({ sampleRate: SR, channels: 1, bitsPerSample: 16 });
    expect(Array.from(a.samples)).toEqual(Array.from(s));
    // Hand-built stereo file: L=1000, R=3000 -> mono 2000.
    const st = Buffer.alloc(44 + 8);
    st.write("RIFF", 0, "latin1");
    st.writeUInt32LE(44, 4);
    st.write("WAVEfmt ", 8, "latin1");
    st.writeUInt32LE(16, 16);
    st.writeUInt16LE(1, 20);
    st.writeUInt16LE(2, 22);
    st.writeUInt32LE(SR, 24);
    st.writeUInt32LE(SR * 4, 28);
    st.writeUInt16LE(4, 32);
    st.writeUInt16LE(16, 34);
    st.write("data", 36, "latin1");
    st.writeUInt32LE(8, 40);
    st.writeInt16LE(1000, 44);
    st.writeInt16LE(3000, 46);
    st.writeInt16LE(1000, 48);
    st.writeInt16LE(3000, 50);
    expect(Array.from(parseWav(st).samples)).toEqual([2000, 2000]);
  });

  it.each([
    ["too short", Buffer.from("RIFF")],
    ["not RIFF", Buffer.alloc(64, 1)],
    ["8-bit PCM", (() => { const b = writeWav(new Int16Array(4), SR); b.writeUInt16LE(8, 34); return b; })()],
    ["float encoding", (() => { const b = writeWav(new Int16Array(4), SR); b.writeUInt16LE(3, 20); return b; })()],
    ["missing data chunk", writeWav(new Int16Array(0), SR).subarray(0, 36)],
  ])("rejects %s with a typed error", (_l, buf) => {
    expect(() => parseWav(buf as Buffer)).toThrow(WavError);
  });

  it("measures peak, RMS and clipping; finds speech boundaries; gain saturates", () => {
    const s = burst(200, 400, 300);
    const a = { samples: s, sampleRate: SR };
    const st = audioStats(a);
    expect(st.durationMs).toBe(900);
    expect(st.peakDbfs).toBeCloseTo(20 * Math.log10(0.4), 0);
    expect(st.clippedSamples).toBe(0);
    const b = speechBounds(a)!;
    expect(b.start / SR).toBeCloseTo(0.2, 1);
    expect(b.end / SR).toBeCloseTo(0.6, 1);
    expect(speechBounds({ samples: new Int16Array(SR), sampleRate: SR })).toBeUndefined();
    expect(windowRmsDbfs(a, 250, 550)).toBeGreaterThan(-15);
    expect(windowRmsDbfs(a, 650, 850)).toBe(-120);
    const loud = applyGain(s, 10);
    expect(audioStats({ samples: loud, sampleRate: SR }).clippedSamples).toBeGreaterThan(0);
    expect(Math.max(...Array.from(loud))).toBe(32767);
  });
});

describe("narrated timeline and sentence-aligned captions", () => {
  const clip = (segmentId: string, sceneId: string, index: number, text: string, ms: number): SentenceClip => {
    const samples = burst(30, ms, 60);
    const b = speechBounds({ samples, sampleRate: SR })!;
    return { segmentId, sceneId, index, text, samples, speechStart: b.start, speechEnd: b.end };
  };
  const opts = { sampleRate: SR, fps: 30, leadInMs: 200, sceneLeadMs: 150, sentencePauseMs: 250, segmentPauseMs: 450, tailMs: 700, minSceneMs: 1500, captionHoldMs: 600 };

  it("places sentences on the frame grid: scenes are contiguous, speech lies inside them, audio length == video length", () => {
    const scenes = [
      { sceneId: "scn-01", segments: [{ segmentId: "seg-01-hook", clips: [clip("seg-01-hook", "scn-01", 0, "Short hook.", 600)] }] },
      { sceneId: "scn-02", segments: [{ segmentId: "seg-02-explanation", clips: [clip("seg-02-explanation", "scn-02", 0, "First sentence here.", 1200), clip("seg-02-explanation", "scn-02", 1, "Second one.", 800)] }] },
    ];
    const tl = composeTimeline(scenes, opts);
    expect(tl.scenes[0]!.startFrame).toBe(0);
    expect(tl.scenes[1]!.startFrame).toBe(tl.scenes[0]!.durationInFrames);
    expect(tl.durationInFrames).toBe(tl.scenes[0]!.durationInFrames + tl.scenes[1]!.durationInFrames);
    expect(tl.samples.length).toBe(Math.round((tl.durationInFrames * SR) / 30));
    expect(tl.durationMs).toBe(Math.round((tl.durationInFrames * 1000) / 30));
    expect(tl.scenes[0]!.endMs - tl.scenes[0]!.startMs).toBeGreaterThanOrEqual(1500); // minSceneMs
    const all = tl.segments.flatMap((s) => s.sentences);
    for (let i = 0; i < all.length; i++) {
      const s = all[i]!;
      const scene = tl.scenes.find((x) => x.sceneId === s.sceneId)!;
      expect(s.speechStartMs).toBeGreaterThanOrEqual(scene.startMs);
      expect(s.speechEndMs).toBeLessThanOrEqual(scene.endMs);
      expect(s.startMs <= s.speechStartMs && s.speechStartMs < s.speechEndMs && s.speechEndMs <= s.endMs).toBe(true);
      if (i > 0) expect(s.startMs).toBeGreaterThanOrEqual(all[i - 1]!.endMs);
      expect(s.displayEndMs).toBeLessThanOrEqual(all[i + 1]?.speechStartMs ?? tl.durationMs);
    }
    // Speech energy is really where the timeline says it is.
    for (const s of all) expect(windowRmsDbfs({ samples: tl.samples, sampleRate: SR }, s.speechStartMs, s.speechEndMs)).toBeGreaterThan(-20);
    expect(windowRmsDbfs({ samples: tl.samples, sampleRate: SR }, 0, 150)).toBe(-120);
  });

  it("aligned tracks have the same cue ids and text as the estimated track; only times differ", () => {
    const subs = { maxCharsPerLine: 42, maxLines: 2, maxCps: 17, minCueMs: 1000 };
    const text = "Hooks run shell commands at lifecycle events of the agent, before and after every tool call. They are configured in a file.";
    const est = buildSubtitleTrack("en", "canonical", [{ segmentId: "seg-01-hook", sceneId: "scn-01", text, startMs: 0, endMs: 9000 }], subs);
    const al = buildAlignedTrack("en", "canonical", [
      { segmentId: "seg-01-hook", sceneId: "scn-01", text: "Hooks run shell commands at lifecycle events of the agent, before and after every tool call.", speechStartMs: 230, speechEndMs: 5100, displayEndMs: 5400 },
      { segmentId: "seg-01-hook", sceneId: "scn-01", text: "They are configured in a file.", speechStartMs: 5400, speechEndMs: 6900, displayEndMs: 7500 },
    ], subs);
    expect(al.timing).toBe("sentence-aligned");
    expect(al.cues.map((c) => [c.cueId, c.lines])).toEqual(est.cues.map((c) => [c.cueId, c.lines]));
    expect(al.cues[0]!.startMs).toBe(230);
    expect(al.cues.at(-1)!.startMs).toBe(5400);
    expect(al.cues.at(-1)!.endMs).toBe(7500);
    expect(checkSubtitleTrack(al)).toEqual([]);
    expect(SubtitleTrackSchema.safeParse(al).success).toBe(true);
    expect(toVtt(al)).toContain("Timing: sentence-aligned to the narration audio");
    expect(toVtt(al)).toContain("not word-aligned");
  });

  it("re-times an estimated localized track onto narrated scene windows and keeps it 'estimated'", () => {
    const subs = { maxCharsPerLine: 42, maxLines: 2, maxCps: 17, minCueMs: 1000 };
    const t = buildSubtitleTrack("hi", "localized", [
      { segmentId: "seg-01-hook", text: "पहला वाक्य। दूसरा वाक्य।", startMs: 0, endMs: 2000 },
      { segmentId: "seg-02-explanation", text: "तीसरा वाक्य।", startMs: 2000, endMs: 4000 },
    ], subs);
    const r = retimeTrack(t, new Map([["seg-01-hook", { from: [0, 2000], to: [0, 3000] }], ["seg-02-explanation", { from: [2000, 4000], to: [3000, 7000] }]]));
    expect(r.timing).toBe("estimated");
    expect(r.cues.map((c) => c.lines)).toEqual(t.cues.map((c) => c.lines));
    expect(r.cues.at(-1)!.endMs).toBe(7000);
    expect(checkSubtitleTrack(r)).toEqual([]);
  });

  it("glossary pronunciations change only the spoken text, at word boundaries", () => {
    const counts = new Map<string, number>();
    const out = applyPronunciations("Use npm and npmrc with MCP.", [{ term: "npm", pronunciation: "N P M" }, { term: "MCP", pronunciation: "M C P" }], counts);
    expect(out).toBe("Use N P M and npmrc with M C P.");
    expect(Object.fromEntries(counts)).toEqual({ npm: 1, MCP: 1 });
  });
});

describe("voice provider contract", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => (tmp = await makeTempDir("cf-voice-unit-")));
  afterEach(() => tmp.cleanup());

  it("'none' is a typed VOICE_PROVIDER_UNAVAILABLE for every call", async () => {
    const p: VoiceProvider = new NoVoiceProvider();
    expect(await p.health()).toMatchObject({ ready: false, code: "VOICE_PROVIDER_UNAVAILABLE" });
    expect(await p.synthesize({} as never)).toMatchObject({ ok: false, code: "VOICE_PROVIDER_UNAVAILABLE", retryable: false });
  });

  it("the registry maps ids to adapters and rejects unknown ids", () => {
    expect(voiceProviderFor(config()).id).toBe("none");
    expect(voiceProviderFor(config({ providers: { tts: { id: "windows-sapi" } } })).id).toBe("windows-sapi");
    expect(voiceProviderFor(config({ providers: { tts: { id: "piper" } } })).id).toBe("piper");
    expect(() => voiceProviderFor(config({ providers: { tts: { id: "eleven-something" } } }))).toThrow(/not a known voice provider/);
  });

  it("windows-sapi reports unavailable off Windows, without starting anything", async () => {
    const h = await new WindowsSapiProvider(config(), { platform: "linux" }).health();
    expect(h).toMatchObject({ ready: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: expect.stringContaining("needs Windows") });
  });

  it("windows-sapi reports unavailable when PowerShell cannot be started", async () => {
    const h = await new WindowsSapiProvider(config({ voice: { windowsSapi: { powershell: path.join(tmp.dir, "no-powershell.exe") } } }), { platform: "win32" }).health();
    expect(h).toMatchObject({ ready: false, code: "VOICE_PROVIDER_UNAVAILABLE" });
  });

  it("piper: missing executable, missing model, missing model config -> unavailable with the reason; never downloads", async () => {
    expect(await new PiperProvider(config({ providers: { tts: { id: "piper" } } })).health()).toMatchObject({ ready: false, message: expect.stringContaining("voice.piper.executable is not set") });
    const exe = path.join(tmp.dir, "piper.exe");
    expect(await new PiperProvider(config({ voice: { piper: { executable: exe } } })).health()).toMatchObject({ ready: false, message: expect.stringContaining("voice.piper.model is not set") });
    const model = path.join(tmp.dir, "en_US-test-medium.onnx");
    expect(await new PiperProvider(config({ voice: { piper: { executable: exe, model } } })).health()).toMatchObject({ ready: false, message: expect.stringContaining("was not found") });
    await fs.writeFile(exe, "not really an exe");
    await fs.writeFile(model, "x");
    expect(await new PiperProvider(config({ voice: { piper: { executable: exe, model } } })).health()).toMatchObject({ ready: false, message: expect.stringContaining(".onnx.json is missing") });
    await fs.writeFile(`${model}.json`, JSON.stringify({ audio: { sample_rate: 22050 }, language: { code: "en_US" } }));
    // The "binary" is not executable: still a typed unavailable, not a crash.
    expect(await new PiperProvider(config({ voice: { piper: { executable: exe, model } } })).health()).toMatchObject({ ready: false, code: "VOICE_PROVIDER_UNAVAILABLE" });
    expect(piperLanguage({ language: { code: "hi_IN" } })).toBe("hi-IN");
    expect(piperLanguage({ espeak: { voice: "en-us" } })).toBe("en-US");
  });

  it("voice selection never silently swaps a requested voice or language", () => {
    const voices = [{ id: "z", name: "Zira", language: "en-US" }, { id: "d", name: "David", language: "en-US" }, { id: "h", name: "Heera", language: "en-IN" }];
    expect(chooseVoice(voices, "en")).toMatchObject({ ok: true, voice: { name: "David" } });
    expect(chooseVoice(voices, "en-IN")).toMatchObject({ ok: true, voice: { name: "Heera" } });
    expect(chooseVoice(voices, "en", "zira")).toMatchObject({ ok: true, voice: { id: "z" } });
    expect(chooseVoice(voices, "en", "Nope")).toMatchObject({ ok: false, code: "VOICE_NOT_FOUND" });
    expect(chooseVoice(voices, "hi")).toMatchObject({ ok: false, code: "VOICE_LANGUAGE_UNSUPPORTED" });
    expect(chooseVoice(voices, "hi", "Zira")).toMatchObject({ ok: false, code: "VOICE_LANGUAGE_UNSUPPORTED" });
  });

  it("speaking-rate mappings are explicit (SAPI integer rate, Piper length_scale)", () => {
    expect([0.5, 1, 1.25, 2, 3, 5].map(sapiRate)).toEqual([-6, 0, 2, 6, 10, 10]);
    expect(new WindowsSapiProvider(config()).describeRate(1.25)).toMatch(/SAPI Rate 2 \(about 1\.25x; requested 1\.25\)/);
    expect(new PiperProvider(config()).describeRate(1.25)).toBe("length_scale 0.8 (requested 1.25)");
  });
});

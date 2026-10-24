/**
 * Builds the narrated timeline: places each sentence's measured speech on the
 * video frame grid, scene by scene, and returns the composed PCM track plus
 * exact sentence and scene times. Pure and deterministic.
 */

export interface SentenceClip {
  segmentId: string;
  sceneId: string;
  index: number;
  text: string;
  spoken?: string;
  /** Trimmed audio (speech plus small margins), already gain-adjusted. */
  samples: Int16Array;
  /** Speech inside `samples`, in samples. */
  speechStart: number;
  speechEnd: number;
}

export interface TimelineOptions {
  sampleRate: number;
  fps: number;
  leadInMs: number;
  /** Lead at the start of every later scene, so the scene's fade-in never hides speech. */
  sceneLeadMs: number;
  sentencePauseMs: number;
  segmentPauseMs: number;
  tailMs: number;
  minSceneMs: number;
  /** How long a caption may stay after its sentence ends (bounded by the next sentence). */
  captionHoldMs: number;
}

export interface PlacedSentence {
  segmentId: string;
  sceneId: string;
  index: number;
  text: string;
  spoken?: string;
  startMs: number;
  endMs: number;
  speechStartMs: number;
  speechEndMs: number;
  displayEndMs: number;
}

export interface Timeline {
  samples: Int16Array;
  durationInFrames: number;
  durationMs: number;
  scenes: { sceneId: string; startFrame: number; durationInFrames: number; startMs: number; endMs: number }[];
  segments: { segmentId: string; sceneId: string; startMs: number; endMs: number; sentences: PlacedSentence[] }[];
}

/** `scenes` in manifest order; each lists its segments, each segment its sentence clips in order. */
export function composeTimeline(scenes: readonly { sceneId: string; segments: readonly { segmentId: string; clips: readonly SentenceClip[] }[] }[], o: TimelineOptions): Timeline {
  const sr = o.sampleRate;
  const ms = (m: number) => Math.round((m * sr) / 1000);
  const toMs = (s: number) => Math.round((s * 1000) / sr);
  const frameToSample = (f: number) => Math.round((f * sr) / o.fps);
  const placements: { at: number; clip: SentenceClip }[] = [];
  const outScenes: Timeline["scenes"] = [];
  const outSegments: Timeline["segments"] = [];
  let frame = 0;
  scenes.forEach((scene, k) => {
    const startFrame = frame;
    const s0 = frameToSample(startFrame);
    let pos = s0 + ms(k === 0 ? o.leadInMs : o.sceneLeadMs);
    scene.segments.forEach((seg, si) => {
      const segStart = pos;
      const placed: PlacedSentence[] = [];
      seg.clips.forEach((c, j) => {
        placements.push({ at: pos, clip: c });
        placed.push({ segmentId: seg.segmentId, sceneId: scene.sceneId, index: c.index, text: c.text, ...(c.spoken ? { spoken: c.spoken } : {}), startMs: toMs(pos), endMs: toMs(pos + c.samples.length), speechStartMs: toMs(pos + c.speechStart), speechEndMs: toMs(pos + c.speechEnd), displayEndMs: 0 });
        pos += c.samples.length + (j < seg.clips.length - 1 ? ms(o.sentencePauseMs) : 0);
      });
      outSegments.push({ segmentId: seg.segmentId, sceneId: scene.sceneId, startMs: toMs(segStart), endMs: toMs(pos), sentences: placed });
      if (si < scene.segments.length - 1) pos += ms(o.segmentPauseMs);
    });
    const last = k === scenes.length - 1;
    const end = Math.max(pos + ms(last ? o.tailMs : o.segmentPauseMs), s0 + ms(o.minSceneMs));
    const endFrame = Math.max(startFrame + 1, Math.ceil((end * o.fps) / sr));
    outScenes.push({ sceneId: scene.sceneId, startFrame, durationInFrames: endFrame - startFrame, startMs: toMs(s0), endMs: toMs(frameToSample(endFrame)) });
    frame = endFrame;
  });
  const total = frameToSample(frame);
  const samples = new Int16Array(total);
  for (const p of placements) samples.set(p.clip.samples.subarray(0, Math.max(0, total - p.at)), p.at);
  const durationMs = Math.round((frame * 1000) / o.fps);
  const all = outSegments.flatMap((s) => s.sentences);
  all.forEach((s, i) => {
    const next = all[i + 1];
    s.displayEndMs = Math.min(next ? next.speechStartMs : durationMs, s.speechEndMs + o.captionHoldMs);
  });
  return { samples, durationInFrames: frame, durationMs, scenes: outScenes, segments: outSegments };
}

import type { SubtitleCue, SubtitleTrack } from "@creatorflow/schemas";
import { graphemeLength, preservesText, sentences, wrapText } from "./text.ts";

export interface SubtitleOptions {
  maxCharsPerLine: number;
  maxLines: number;
  maxCps: number;
  minCueMs: number;
}

export interface TimedText {
  segmentId: string;
  sceneId?: string;
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Builds a subtitle track from timed segment texts. Cues never cross a
 * segment boundary, break at sentence ends where possible, wrap at word
 * boundaries (grapheme-measured), and never drop or shorten text. Durations
 * inside a segment are split in proportion to cue length. Timing is an
 * estimate: there is no audio to align against.
 */
export function buildSubtitleTrack(language: string, source: "canonical" | "localized", items: readonly TimedText[], opts: SubtitleOptions): SubtitleTrack {
  const tag = language.toLowerCase();
  const cues: SubtitleCue[] = [];
  const warnings: SubtitleTrack["warnings"] = [];
  let lastEnd = 0;
  for (const item of items) {
    const blocks: string[][] = [];
    let overlong = false;
    for (const sentence of sentences(item.text, language)) {
      const w = wrapText(sentence, language, opts.maxCharsPerLine);
      overlong ||= w.overlong;
      for (let i = 0; i < w.lines.length; i += opts.maxLines) blocks.push(w.lines.slice(i, i + opts.maxLines));
    }
    if (blocks.length === 0) continue;
    if (!preservesText(item.text, blocks.flat())) throw new Error(`subtitle wrapping changed the text of ${item.segmentId}`);
    const start = Math.max(item.startMs, lastEnd);
    const window = Math.max(blocks.length, item.endMs - start);
    const weights = blocks.map((b) => graphemeLength(b.join(" ")));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = start;
    let acc = 0;
    blocks.forEach((lines, i) => {
      acc += weights[i]!;
      const end = i === blocks.length - 1 ? start + window : Math.max(t + 1, start + Math.round((window * acc) / total));
      const cueId = `cue-${tag}-${String(cues.length + 1).padStart(4, "0")}`;
      cues.push({ cueId, index: cues.length + 1, startMs: t, endMs: end, lines, segmentId: item.segmentId, ...(item.sceneId ? { sceneId: item.sceneId } : {}) });
      const dur = end - t;
      const cps = weights[i]! / (dur / 1000);
      if (cps > opts.maxCps) warnings.push({ cueId, code: "READING_SPEED", message: `${cps.toFixed(1)} characters/second exceeds ${opts.maxCps}` });
      if (dur < opts.minCueMs) warnings.push({ cueId, code: "CUE_TOO_SHORT", message: `${dur} ms is shorter than ${opts.minCueMs} ms` });
      if (overlong && lines.some((l) => graphemeLength(l) > opts.maxCharsPerLine)) warnings.push({ cueId, code: "LINE_TOO_LONG", message: `a single word is longer than ${opts.maxCharsPerLine} characters` });
      t = end;
    });
    lastEnd = t;
  }
  return { language, timing: "estimated", source, cues, warnings };
}

/** One narrated sentence with its measured speech window in the final timeline. */
export interface AlignedSentence {
  segmentId: string;
  sceneId?: string;
  text: string;
  speechStartMs: number;
  speechEndMs: number;
  /** Latest time the cue may stay on screen (next sentence's speech start or the hold limit). */
  displayEndMs: number;
}

/**
 * Sentence-aligned captions. Sentences are wrapped exactly like
 * buildSubtitleTrack (same sentence segmentation, wrapping and line grouping),
 * so cue ids and texts are identical to the estimated track for the same
 * script; only the times differ. A sentence's cues span its measured speech;
 * when a sentence needs several cues they share that span in proportion to
 * their length (this part is interpolated, not word-aligned).
 */
export function buildAlignedTrack(language: string, source: "canonical" | "localized", items: readonly AlignedSentence[], opts: SubtitleOptions): SubtitleTrack {
  const tag = language.toLowerCase();
  const cues: SubtitleCue[] = [];
  const warnings: SubtitleTrack["warnings"] = [];
  let lastEnd = 0;
  for (const item of items) {
    const blocks: string[][] = [];
    let overlong = false;
    for (const sentence of sentences(item.text, language)) {
      const w = wrapText(sentence, language, opts.maxCharsPerLine);
      overlong ||= w.overlong;
      for (let i = 0; i < w.lines.length; i += opts.maxLines) blocks.push(w.lines.slice(i, i + opts.maxLines));
    }
    if (!blocks.length) continue;
    if (!preservesText(item.text, blocks.flat())) throw new Error(`subtitle wrapping changed the text of ${item.segmentId}`);
    const start = Math.max(item.speechStartMs, lastEnd);
    const speechEnd = Math.max(start + blocks.length, item.speechEndMs);
    const end = Math.max(speechEnd, item.displayEndMs);
    const weights = blocks.map((b) => graphemeLength(b.join(" ")));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = start;
    let acc = 0;
    blocks.forEach((lines, i) => {
      acc += weights[i]!;
      const cueEnd = i === blocks.length - 1 ? end : Math.max(t + 1, start + Math.round(((speechEnd - start) * acc) / total));
      const cueId = `cue-${tag}-${String(cues.length + 1).padStart(4, "0")}`;
      cues.push({ cueId, index: cues.length + 1, startMs: t, endMs: cueEnd, lines, segmentId: item.segmentId, ...(item.sceneId ? { sceneId: item.sceneId } : {}) });
      const dur = cueEnd - t;
      const cps = weights[i]! / (dur / 1000);
      if (cps > opts.maxCps) warnings.push({ cueId, code: "READING_SPEED", message: `${cps.toFixed(1)} characters/second exceeds ${opts.maxCps}` });
      if (dur < opts.minCueMs) warnings.push({ cueId, code: "CUE_TOO_SHORT", message: `${dur} ms is shorter than ${opts.minCueMs} ms` });
      if (overlong && lines.some((l) => graphemeLength(l) > opts.maxCharsPerLine)) warnings.push({ cueId, code: "LINE_TOO_LONG", message: `a single word is longer than ${opts.maxCharsPerLine} characters` });
      t = cueEnd;
    });
    lastEnd = t;
  }
  return { language, timing: "sentence-aligned", source, cues, warnings };
}

/**
 * Moves an estimated track onto a new timeline by mapping each segment's old
 * window linearly onto its new window (used for localized tracks when the
 * narrated canonical audio changed the scene lengths). Timing stays "estimated".
 */
export function retimeTrack(track: SubtitleTrack, windows: ReadonlyMap<string, { from: [number, number]; to: [number, number] }>): SubtitleTrack {
  let last = 0;
  const cues = track.cues.map((c) => {
    const w = windows.get(c.segmentId);
    const map = (ms: number) => {
      if (!w) return ms;
      const [a, b] = w.from;
      const [x, y] = w.to;
      return Math.round(x + ((ms - a) * (y - x)) / Math.max(1, b - a));
    };
    const startMs = Math.max(last, map(c.startMs));
    const endMs = Math.max(startMs + 1, map(c.endMs));
    last = endMs;
    return { ...c, startMs, endMs };
  });
  return { ...track, timing: "estimated", cues };
}

/** Independent checks used on stored tracks (ordering, overlaps, positive durations, text). */
export function checkSubtitleTrack(track: SubtitleTrack): string[] {
  const problems: string[] = [];
  track.cues.forEach((c, i) => {
    if (c.index !== i + 1) problems.push(`${c.cueId}: index ${c.index}, expected ${i + 1}`);
    if (c.endMs <= c.startMs) problems.push(`${c.cueId}: non-positive duration`);
    const prev = track.cues[i - 1];
    if (prev && c.startMs < prev.endMs) problems.push(`${c.cueId}: overlaps ${prev.cueId}`);
    if (c.lines.some((l) => l.includes("-->"))) problems.push(`${c.cueId}: contains "-->", which breaks SRT/WebVTT`);
  });
  return problems;
}

function stamp(ms: number, sep: "," | "."): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(r).padStart(3, "0")}`;
}

export class SubtitleExportError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Subtitle track is not exportable: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** SubRip. UTF-8, LF line endings. SRT has no comment syntax, so the "estimated" label lives in the caller's output. */
export function toSrt(track: SubtitleTrack): string {
  const problems = checkSubtitleTrack(track);
  if (problems.length) throw new SubtitleExportError(problems);
  return track.cues.map((c) => `${c.index}\n${stamp(c.startMs, ",")} --> ${stamp(c.endMs, ",")}\n${c.lines.join("\n")}\n`).join("\n");
}

const vttEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** WebVTT with a NOTE stating how the timing was obtained. */
export function toVtt(track: SubtitleTrack): string {
  const problems = checkSubtitleTrack(track);
  if (problems.length) throw new SubtitleExportError(problems);
  const how =
    track.timing === "sentence-aligned"
      ? "sentence-aligned to the narration audio (cue boundaries inside a sentence are interpolated by text length; not word-aligned)."
      : track.timing === "word-aligned"
        ? "word-aligned to the narration audio."
        : "estimated from text length (no narration audio); re-align after voice-over.";
  const head = `WEBVTT\n\nNOTE\nLanguage: ${track.language}\nTiming: ${how}\n`;
  const body = track.cues.map((c) => `${c.cueId}\n${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${c.lines.map(vttEscape).join("\n")}\n`).join("\n");
  return `${head}\n${body}`;
}

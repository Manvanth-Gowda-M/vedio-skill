/**
 * Pure, deterministic media measurements used by the QA step. Everything here
 * works on decoded pixels/samples and is unit-tested with synthetic inputs.
 * These are measurements with known blind spots, not a judgement of quality.
 */
import type { RgbImage } from "./png.ts";

export type Rgb = [number, number, number];

export const hexToRgb = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const dist = (r: number, g: number, b: number, c: Rgb) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]);
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** WCAG relative luminance of an 8-bit grey level / colour. */
export function relLum(r: number, g = r, b = r): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export const contrastOf = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// ------------------------------------------------------------------ frame sampling plan

export interface SceneSpan {
  sceneId: string;
  startFrame: number;
  durationInFrames: number;
}
export interface CueSpan {
  cueId: string;
  startFrame: number;
  endFrame: number;
}
export interface PlannedSample {
  frame: number;
  sceneId: string;
  purpose: "start" | "middle" | "end" | "scene-mid" | "scene-start" | "interval";
  blankAllowed: boolean;
  activeCueId: string | null;
}

/** Frames inside entrance (first 12) or exit-fade (last 6, except the final scene) windows. */
export function inAnimationWindow(frame: number, scenes: readonly SceneSpan[]): boolean {
  const i = scenes.findIndex((s) => frame >= s.startFrame && frame < s.startFrame + s.durationInFrames);
  if (i < 0) return true;
  const s = scenes[i]!;
  return frame - s.startFrame < 12 || (i < scenes.length - 1 && s.startFrame + s.durationInFrames - frame <= 6);
}

/**
 * Deterministic sample frames: first, middle and last frame, one frame 60% into
 * every scene (entrance animations done), one shortly after every scene
 * boundary, and one every `everySec`. Capped at `max`, keeping the mandatory
 * samples. Frames in animation windows may legitimately be blank.
 */
export function planSamples(scenes: readonly SceneSpan[], totalFrames: number, fps: number, cues: readonly CueSpan[], o: { everySec: number; max: number }): PlannedSample[] {
  const sceneOf = (f: number) => scenes.find((s) => f >= s.startFrame && f < s.startFrame + s.durationInFrames)?.sceneId ?? scenes.at(-1)!.sceneId;
  const cueAt = (f: number) => cues.find((c) => f >= c.startFrame && f < c.endFrame)?.cueId ?? null;
  const want: { frame: number; purpose: PlannedSample["purpose"]; rank: number }[] = [];
  const add = (frame: number, purpose: PlannedSample["purpose"], rank: number) => want.push({ frame: Math.max(0, Math.min(totalFrames - 1, Math.round(frame))), purpose, rank });
  for (const s of scenes) add(s.startFrame + s.durationInFrames * 0.6, "scene-mid", 0);
  add(0, "start", 1);
  add(totalFrames - 1, "end", 1);
  add(totalFrames / 2, "middle", 1);
  scenes.slice(1).forEach((s) => add(s.startFrame + Math.min(10, s.durationInFrames - 1), "scene-start", 2));
  const step = Math.max(1, Math.round(o.everySec * fps));
  for (let f = step; f < totalFrames - 1; f += step) add(f, "interval", 3);
  const byFrame = new Map<number, (typeof want)[number]>();
  for (const w of want.sort((a, b) => a.rank - b.rank)) if (!byFrame.has(w.frame)) byFrame.set(w.frame, w);
  let kept = [...byFrame.values()];
  if (kept.length > o.max) kept = kept.sort((a, b) => a.rank - b.rank || a.frame - b.frame).slice(0, Math.max(o.max, kept.filter((k) => k.rank <= 1).length));
  return kept
    .sort((a, b) => a.frame - b.frame)
    .map((k) => ({ frame: k.frame, sceneId: sceneOf(k.frame), purpose: k.purpose, blankAllowed: inAnimationWindow(k.frame, scenes), activeCueId: cueAt(k.frame) }));
}

/** Seek time that makes ffmpeg's accurate seek return exactly frame `f` (first frame with pts >= t). */
export const seekTimeFor = (f: number, fps: number) => Math.max(0, (f - 0.25) / fps);

// ------------------------------------------------------------------ frame analysis

export interface FrameLayout {
  background: Rgb;
  text: Rgb;
  /** Fractions of the frame that must be free of foreground pixels. */
  margins: { top: number; bottom: number; left: number; right: number };
  /** Rows at the top occupied by the progress bar (never foreground). */
  progressRows: number;
  /** y (px) where the caption-only zone begins: the scene's bottom safe-area edge. */
  captionZoneTop: number;
}

export interface FrameMetrics {
  lumaMean: number;
  lumaStdDev: number;
  uniformFraction: number;
  blank: boolean;
  marginForeground: number;
  edgeForeground: number;
  captionBox: { top: number; bottom: number; left: number; right: number; pixels: number } | null;
  captionContrast: number | null;
}

/**
 * Foreground = text-like pixels: near-white (captions are #FFFFFF, Inter
 * anti-aliased) or close to the brand text colour while far from the brand
 * background. Dimmed backdrop video (×0.42) never reaches near-white.
 */
export function isForeground(r: number, g: number, b: number, L: Pick<FrameLayout, "background" | "text">): boolean {
  if (r >= 225 && g >= 225 && b >= 225) return true;
  return dist(r, g, b, L.text) < 36 && dist(r, g, b, L.background) > 90;
}

export function analyzeFrame(img: RgbImage, L: FrameLayout, o: { blankStdDev: number; blankUniformFraction: number }): FrameMetrics {
  const { width: w, height: h, rgb } = img;
  const hist = new Uint32Array(256);
  let sum = 0;
  let sq = 0;
  let n = 0;
  const top = Math.min(h, L.progressRows);
  const contentBottom = Math.max(top + 1, Math.min(h, Math.round(L.captionZoneTop)));
  // Scene-content statistics exclude the progress bar and the caption-only zone.
  for (let y = top; y < contentBottom; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const l = luma(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
      sum += l;
      sq += l * l;
      hist[Math.round(l)]!++;
      n++;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  let acc = 0;
  let median = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= n / 2) {
      median = v;
      break;
    }
  }
  let near = 0;
  for (let v = Math.max(0, median - 6); v <= Math.min(255, median + 6); v++) near += hist[v]!;
  const uniformFraction = near / n;

  const mt = Math.max(top, Math.round(L.margins.top * h));
  const mb = h - Math.round(L.margins.bottom * h);
  const ml = Math.round(L.margins.left * w);
  const mr = w - Math.round(L.margins.right * w);
  const eb = Math.max(1, Math.round(Math.min(w, h) * 0.005));
  let marginFg = 0;
  let edgeFg = 0;
  for (let y = top; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inMargin = y < mt || y >= mb || x < ml || x >= mr;
      if (!inMargin) continue;
      const i = (y * w + x) * 3;
      if (!isForeground(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!, L)) continue;
      marginFg++;
      if (y < top + eb || y >= h - eb || x < eb || x >= w - eb) edgeFg++;
    }
  }

  // Caption box: pure-white text in the caption-only zone (rows/cols with >= 2 white pixels).
  let cTop = -1;
  let cBottom = -1;
  let cLeft = w;
  let cRight = -1;
  let cPixels = 0;
  const zoneTop = Math.max(0, Math.round(L.captionZoneTop));
  const colCount = new Uint32Array(w);
  for (let y = zoneTop; y < h; y++) {
    let rowCount = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (rgb[i]! >= 235 && rgb[i + 1]! >= 235 && rgb[i + 2]! >= 235) {
        rowCount++;
        colCount[x]!++;
      }
    }
    if (rowCount >= 2) {
      if (cTop < 0) cTop = y;
      cBottom = y;
      cPixels += rowCount;
    }
  }
  for (let x = 0; x < w; x++) {
    if (colCount[x]! >= 2) {
      cLeft = Math.min(cLeft, x);
      cRight = Math.max(cRight, x);
    }
  }
  const captionBox = cPixels >= 30 && cTop >= 0 && cRight >= cLeft ? { top: cTop, bottom: cBottom, left: cLeft, right: cRight, pixels: cPixels } : null;
  let captionContrast: number | null = null;
  if (captionBox) {
    // Text = near-white pixels; box = everything else in the text area grown by a few pixels (the box padding).
    const g = 6;
    const fgV: number[] = [];
    const bgV: number[] = [];
    for (let y = Math.max(zoneTop, captionBox.top - g); y <= Math.min(h - 1, captionBox.bottom + g); y++) {
      for (let x = Math.max(0, captionBox.left - g); x <= Math.min(w - 1, captionBox.right + g); x++) {
        const i = (y * w + x) * 3;
        const l = luma(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
        (rgb[i]! >= 235 && rgb[i + 1]! >= 235 && rgb[i + 2]! >= 235 ? fgV : bgV).push(l);
      }
    }
    const med = (a: number[]) => (a.sort((x, y) => x - y), a[Math.floor(a.length / 2)]!);
    if (fgV.length && bgV.length) captionContrast = Math.round(contrastOf(relLum(med(fgV)), relLum(med(bgV))) * 100) / 100;
  }
  return {
    lumaMean: Math.round(mean * 100) / 100,
    lumaStdDev: Math.round(std * 100) / 100,
    uniformFraction: Math.round(uniformFraction * 10000) / 10000,
    blank: std < o.blankStdDev && uniformFraction >= o.blankUniformFraction,
    marginForeground: marginFg,
    edgeForeground: edgeFg,
    captionBox,
    captionContrast,
  };
}

// ------------------------------------------------------------------ media visibility (heuristic)

/** Distinctive colours of a source image: 16-level buckets with >= minShare of the pixels, excluding near-black/near-white/background. */
export function colourSignature(img: RgbImage, exclude: readonly Rgb[], minShare = 0.04): Rgb[] {
  const counts = new Map<number, number>();
  const n = img.width * img.height;
  for (let i = 0; i < n * 3; i += 3) {
    const r = img.rgb[i]! >> 4;
    const g = img.rgb[i + 1]! >> 4;
    const b = img.rgb[i + 2]! >> 4;
    const key = (r << 8) | (g << 4) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Rgb[] = [];
  for (const [key, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (c / n < minShare) break;
    const col: Rgb = [((key >> 8) << 4) + 8, (((key >> 4) & 15) << 4) + 8, ((key & 15) << 4) + 8];
    const l = luma(...col);
    if (l < 40 || l > 225) continue;
    if (exclude.some((e) => dist(col[0], col[1], col[2], e) < 60)) continue;
    out.push(col);
    if (out.length >= 4) break;
  }
  return out;
}

/** Pixels of `img` within `tol` (L1) of any signature colour scaled by `gain` (backdrop scrim). */
export function signatureMatches(img: RgbImage, sig: readonly Rgb[], gain = 1, tol = 48): number {
  const cols = sig.map((c) => c.map((v) => v * gain) as Rgb);
  let m = 0;
  for (let i = 0; i < img.rgb.length; i += 3) {
    const r = img.rgb[i]!;
    const g = img.rgb[i + 1]!;
    const b = img.rgb[i + 2]!;
    if (cols.some((c) => dist(r, g, b, c) < tol)) m++;
  }
  return m;
}

// ------------------------------------------------------------------ audio analysis

/** dBFS per 10 ms window. */
export function levels10ms(samples: Int16Array, sampleRate: number): Float64Array {
  const win = Math.max(1, Math.round(sampleRate / 100));
  const n = Math.floor(samples.length / win);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let sq = 0;
    for (let i = f * win; i < (f + 1) * win; i++) sq += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sq / win);
    out[f] = rms <= 0 ? -120 : Math.max(-120, 20 * Math.log10(rms / 32768));
  }
  return out;
}

/** Runs of consecutive 10 ms windows below `floorDbfs`, in ms. */
export function silentRuns(levels: Float64Array, floorDbfs: number): { startMs: number; endMs: number }[] {
  const runs: { startMs: number; endMs: number }[] = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i]! < floorDbfs;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      runs.push({ startMs: start * 10, endMs: i * 10 });
      start = -1;
    }
  }
  return runs;
}

/** Silent runs longer than `maxMs` that lie inside any of the given speech windows. */
export function dropouts(runs: readonly { startMs: number; endMs: number }[], windows: readonly { startMs: number; endMs: number }[], maxMs: number) {
  const out: { startMs: number; endMs: number }[] = [];
  for (const w of windows) {
    for (const r of runs) {
      const s = Math.max(r.startMs, w.startMs);
      const e = Math.min(r.endMs, w.endMs);
      if (e - s > maxMs) out.push({ startMs: s, endMs: e });
    }
  }
  return out;
}

export function clippedSamples(samples: Int16Array): number {
  let n = 0;
  for (const s of samples) if (s >= 32700 || s <= -32700) n++;
  return n;
}

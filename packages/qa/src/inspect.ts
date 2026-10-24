import { promises as fs } from "node:fs";
import { runCommand } from "@creatorflow/core";
import type { FfprobeChoice } from "@creatorflow/video-engine";

export interface ToolInfo {
  name: string;
  version: string;
  source: string;
}

const versions = new Map<string, string>();

/** First line of `<tool> -version`, e.g. "ffmpeg version n7.1". Paths are not reported. */
export async function toolInfo(name: string, t: FfprobeChoice): Promise<ToolInfo> {
  let v = versions.get(t.path);
  if (v === undefined) {
    const r = await runCommand(t.path, ["-version"], { timeoutMs: 15_000 });
    v = (r.stdout.split(/\r?\n/)[0] ?? "").replace(/\s*Copyright.*$/, "").trim() || "unknown";
    versions.set(t.path, v);
  }
  const source = t.description.includes("bundled with Remotion") ? t.description.replace(/\s*\(.*$/, "") + " (Remotion compositor package)" : t.description.startsWith("configured") ? "configured path" : t.description;
  return { name, version: v, source };
}

export interface DecodeResult {
  ok: boolean;
  /** Frames the decoder produced (last `frame=` of -progress), when known. */
  frames: number | null;
  errors: string[];
  ms: number;
  timedOut: boolean;
}

/**
 * ONE pass over the whole file: decodes every video frame (to the null muxer)
 * and, when `wavOut` is given, decodes the first audio stream to 16 kHz mono
 * 16-bit WAV. `-xerror` stops at the first decode error; any stderr output at
 * `-v error` counts as a decode problem.
 */
export async function decodeAll(ffmpeg: FfprobeChoice, file: string, wavOut: string | undefined, o: { timeoutMs: number; signal?: AbortSignal }): Promise<DecodeResult> {
  const t0 = Date.now();
  const args = ["-v", "error", "-nostdin", "-xerror", "-progress", "pipe:1", "-i", file, "-map", "0:v:0", "-c:v", "rawvideo", "-f", "null", "-"];
  if (wavOut) args.push("-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wavOut);
  const r = await runCommand(ffmpeg.path, args, { timeoutMs: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
  if (r.errorCode === "ABORTED") throw o.signal?.reason ?? new Error("aborted");
  const frames = [...r.stdout.matchAll(/^frame=(\d+)/gm)].map((m) => Number(m[1])).at(-1) ?? null;
  const errors = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 10);
  if (r.errorCode === "TIMEOUT") return { ok: false, frames, errors: [`decoding exceeded ${o.timeoutMs} ms`], ms: Date.now() - t0, timedOut: true };
  return { ok: r.exitCode === 0 && errors.length === 0, frames, errors: r.exitCode !== 0 && !errors.length ? [`ffmpeg exited ${r.exitCode ?? r.errorCode}`] : errors, ms: Date.now() - t0, timedOut: false };
}

/** Extracts the frame at (accurate-seek) time `t` as an RGB PNG at full size. */
export async function extractFrame(ffmpeg: FfprobeChoice, file: string, t: number, out: string, o: { signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await runCommand(ffmpeg.path, ["-v", "error", "-nostdin", "-ss", t.toFixed(4), "-i", file, "-map", "0:v:0", "-frames:v", "1", "-pix_fmt", "rgb24", "-y", out], { timeoutMs: 60_000, ...(o.signal ? { signal: o.signal } : {}) });
  if (r.errorCode === "ABORTED") throw o.signal?.reason ?? new Error("aborted");
  if (r.exitCode !== 0) return { ok: false, message: r.stderr.trim().slice(0, 300) || `exit ${r.exitCode ?? r.errorCode}` };
  const st = await fs.stat(out).catch(() => undefined);
  if (!st?.size) return { ok: false, message: "no frame was written" };
  return { ok: true };
}

/** A small RGB thumbnail of a source asset (image, or video at `t`) for colour signatures. */
export async function thumbnail(ffmpeg: FfprobeChoice, file: string, t: number | undefined, out: string, o: { signal?: AbortSignal }): Promise<boolean> {
  const seek = t === undefined ? [] : ["-ss", t.toFixed(3)];
  const r = await runCommand(ffmpeg.path, ["-v", "error", "-nostdin", ...seek, "-i", file, "-frames:v", "1", "-vf", "scale=96:-2", "-pix_fmt", "rgb24", "-y", out], { timeoutMs: 60_000, ...(o.signal ? { signal: o.signal } : {}) });
  if (r.errorCode === "ABORTED") throw o.signal?.reason ?? new Error("aborted");
  return r.exitCode === 0 && Boolean((await fs.stat(out).catch(() => undefined))?.size);
}

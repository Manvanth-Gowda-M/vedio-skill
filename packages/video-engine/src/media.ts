import { promises as fs } from "node:fs";
import { runCommand } from "@creatorflow/core";
import type { CreatorFlowConfig, VideoStreamInfo } from "@creatorflow/schemas";
import type { FfprobeChoice } from "./environment.ts";

export type AssetLimits = CreatorFlowConfig["assets"];
export interface MediaTools {
  ffprobe: FfprobeChoice;
  ffmpeg: FfprobeChoice;
}

export const VIDEO_EXTENSIONS: Record<string, { mediaType: string; container: "iso-bmff" | "matroska" }> = {
  ".mp4": { mediaType: "video/mp4", container: "iso-bmff" },
  ".m4v": { mediaType: "video/mp4", container: "iso-bmff" },
  ".mov": { mediaType: "video/quicktime", container: "iso-bmff" },
  ".webm": { mediaType: "video/webm", container: "matroska" },
  ".mkv": { mediaType: "video/x-matroska", container: "matroska" },
};

/** Container family from the first bytes (never from the extension). */
export function sniffContainer(head: Buffer): "iso-bmff" | "matroska" | undefined {
  if (head.length >= 8 && head.toString("latin1", 4, 8) === "ftyp") return "iso-bmff";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "matroska";
  return undefined;
}

/** Width/height from PNG, JPEG or WebP headers; undefined when the header is not valid. */
export function imageSize(b: Buffer, mediaType: string): { width: number; height: number } | undefined {
  try {
    if (mediaType === "image/png") {
      if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return undefined;
      return nonZero(b.readUInt32BE(16), b.readUInt32BE(20));
    }
    if (mediaType === "image/jpeg") {
      let off = 2;
      while (off + 9 < b.length) {
        if (b[off] !== 0xff) return undefined;
        const marker = b[off + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2;
          continue;
        }
        const len = b.readUInt16BE(off + 2);
        // SOF0-15 except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return nonZero(b.readUInt16BE(off + 7), b.readUInt16BE(off + 5));
        off += 2 + len;
      }
      return undefined;
    }
    if (mediaType === "image/webp") {
      const chunk = b.toString("latin1", 12, 16);
      if (chunk === "VP8 " && b.length >= 30) return nonZero(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
      if (chunk === "VP8L" && b.length >= 25) {
        const bits = b.readUInt32LE(21);
        return nonZero((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8X" && b.length >= 30) return nonZero(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
      return undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
const nonZero = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

const rate = (r?: string) => {
  const [n, d] = (r ?? "0/1").split("/").map(Number) as [number, number];
  return d ? n / d : 0;
};

export type ProbeResult = { ok: true; info: VideoStreamInfo } | { ok: false; code: "ASSET_INVALID" | "UNSUPPORTED_ASSET_TYPE" | "ASSET_LIMIT_EXCEEDED" | "MEDIA_TOOLS_UNAVAILABLE"; message: string };

/**
 * Measures a video file with ffprobe and then decodes it with ffmpeg
 * (all frames for decodeCheck "full", first and last second for "sample").
 * Rejects corrupt, empty, unsupported or oversized media with a reason;
 * never trims or transcodes anything.
 */
export async function probeVideo(file: string, label: string, expected: "iso-bmff" | "matroska", tools: MediaTools | null | undefined, limits: AssetLimits, signal?: AbortSignal): Promise<ProbeResult> {
  if (!tools) return { ok: false, code: "MEDIA_TOOLS_UNAVAILABLE", message: `${label}: video assets need ffprobe and ffmpeg (Remotion's bundled copies, PATH, or hardware.ffprobePath/ffmpegPath); none was found` };
  const fh = await fs.open(file, "r");
  const head = Buffer.alloc(16);
  try {
    await fh.read(head, 0, 16, 0);
  } finally {
    await fh.close();
  }
  const sniffed = sniffContainer(head);
  if (!sniffed) return { ok: false, code: "ASSET_INVALID", message: `${label} is not an MP4/MOV or WebM/Matroska file (unrecognised header)` };
  if (sniffed !== expected) return { ok: false, code: "ASSET_INVALID", message: `${label}: the file contents are ${sniffed === "iso-bmff" ? "MP4/MOV" : "WebM/Matroska"}, which does not match its extension` };
  const opt = { timeoutMs: limits.probeTimeoutMs, ...(signal ? { signal } : {}) };
  const p = await runCommand(tools.ffprobe.path, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], opt);
  if (p.errorCode === "ABORTED") throw signal?.reason ?? new Error("aborted");
  if (p.errorCode === "TIMEOUT") return { ok: false, code: "ASSET_LIMIT_EXCEEDED", message: `${label}: probing took longer than assets.probeTimeoutMs (${limits.probeTimeoutMs} ms)` };
  if (p.exitCode !== 0) return { ok: false, code: "ASSET_INVALID", message: `${label} cannot be read as media: ${p.stderr.trim().split(/\r?\n/).slice(-1)[0]?.slice(0, 200) ?? "ffprobe failed"}` };
  let data: { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
  try {
    data = JSON.parse(p.stdout) as typeof data;
  } catch {
    return { ok: false, code: "ASSET_INVALID", message: `${label}: ffprobe output was not JSON` };
  }
  const v = data.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!v) return { ok: false, code: "ASSET_INVALID", message: `${label} has no video stream` };
  const codec = v.codec_name ?? "unknown";
  if (!(limits.videoCodecs as readonly string[]).includes(codec)) return { ok: false, code: "UNSUPPORTED_ASSET_TYPE", message: `${label}: video codec ${codec} is not accepted (assets.videoCodecs: ${limits.videoCodecs.join(", ")}). Re-encode it to H.264 yourself` };
  const width = v.width ?? 0;
  const height = v.height ?? 0;
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
  const durationSec = Number(v.duration ?? data.format?.duration ?? 0);
  if (!width || !height) return { ok: false, code: "ASSET_INVALID", message: `${label}: the video stream has no dimensions` };
  if (!(fps > 0)) return { ok: false, code: "ASSET_INVALID", message: `${label}: the video stream has no frame rate` };
  if (!(durationSec > 0)) return { ok: false, code: "ASSET_INVALID", message: `${label}: the video has no measurable duration (empty or truncated)` };
  if (width > limits.maxVideoWidth || height > limits.maxVideoHeight) return { ok: false, code: "ASSET_LIMIT_EXCEEDED", message: `${label} is ${width}x${height}; the limit is ${limits.maxVideoWidth}x${limits.maxVideoHeight} (assets.maxVideoWidth/maxVideoHeight)` };
  if (fps > limits.maxVideoFps + 0.01) return { ok: false, code: "ASSET_LIMIT_EXCEEDED", message: `${label} is ${fps.toFixed(2)} fps; the limit is ${limits.maxVideoFps}` };
  if (durationSec > limits.maxVideoDurationSec) return { ok: false, code: "ASSET_LIMIT_EXCEEDED", message: `${label} is ${durationSec.toFixed(1)} s long; the limit is ${limits.maxVideoDurationSec} s (assets.maxVideoDurationSec). Trim the file yourself; CreatorFlow does not truncate clips` };
  const rotation = Math.round(Number(v.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? v.tags?.["rotate"] ?? 0)) || 0;
  const a = data.streams?.find((s) => s.codec_type === "audio");

  // Decode check: proves the frames decode, which ffprobe's header read does not. Frames are
  // handed to the rawvideo encoder and discarded by the null muxer (Remotion's minimal ffmpeg
  // build has no wrapped_avframe encoder, so the codec is named explicitly).
  const sink = ["-map", "0:v:0", "-c:v", "rawvideo", "-f", "null", "-"];
  const decodeArgs = limits.decodeCheck === "full" ? ["-v", "error", "-nostdin", "-xerror", "-i", file, ...sink] : ["-v", "error", "-nostdin", "-xerror", "-t", "1", "-i", file, ...sink];
  const d = await runCommand(tools.ffmpeg.path, decodeArgs, opt);
  if (d.errorCode === "ABORTED") throw signal?.reason ?? new Error("aborted");
  if (d.errorCode === "TIMEOUT") return { ok: false, code: "ASSET_LIMIT_EXCEEDED", message: `${label}: decoding took longer than assets.probeTimeoutMs (${limits.probeTimeoutMs} ms)` };
  if (d.exitCode !== 0 || d.stderr.trim()) return { ok: false, code: "ASSET_INVALID", message: `${label} does not decode cleanly (corrupt or truncated): ${d.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? `exit ${d.exitCode}`}` };
  if (limits.decodeCheck === "sample" && durationSec > 2) {
    const e = await runCommand(tools.ffmpeg.path, ["-v", "error", "-nostdin", "-xerror", "-sseof", "-1", "-i", file, ...sink], opt);
    if (e.exitCode !== 0 || e.stderr.trim()) return { ok: false, code: "ASSET_INVALID", message: `${label}: the end of the file does not decode (truncated?)` };
  }
  return {
    ok: true,
    info: {
      container: data.format?.format_name ?? sniffed,
      codec,
      width,
      height,
      fps: Math.round(fps * 1000) / 1000,
      durationSec: Math.round(durationSec * 1000) / 1000,
      ...(v.nb_frames && Number(v.nb_frames) > 0 ? { frames: Number(v.nb_frames) } : {}),
      ...(v.pix_fmt ? { pixelFormat: v.pix_fmt } : {}),
      rotation,
      audio: a ? { codec: a.codec_name ?? "unknown", ...(a.sample_rate ? { sampleRate: Number(a.sample_rate) } : {}), ...(a.channels ? { channels: a.channels } : {}) } : null,
    },
  };
}

/** Decodes the first audio stream of `file` to 16 kHz mono 16-bit WAV at `out` (for output verification). */
export async function extractAudioWav(ffmpeg: FfprobeChoice, file: string, out: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await runCommand(ffmpeg.path, ["-v", "error", "-nostdin", "-y", "-i", file, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", out], { timeoutMs: 180_000, ...(signal ? { signal } : {}) });
  if (r.exitCode !== 0) return { ok: false, message: r.stderr.trim().slice(0, 300) || `exit ${r.exitCode ?? r.errorCode}` };
  return { ok: true };
}

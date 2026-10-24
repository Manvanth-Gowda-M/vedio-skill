import { promises as fs } from "node:fs";
import { runCommand } from "@creatorflow/core";
import type { MediaInspection } from "@creatorflow/schemas";

/**
 * Minimal ISO-BMFF check: walks the top-level boxes and requires `ftyp` first
 * plus `moov` and `mdat`, with sizes that exactly tile the file. It proves the
 * container is structurally complete, not that frames decode.
 */
export async function inspectMp4Container(file: string): Promise<MediaInspection["container"]> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const boxes: string[] = [];
    let off = 0;
    const head = Buffer.alloc(16);
    while (off < size) {
      const { bytesRead } = await fh.read(head, 0, 16, off);
      if (bytesRead < 8) return { ok: false, boxes, problem: `truncated box header at byte ${off}` };
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) return { ok: false, boxes, problem: `invalid box type at byte ${off}` };
      if (len === 1) {
        if (bytesRead < 16) return { ok: false, boxes, problem: "truncated 64-bit box size" };
        len = Number(head.readBigUInt64BE(8));
      } else if (len === 0) len = size - off;
      if (len < 8 || off + len > size) return { ok: false, boxes, problem: `box ${type} at byte ${off} overruns the file` };
      boxes.push(type);
      off += len;
    }
    if (boxes[0] !== "ftyp") return { ok: false, boxes, problem: "file does not start with an ftyp box" };
    for (const need of ["moov", "mdat"]) if (!boxes.includes(need)) return { ok: false, boxes, problem: `missing ${need} box` };
    return { ok: true, boxes };
  } finally {
    await fh.close();
  }
}

export interface Expected {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
}

/** Container check always; stream inspection with ffprobe when available. */
export async function inspectRender(file: string, expected: Expected, ffprobe: { path: string; description: string } | undefined): Promise<MediaInspection> {
  const container = await inspectMp4Container(file);
  if (!ffprobe) {
    return { performed: false, reason: "no ffprobe available (PATH, hardware.ffprobePath or Remotion's bundled copy)", container, mismatches: [] };
  }
  const r = await runCommand(ffprobe.path, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    return { performed: true, tool: ffprobe.description, container, matchesRequest: false, mismatches: [`ffprobe failed (exit ${r.exitCode ?? r.errorCode}): ${r.stderr.trim().slice(0, 300)}`] };
  }
  let data: { streams?: FfprobeStream[]; format?: { duration?: string } };
  try {
    data = JSON.parse(r.stdout) as typeof data;
  } catch {
    return { performed: true, tool: ffprobe.description, container, matchesRequest: false, mismatches: ["ffprobe output is not JSON"] };
  }
  const v = data.streams?.find((s) => s.codec_type === "video");
  const audioList = data.streams?.filter((s) => s.codec_type === "audio") ?? [];
  const audioStreams = audioList.length;
  const a0 = audioList[0];
  const audio = a0 ? { codec: a0.codec_name ?? "unknown", ...(a0.sample_rate ? { sampleRate: Number(a0.sample_rate) } : {}), ...(a0.channels ? { channels: a0.channels } : {}), ...(a0.duration ? { durationSec: Number(a0.duration) } : {}) } : undefined;
  if (!v) return { performed: true, tool: ffprobe.description, container, audioStreams, ...(audio ? { audio } : {}), matchesRequest: false, mismatches: ["no video stream"] };
  const [num, den] = (v.r_frame_rate ?? "0/1").split("/").map(Number) as [number, number];
  const fps = den ? num / den : 0;
  const frames = v.nb_frames ? Number(v.nb_frames) : undefined;
  const durationSec = Number(v.duration ?? data.format?.duration ?? 0);
  const video = { codec: v.codec_name ?? "unknown", width: v.width ?? 0, height: v.height ?? 0, fps: Math.round(fps * 1000) / 1000, ...(frames !== undefined ? { frames } : {}), durationSec, ...(v.pix_fmt ? { pixelFormat: v.pix_fmt } : {}) };
  const mismatches: string[] = [];
  if (video.codec !== "h264") mismatches.push(`codec ${video.codec}, expected h264`);
  if (video.width !== expected.width || video.height !== expected.height) mismatches.push(`${video.width}x${video.height}, expected ${expected.width}x${expected.height}`);
  if (Math.abs(fps - expected.fps) > 0.01) mismatches.push(`${fps} fps, expected ${expected.fps}`);
  if (frames !== undefined && frames !== expected.durationInFrames) mismatches.push(`${frames} frames, expected ${expected.durationInFrames}`);
  const expSec = expected.durationInFrames / expected.fps;
  if (Math.abs(durationSec - expSec) > 1.5 / expected.fps) mismatches.push(`duration ${durationSec}s, expected ${expSec.toFixed(3)}s`);
  return { performed: true, tool: ffprobe.description, container, video, audioStreams, ...(audio ? { audio } : {}), matchesRequest: mismatches.length === 0 && container.ok, mismatches };
}

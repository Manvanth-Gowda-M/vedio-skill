// SIMULATED Remotion output for QA workflow tests (NOT a real render). It draws, per frame, what
// the real composition draws in the places QA measures: the brand background, text-like bars inside
// each scene's safe area, and (while a cue is active) a dark caption box with white text-like bars at
// the geometry from captionLayout(). Optional defects let tests prove that QA catches them.
// Encoding: one PNG per visual state, hard-linked per frame, encoded with Remotion's bundled ffmpeg.
import { promises as fs } from "node:fs";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { runCommand } from "@creatorflow/core";
import { captionAt, captionLayout } from "@creatorflow/remotion-studio";
import { remotionFfmpeg } from "./media.ts";

type Rgb = [number, number, number];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  c: Rgb;
}
const hex = (h: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function paintPng(width: number, height: number, bg: Rgb, rects: readonly Rect[]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      raw[o] = bg[0];
      raw[o + 1] = bg[1];
      raw[o + 2] = bg[2];
    }
  }
  for (const r of rects) {
    for (let y = Math.max(0, Math.round(r.y)); y < Math.min(height, Math.round(r.y + r.h)); y++) {
      for (let x = Math.max(0, Math.round(r.x)); x < Math.min(width, Math.round(r.x + r.w)); x++) {
        const o = y * stride + 1 + x * 3;
        raw[o] = r.c[0];
        raw[o + 1] = r.c[1];
        raw[o + 2] = r.c[2];
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

export interface FakeProps {
  format: { width: number; height: number; fps: number; durationInFrames: number };
  brand: { colors: { background: string; text: string } };
  scenes: { sceneId: string; startFrame: number; durationInFrames: number; safeArea: { top: number; bottom: number; left: number; right: number } }[];
  captions: { startFrame: number; endFrame: number; lines: string[] }[];
  audio?: { file: string };
}

export type QaDefect = "none" | "no-captions" | "margin-text" | "blank-scene" | "caption-low";

export async function makeQaLikeVideo(out: string, props: FakeProps, publicDir: string, defect: QaDefect = "none"): Promise<void> {
  const { width: W, height: H, fps, durationInFrames: N } = props.format;
  const bg = hex(props.brand.colors.background);
  const text = hex(props.brand.colors.text);
  const sceneAt = (f: number) => props.scenes.findIndex((s) => f >= s.startFrame && f < s.startFrame + s.durationInFrames);
  const work = `${out}.frames`;
  await fs.mkdir(work, { recursive: true });
  const states = new Map<string, string>();
  try {
    for (let f = 0; f < N; f++) {
      const si = sceneAt(f);
      const cue = defect === "no-captions" ? undefined : captionAt(props.captions, f);
      const key = `${si}|${cue ? props.captions.indexOf(cue) : -1}`;
      let file = states.get(key);
      if (!file) {
        const s = props.scenes[si]!;
        const rects: Rect[] = [];
        if (!(defect === "blank-scene" && si === 1)) {
          const x0 = s.safeArea.left * W;
          const inner = W * (1 - s.safeArea.left - s.safeArea.right);
          for (let k = 0; k < 3; k++) rects.push({ x: x0, y: H * 0.35 + k * 90, w: inner * (0.9 - 0.15 * ((k + si) % 3)), h: 56, c: text });
        }
        if (defect === "margin-text") rects.push({ x: 4, y: H * 0.5, w: 20, h: 60, c: [255, 255, 255] });
        if (cue) {
          const L = captionLayout(W, H, s.safeArea.bottom, cue.lines.length);
          const boxW = L.maxTextWidth * 0.8 + 2 * L.padH;
          const bx = (W - boxW) / 2;
          const shade: Rgb = defect === "caption-low" ? [150, 150, 150] : (bg.map((v) => Math.round(v * 0.28)) as Rgb);
          rects.push({ x: bx, y: L.top, w: boxW, h: L.boxHeight, c: shade });
          cue.lines.forEach((_, i) => rects.push({ x: bx + L.padH, y: L.top + L.padV + i * L.fontPx * 1.3 + L.fontPx * 0.2, w: boxW - 2 * L.padH - (i % 2) * 80, h: L.fontPx * 0.75, c: defect === "caption-low" ? [190, 190, 190] : [255, 255, 255] }));
          // caption-low still needs white pixels to be found: a thin white stroke
          if (defect === "caption-low") rects.push({ x: bx + L.padH, y: L.top + L.padV, w: 60, h: 4, c: [255, 255, 255] });
        }
        file = path.join(work, `state-${states.size}.png`);
        await fs.writeFile(file, paintPng(W, H, bg, rects));
        states.set(key, file);
      }
      await fs.link(file, path.join(work, `f${String(f).padStart(6, "0")}.png`));
    }
    const audio = props.audio ? ["-i", path.join(publicDir, props.audio.file)] : [];
    const audioOut = props.audio ? ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-ar", "48000", "-ac", "2"] : [];
    const r = await runCommand(remotionFfmpeg(), ["-v", "error", "-y", "-framerate", String(fps), "-i", path.join(work, "f%06d.png"), ...audio, "-frames:v", String(N), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...audioOut, out], { timeoutMs: 300_000 });
    if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Overwrites bytes in the middle of the file (inside mdat; ffmpeg writes moov at the end), keeping its size and header. */
export async function damageMiddle(file: string): Promise<void> {
  const b = await fs.readFile(file);
  for (let i = Math.floor(b.length * 0.3); i < Math.floor(b.length * 0.6); i += 5) b[i] = 0x5a;
  await fs.writeFile(file, b);
}

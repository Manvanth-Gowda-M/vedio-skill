// Deterministic local media fixtures (no network): solid/striped PNGs, plus a tiny
// valid H.264 MP4 made with the ffmpeg binary that ships inside Remotion.
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { runCommand } from "@creatorflow/core";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** RGB PNG; `stripes` draws horizontal bands (a crude "diagram") in the given colours. */
export function makePng(width: number, height: number, colors: [number, number, number][] = [[255, 255, 255]]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const [r, g, b] = colors[Math.floor((y / height) * colors.length)]!;
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function remotionFfmpeg(): string {
  const req = createRequire(import.meta.url);
  const scope = path.dirname(path.dirname(req.resolve("@remotion/renderer/package.json")));
  const dir = path.join(scope, `compositor-${process.platform}-${process.arch}${process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : ""}`);
  return path.join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

/** A real H.264 MP4 of `frames` frames (looped still image), generated locally; optionally with an AAC track from a WAV. */
export async function makeMp4(out: string, width: number, height: number, fps: number, frames: number, opts: { audioWav?: string; color?: [number, number, number] } = {}): Promise<void> {
  const png = `${out}.png`;
  await fs.writeFile(png, makePng(width, height, [opts.color ?? [11, 13, 18]]));
  const audio = opts.audioWav ? ["-i", opts.audioWav] : [];
  const audioOut = opts.audioWav ? ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-ar", "48000", "-ac", "2"] : [];
  const r = await runCommand(remotionFfmpeg(), ["-v", "error", "-y", "-loop", "1", "-framerate", String(fps), "-i", png, ...audio, "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", ...audioOut, out], { timeoutMs: 120_000 });
  await fs.rm(png, { force: true });
  if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/**
 * A short, real test clip (generated locally; no third-party footage): moving
 * coloured bands so frames differ, encoded with the given codec. Provenance:
 * produced by this test fixture with Remotion's bundled ffmpeg.
 */
export async function makeClip(out: string, o: { width: number; height: number; fps: number; frames: number; codec?: "libx264" | "libvpx" | "libvpx-vp9"; withAudio?: boolean }): Promise<void> {
  const dir = `${out}.frames`;
  await fs.mkdir(dir, { recursive: true });
  const colors: [number, number, number][] = [[230, 57, 70], [42, 157, 143], [233, 196, 106], [38, 70, 83]];
  for (let i = 0; i < o.frames; i++) {
    const rot = colors.map((_, k) => colors[(k + i) % colors.length]!);
    await fs.writeFile(path.join(dir, `f${String(i).padStart(4, "0")}.png`), makePng(o.width, o.height, rot));
  }
  const args = ["-v", "error", "-y", "-framerate", String(o.fps), "-i", path.join(dir, "f%04d.png")];
  if (o.withAudio) {
    const wav = `${out}.tone.wav`;
    await fs.writeFile(wav, toneWav(o.frames / o.fps, 16000, 440));
    args.push("-i", wav, "-map", "0:v", "-map", "1:a", "-c:a", o.codec === "libx264" || !o.codec ? "aac" : "libopus", "-shortest");
  }
  args.push("-c:v", o.codec ?? "libx264", "-pix_fmt", "yuv420p", out);
  const r = await runCommand(remotionFfmpeg(), args, { timeoutMs: 120_000 });
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(`${out}.tone.wav`, { force: true });
  if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** 16-bit mono WAV with a sine tone (amplitude 0 = digital silence). */
export function toneWav(sec: number, sampleRate: number, hz: number, amplitude = 0.3): Buffer {
  const n = Math.round(sec * sampleRate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * 32767), 44 + i * 2);
  return b;
}


/** Decodes an 8-bit RGB (colour type 2), non-interlaced PNG into raw RGB bytes. */
export function decodeRgbPng(png: Buffer): { width: number; height: number; rgb: Buffer } {
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("only 8-bit RGB non-interlaced PNGs are supported");
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 3 ? out[y * stride + x - 3]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 3 && y > 0 ? out[(y - 1) * stride + x - 3]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { width, height, rgb: out };
}

/** Decodes one video frame at `sec`, scaled to w x h, as RGB bytes (via a PNG, no rawvideo muxer needed). */
export async function frameRgb(file: string, sec: number, w = 54, h = 96): Promise<Buffer> {
  const out = `${file}.${sec}.png`;
  const r = await runCommand(remotionFfmpeg(), ["-v", "error", "-y", "-ss", String(sec), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-pix_fmt", "rgb24", out], { timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(r.stderr);
  const png = await fs.readFile(out);
  await fs.rm(out, { force: true });
  return decodeRgbPng(png).rgb;
}

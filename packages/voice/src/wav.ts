/**
 * Minimal, dependency-free RIFF/WAVE reader and writer for 16-bit PCM, plus
 * the measurements the narration pipeline relies on (peak, RMS, clipping and
 * speech boundaries). Everything here is pure and unit-tested.
 */

export interface PcmAudio {
  sampleRate: number;
  /** Mono samples (multi-channel input is averaged). */
  samples: Int16Array;
  /** Channels in the source file. */
  channels: number;
  bitsPerSample: number;
}

export class WavError extends Error {
  readonly code = "AUDIO_INVALID";
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Parses a WAV file. Accepts PCM 16-bit (also WAVE_FORMAT_EXTENSIBLE with the PCM subformat), 1-8 channels. */
export function parseWav(buf: Buffer): PcmAudio {
  if (buf.length < 44) throw new WavError(`file is ${buf.length} bytes; too short to be a WAV file`);
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") throw new WavError("not a RIFF/WAVE file");
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number; blockAlign: number } | undefined;
  let data: Buffer | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    // Some writers put 0xFFFFFFFF or an over-long size on a streamed data chunk: clamp to the file.
    const end = Math.min(buf.length, body + size);
    if (id === "fmt ") {
      if (size < 16) throw new WavError("fmt chunk too short");
      let format = buf.readUInt16LE(body);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), blockAlign: buf.readUInt16LE(body + 12), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      data = buf.subarray(body, end);
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new WavError("missing fmt chunk");
  if (!data) throw new WavError("missing data chunk");
  if (fmt.format !== WAVE_FORMAT_PCM) throw new WavError(`unsupported WAV encoding ${fmt.format} (only 16-bit PCM)`);
  if (fmt.bits !== 16) throw new WavError(`unsupported bit depth ${fmt.bits} (only 16-bit PCM)`);
  if (fmt.channels < 1 || fmt.channels > 8) throw new WavError(`unsupported channel count ${fmt.channels}`);
  if (fmt.sampleRate < 8000 || fmt.sampleRate > 192000) throw new WavError(`unsupported sample rate ${fmt.sampleRate}`);
  if (fmt.blockAlign !== fmt.channels * 2) throw new WavError("inconsistent block alignment");
  const frames = Math.floor(data.length / fmt.blockAlign);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE(i * fmt.blockAlign + c * 2);
    samples[i] = Math.round(acc / fmt.channels);
  }
  return { sampleRate: fmt.sampleRate, samples, channels: fmt.channels, bitsPerSample: 16 };
}

/** 16-bit PCM mono WAV. */
export function writeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i]!, 44 + i * 2);
  return b;
}

const FULL = 32768;
export const toDbfs = (linear: number) => (linear <= 0 ? -120 : Math.max(-120, 20 * Math.log10(linear / FULL)));

export interface AudioStats {
  durationMs: number;
  peak: number;
  peakDbfs: number;
  rmsDbfs: number;
  /** Samples at full scale (|x| >= 32767). */
  clippedSamples: number;
}

export function audioStats(a: { samples: Int16Array; sampleRate: number }): AudioStats {
  let peak = 0;
  let sq = 0;
  let clipped = 0;
  for (const s of a.samples) {
    const v = Math.abs(s);
    if (v > peak) peak = v;
    if (v >= 32767) clipped++;
    sq += s * s;
  }
  const rms = a.samples.length ? Math.sqrt(sq / a.samples.length) : 0;
  return { durationMs: Math.round((a.samples.length * 1000) / a.sampleRate), peak, peakDbfs: round2(toDbfs(peak)), rmsDbfs: round2(toDbfs(rms)), clippedSamples: clipped };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** RMS level (dBFS) of [startMs, endMs). */
export function windowRmsDbfs(a: { samples: Int16Array; sampleRate: number }, startMs: number, endMs: number): number {
  const s = Math.max(0, Math.floor((startMs * a.sampleRate) / 1000));
  const e = Math.min(a.samples.length, Math.ceil((endMs * a.sampleRate) / 1000));
  if (e <= s) return -120;
  let sq = 0;
  for (let i = s; i < e; i++) sq += a.samples[i]! * a.samples[i]!;
  return toDbfs(Math.sqrt(sq / (e - s)));
}

/**
 * Speech boundaries from short-time energy: 10 ms frames, a frame is "speech"
 * when its RMS is above max(floorDbfs, loudestFrame - rangeDb). Returns sample
 * indices [start, end) or undefined when no frame qualifies.
 */
export function speechBounds(a: { samples: Int16Array; sampleRate: number }, opts: { floorDbfs?: number; rangeDb?: number } = {}): { start: number; end: number } | undefined {
  const frame = Math.max(1, Math.round(a.sampleRate / 100));
  const n = Math.floor(a.samples.length / frame);
  const levels: number[] = [];
  for (let f = 0; f < n; f++) {
    let sq = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sq += a.samples[i]! * a.samples[i]!;
    levels.push(toDbfs(Math.sqrt(sq / frame)));
  }
  if (!levels.length) return undefined;
  const loudest = Math.max(...levels);
  const threshold = Math.max(opts.floorDbfs ?? -50, loudest - (opts.rangeDb ?? 40));
  const first = levels.findIndex((l) => l >= threshold);
  if (first < 0 || loudest < (opts.floorDbfs ?? -50)) return undefined;
  let last = first;
  for (let f = levels.length - 1; f >= first; f--)
    if (levels[f]! >= threshold) {
      last = f;
      break;
    }
  return { start: first * frame, end: Math.min(a.samples.length, (last + 1) * frame) };
}

/** Multiplies samples by `gain`, saturating at 16-bit full scale. */
export function applyGain(samples: Int16Array, gain: number): Int16Array {
  if (gain === 1) return samples;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * gain)));
  return out;
}

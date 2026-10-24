// SIMULATED voice provider for tests. It is NOT a TTS engine: it writes 16 kHz mono WAV files
// with a tone whose length is proportional to the number of words (so timing logic can be
// tested deterministically) or misbehaves on purpose. Real narration: Windows SAPI tests.
import { writeFileSync } from "node:fs";
import type { HealthResult, SynthesisRequest, SynthesisResult, VoiceProvider } from "@creatorflow/voice";

export interface SimControl {
  mode: "ok" | "silent" | "garbage" | "fail" | "unavailable" | "no-file";
  /** Every synthesised text, in order (cache tests). */
  calls: string[];
  /** Engine version (changing it must re-generate narration). */
  version: string;
}

export const simControl = (): SimControl => ({ mode: "ok", calls: [], version: "1.0" });

const SR = 16000;

/** Words -> tone: 30 ms silence + 90 ms per word (scaled by 1/rate) + 60 ms silence. */
export function simWav(text: string, rate: number, amplitude = 0.25): Buffer {
  const words = text.split(/\s+/).filter(Boolean).length;
  const n = (ms: number) => Math.round((ms * SR) / 1000);
  const tone = n((90 * words) / rate);
  const total = n(30) + tone + n(60);
  const b = Buffer.alloc(44 + total * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + total * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < tone; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amplitude * 32767), 44 + (n(30) + i) * 2);
  return b;
}

export class SimulatedVoiceProvider implements VoiceProvider {
  readonly id = "simulated";
  private readonly ctl: SimControl;
  constructor(ctl: SimControl) {
    this.ctl = ctl;
  }
  describeRate(rate: number): string {
    return `simulated x${rate}`;
  }
  async health(): Promise<HealthResult> {
    if (this.ctl.mode === "unavailable") return { ready: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: "simulated provider: model file missing" };
    return {
      ready: true,
      capabilities: {
        providerId: this.id,
        displayName: "Simulated test voice (not speech)",
        adapterVersion: "1",
        engineVersion: `sim ${this.ctl.version}`,
        network: "none",
        languages: ["en-US"],
        voices: [{ id: "sim-en", name: "Sim English", language: "en-US" }],
        requirements: [],
        output: { container: "wav", encoding: "pcm_s16le", sampleRates: [SR], channels: 1 },
        controls: { speakingRate: { supported: true, min: 0.5, max: 2, mapping: "duration / rate" }, pitch: { supported: false }, voiceSelection: true },
        limits: { maxCharsPerRequest: 2000 },
        timestamps: "none",
        license: { engine: "test fixture", voices: "test fixture", notes: ["simulated audio, not speech"] },
      },
      fingerprint: { engine: `sim ${this.ctl.version}` },
    };
  }
  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    if (this.ctl.mode === "fail") return { ok: false, code: "VOICE_SYNTHESIS_FAILED", message: "simulated engine crash", retryable: true };
    for (const it of req.items) {
      this.ctl.calls.push(it.text);
      if (this.ctl.mode === "no-file") continue;
      writeFileSync(it.out, this.ctl.mode === "garbage" ? Buffer.from("not a wav file at all, sorry") : simWav(it.text, req.speakingRate, this.ctl.mode === "silent" ? 0 : 0.25));
    }
    return { ok: true };
  }
}

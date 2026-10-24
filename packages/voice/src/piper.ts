import { promises as fs } from "node:fs";
import path from "node:path";
import { runProcess, sha256Hex } from "@creatorflow/core";
import type { CreatorFlowConfig } from "@creatorflow/schemas";
import type { HealthResult, SynthesisRequest, SynthesisResult, VoiceCapabilities, VoiceInfo, VoiceProvider } from "./provider.ts";

export const PIPER_ADAPTER_VERSION = "1";

interface PiperModelConfig {
  audio?: { sample_rate?: number; quality?: string };
  espeak?: { voice?: string };
  language?: { code?: string; family?: string; region?: string };
  num_speakers?: number;
  dataset?: string;
  piper_version?: string;
}

/** "en_US" / "en-us" -> "en-US". */
export function piperLanguage(cfg: PiperModelConfig): string | undefined {
  const raw = cfg.language?.code ?? cfg.espeak?.voice;
  if (!raw) return undefined;
  const [l, r] = raw.replace("_", "-").split("-");
  return r ? `${l!.toLowerCase()}-${r.toUpperCase()}` : l!.toLowerCase();
}

/**
 * Piper (rhasspy/piper C++ command-line contract: text on stdin, --model,
 * --output_file, --length_scale). The binary and the voice model are installed
 * by the user and referenced by path; CreatorFlow never downloads either.
 * Note: the OHF-Voice/piper1-gpl Python CLI uses different flags and is not
 * covered by this adapter.
 */
export class PiperProvider implements VoiceProvider {
  readonly id = "piper";
  private readonly exe?: string;
  private readonly extraArgs: string[];
  private readonly model?: string;
  private readonly speaker?: number;

  constructor(config: CreatorFlowConfig) {
    const p = config.voice.piper;
    this.exe = p.executable;
    this.extraArgs = p.extraArgs;
    this.model = p.model;
    this.speaker = p.speaker;
  }

  async health(signal?: AbortSignal): Promise<HealthResult> {
    const missing = (message: string): HealthResult => ({ ready: false, code: "VOICE_PROVIDER_UNAVAILABLE", message });
    if (!this.exe) return missing("piper: voice.piper.executable is not set. Install Piper yourself and point this at the binary (nothing is downloaded automatically)");
    if (!this.model) return missing("piper: voice.piper.model is not set. Download a voice model (.onnx + .onnx.json) yourself and set its path");
    const exeSt = await fs.stat(this.exe).catch(() => undefined);
    if (!exeSt?.isFile()) return missing(`piper: executable ${path.basename(this.exe)} was not found at the configured path`);
    const modelSt = await fs.stat(this.model).catch(() => undefined);
    if (!modelSt?.isFile()) return missing(`piper: model ${path.basename(this.model)} was not found at the configured path`);
    let cfg: PiperModelConfig;
    let cfgRaw: string;
    try {
      cfgRaw = await fs.readFile(`${this.model}.json`, "utf8");
      cfg = JSON.parse(cfgRaw) as PiperModelConfig;
    } catch {
      return missing(`piper: model config ${path.basename(this.model)}.json is missing or not JSON (it must sit next to the model)`);
    }
    const language = piperLanguage(cfg);
    const sampleRate = cfg.audio?.sample_rate;
    if (!language || !sampleRate) return missing("piper: the model config has no language code or sample rate");
    const v = await runProcess(this.exe, [...this.extraArgs, "--version"], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
    if (v.errorCode) return missing(`piper: the executable could not be run (${v.errorCode})`);
    const engineVersion = v.exitCode === 0 ? v.stdout.trim().split(/\r?\n/)[0]!.slice(0, 80) || "unknown" : "unknown";
    const name = path.basename(this.model, ".onnx");
    const voice: VoiceInfo = { id: name, name, language, ...(cfg.audio?.quality ? { version: cfg.audio.quality } : {}) };
    const capabilities: VoiceCapabilities = {
      providerId: this.id,
      displayName: "Piper (local neural TTS)",
      adapterVersion: PIPER_ADAPTER_VERSION,
      engineVersion,
      network: "none",
      languages: [language],
      voices: [voice],
      requirements: [
        { kind: "binary", description: "piper executable", target: path.basename(this.exe), present: true },
        { kind: "model", description: "Piper voice model + .onnx.json", target: name, present: true },
      ],
      output: { container: "wav", encoding: "pcm_s16le", sampleRates: [sampleRate], channels: 1 },
      controls: { speakingRate: { supported: true, min: 0.5, max: 2, mapping: "length_scale = 1 / speakingRate" }, pitch: { supported: false }, voiceSelection: false },
      limits: { maxCharsPerRequest: 5000 },
      timestamps: "none",
      license: {
        engine: "Piper as installed by you (rhasspy/piper: MIT, archived 2025; OHF-Voice/piper1-gpl: GPL-3.0). Check the licence of your build",
        voices: `voice model "${name}"${cfg.dataset ? ` (dataset ${cfg.dataset})` : ""}: licence not recorded in the model config; see its MODEL_CARD`,
        notes: ["CreatorFlow has not verified the voice model's licence or any attribution it requires."],
      },
    };
    return { ready: true, capabilities, fingerprint: { engine: engineVersion, adapter: PIPER_ADAPTER_VERSION, model: name, modelBytes: modelSt.size, modelMtimeMs: Math.round(modelSt.mtimeMs), modelConfig: `sha256:${sha256Hex(cfgRaw)}`, speaker: this.speaker ?? null } };
  }

  describeRate(speakingRate: number): string {
    return `length_scale ${Math.round((1 / speakingRate) * 1000) / 1000} (requested ${speakingRate})`;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    if (!this.exe || !this.model) return { ok: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: "piper is not configured", retryable: false };
    const lengthScale = Math.round((1 / req.speakingRate) * 1000) / 1000;
    for (const it of req.items) {
      const args = [...this.extraArgs, "--model", this.model, "--output_file", it.out, "--length_scale", String(lengthScale), "--sentence_silence", "0", ...(this.speaker !== undefined ? ["--speaker", String(this.speaker)] : [])];
      const r = await runProcess(this.exe, args, { signal: req.signal, input: `${it.text.replace(/\s+/g, " ")}\n`, timeoutMs: 120_000 });
      if (r.errorCode === "ABORTED") return { ok: false, code: "VOICE_SYNTHESIS_FAILED", message: "cancelled", retryable: true };
      if (r.errorCode === "ENOENT" || r.errorCode === "SPAWN_FAILED") return { ok: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: "piper could not be started", retryable: false };
      if (r.exitCode !== 0) return { ok: false, code: "VOICE_SYNTHESIS_FAILED", message: `piper exited ${r.exitCode ?? r.errorCode}: ${r.stderr.trim().slice(-300)}`, retryable: true };
    }
    return { ok: true };
  }
}

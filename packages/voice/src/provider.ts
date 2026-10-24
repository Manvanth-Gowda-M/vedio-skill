import type { CreatorFlowConfig } from "@creatorflow/schemas";

/** A voice offered by a provider. */
export interface VoiceInfo {
  id: string;
  name: string;
  /** BCP 47 tag, e.g. "en-US". */
  language: string;
  gender?: string;
  version?: string;
}

export interface Requirement {
  kind: "platform" | "binary" | "model" | "runtime";
  description: string;
  /** Path or name checked (redact private paths before showing). */
  target?: string;
  present: boolean;
}

/** Explicit capability report. Nothing here is assumed: health() measures it. */
export interface VoiceCapabilities {
  providerId: string;
  displayName: string;
  /** Adapter version (bump when synthesis behaviour changes; part of fingerprints). */
  adapterVersion: string;
  /** Engine version as reported by the engine, or "unknown". */
  engineVersion: string;
  /** All bundled providers are local; online providers would say so here. */
  network: "none";
  languages: string[];
  voices: VoiceInfo[];
  requirements: Requirement[];
  output: { container: "wav"; encoding: "pcm_s16le"; sampleRates: number[] | "any"; channels: 1 };
  controls: {
    speakingRate: { supported: boolean; min?: number; max?: number; mapping?: string };
    pitch: { supported: false };
    voiceSelection: boolean;
  };
  limits: { maxCharsPerRequest: number };
  /** Timestamps the engine itself provides. CreatorFlow measures sentence boundaries from audio. */
  timestamps: "none";
  license: { engine: string; voices: string; notes: string[] };
}

export type HealthResult =
  | { ready: true; capabilities: VoiceCapabilities; fingerprint: Record<string, string | number | null> }
  | { ready: false; code: "VOICE_PROVIDER_UNAVAILABLE"; message: string; capabilities?: Partial<VoiceCapabilities> };

export interface SynthesisRequest {
  voice: VoiceInfo;
  speakingRate: number;
  sampleRate: number;
  /** One request per sentence; `out` is an absolute .wav path in a private temp dir. */
  items: { id: string; text: string; out: string }[];
  tmpDir: string;
  signal: AbortSignal;
}

export type SynthesisResult =
  | { ok: true }
  | { ok: false; code: "VOICE_SYNTHESIS_FAILED" | "VOICE_OPTION_UNSUPPORTED" | "VOICE_PROVIDER_UNAVAILABLE"; message: string; retryable: boolean };

export interface VoiceProvider {
  readonly id: string;
  health(signal?: AbortSignal): Promise<HealthResult>;
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
  /** How a requested speaking rate is actually applied by this engine (recorded verbatim). */
  describeRate(speakingRate: number): string;
}

/** Explicitly no narration. Every request is answered with a typed "unavailable". */
export class NoVoiceProvider implements VoiceProvider {
  readonly id = "none";
  describeRate(): string {
    return "not applicable (no provider)";
  }
  async health(): Promise<HealthResult> {
    return {
      ready: false,
      code: "VOICE_PROVIDER_UNAVAILABLE",
      message: 'providers.tts.id is "none": no voice provider is configured. Set it to "windows-sapi" (built-in Windows voices) or "piper" (a locally installed Piper binary and model), or set the profile voice.mode to "none" for silent videos',
    };
  }
  async synthesize(): Promise<SynthesisResult> {
    return { ok: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: "no voice provider is configured", retryable: false };
  }
}

export const KNOWN_VOICE_PROVIDERS = ["none", "windows-sapi", "piper"] as const;

export interface ProviderFactoryDeps {
  platform?: NodeJS.Platform;
}

/** Narrows a tag to its base language ("en-US" -> "en"). */
export const baseLang = (tag: string) => tag.split("-")[0]!.toLowerCase();

/**
 * Picks the voice for a script language: the requested voice (by id or name)
 * if it speaks the language, otherwise the first voice (by name) with the exact
 * tag, then the same base language. Never silently swaps a requested voice.
 */
export function chooseVoice(voices: readonly VoiceInfo[], language: string, requested?: string): { ok: true; voice: VoiceInfo } | { ok: false; code: "VOICE_NOT_FOUND" | "VOICE_LANGUAGE_UNSUPPORTED"; message: string } {
  const sorted = [...voices].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (requested) {
    const v = sorted.find((x) => x.id === requested || x.name.toLowerCase() === requested.toLowerCase());
    if (!v) return { ok: false, code: "VOICE_NOT_FOUND", message: `voice "${requested}" is not installed. Available: ${sorted.map((x) => `${x.name} (${x.language})`).join(", ") || "none"}` };
    if (baseLang(v.language) !== baseLang(language)) return { ok: false, code: "VOICE_LANGUAGE_UNSUPPORTED", message: `voice "${v.name}" speaks ${v.language}, but the script is ${language}` };
    return { ok: true, voice: v };
  }
  const exact = sorted.find((v) => v.language.toLowerCase() === language.toLowerCase());
  const base = sorted.find((v) => baseLang(v.language) === baseLang(language));
  const v = exact ?? base;
  if (!v) return { ok: false, code: "VOICE_LANGUAGE_UNSUPPORTED", message: `no installed voice speaks ${language}. Installed: ${sorted.map((x) => `${x.name} (${x.language})`).join(", ") || "none"}` };
  return { ok: true, voice: v };
}

export type ProviderFactory = (config: CreatorFlowConfig, deps?: ProviderFactoryDeps) => VoiceProvider;

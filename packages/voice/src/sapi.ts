import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "@creatorflow/core";
import type { CreatorFlowConfig } from "@creatorflow/schemas";
import type { HealthResult, SynthesisRequest, SynthesisResult, VoiceCapabilities, VoiceInfo, VoiceProvider } from "./provider.ts";

const BRIDGE = readFileSync(fileURLToPath(new URL("./sapi-bridge.ps1", import.meta.url)), "utf8");
export const SAPI_ADAPTER_VERSION = "1";

/** SAPI Rate is an integer -10..10; +10 is about 3x and -10 about 1/3x the default speed. */
export function sapiRate(speakingRate: number): number {
  return Math.max(-10, Math.min(10, Math.round((10 * Math.log(speakingRate)) / Math.log(3))));
}

interface BridgeVoice {
  id: string;
  name: string;
  culture: string;
  gender: string;
  enabled: boolean;
  version: string | null;
}

/**
 * Windows built-in voices through System.Speech (SAPI 5), driven by a small
 * PowerShell bridge passed with -EncodedCommand (no script file, no
 * execution-policy change). Desktop SAPI voices only: the newer OneCore voices
 * shown in Windows Settings are not exposed to System.Speech.
 */
export class WindowsSapiProvider implements VoiceProvider {
  readonly id = "windows-sapi";
  private readonly powershell: string;
  private readonly platform: NodeJS.Platform;
  private cached?: { at: number; result: HealthResult };

  constructor(config: CreatorFlowConfig, deps: { platform?: NodeJS.Platform } = {}) {
    this.powershell = config.voice.windowsSapi.powershell ?? "powershell.exe";
    this.platform = deps.platform ?? process.platform;
  }

  private async bridge(job: unknown, signal?: AbortSignal, timeoutMs = 60_000): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string; spawn?: boolean }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cf-sapi-${process.pid}-`));
    try {
      const jobFile = path.join(dir, "job.json");
      await fs.writeFile(jobFile, JSON.stringify(job), "utf8");
      const script = `$JobFile = '${jobFile.replace(/'/g, "''")}'\n${BRIDGE}`;
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const r = await runProcess(this.powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeoutMs, ...(signal ? { signal } : {}) });
      if (r.errorCode === "ABORTED") return { ok: false, message: "cancelled" };
      if (r.errorCode === "ENOENT" || r.errorCode === "SPAWN_FAILED") return { ok: false, message: `${this.powershell} could not be started`, spawn: true };
      if (r.errorCode === "TIMEOUT") return { ok: false, message: `SAPI bridge timed out after ${timeoutMs} ms` };
      const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("CF_RESULT "));
      if (!line) return { ok: false, message: `SAPI bridge produced no result (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(-400)}` };
      const value = JSON.parse(line.slice(10)) as Record<string, unknown>;
      if (value["ok"] !== true) return { ok: false, message: `SAPI error: ${String(value["error"] ?? "unknown")}` };
      return { ok: true, value };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async health(signal?: AbortSignal): Promise<HealthResult> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.result;
    const result = await this.measure(signal);
    if (!signal?.aborted) this.cached = { at: Date.now(), result };
    return result;
  }

  private async measure(signal?: AbortSignal): Promise<HealthResult> {
    if (this.platform !== "win32") return { ready: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: `windows-sapi needs Windows (this is ${this.platform}); use "piper" instead` };
    const r = await this.bridge({ mode: "list" }, signal, 30_000);
    if (!r.ok) return { ready: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: `windows-sapi is not usable: ${r.message}` };
    const raw = (Array.isArray(r.value["voices"]) ? r.value["voices"] : r.value["voices"] ? [r.value["voices"]] : []) as BridgeVoice[];
    const voices: VoiceInfo[] = raw.filter((v) => v.enabled).map((v) => ({ id: v.id, name: v.name, language: v.culture, gender: v.gender, ...(v.version ? { version: v.version } : {}) }));
    const engineVersion = `System.Speech ${String(r.value["speech"])} on Windows ${String(r.value["os"])}`;
    const capabilities: VoiceCapabilities = {
      providerId: this.id,
      displayName: "Windows SAPI 5 (System.Speech)",
      adapterVersion: SAPI_ADAPTER_VERSION,
      engineVersion,
      network: "none",
      languages: [...new Set(voices.map((v) => v.language))].sort(),
      voices,
      requirements: [
        { kind: "platform", description: "Windows", present: true },
        { kind: "runtime", description: "Windows PowerShell with .NET System.Speech", target: this.powershell, present: true },
      ],
      output: { container: "wav", encoding: "pcm_s16le", sampleRates: "any", channels: 1 },
      controls: { speakingRate: { supported: true, min: 1 / 3, max: 3, mapping: "integer SAPI Rate -10..10 (approximate)" }, pitch: { supported: false }, voiceSelection: true },
      limits: { maxCharsPerRequest: 5000 },
      timestamps: "none",
      license: {
        engine: "Microsoft Windows built-in speech (SAPI 5 / System.Speech), governed by your Windows licence",
        voices: "Microsoft desktop voices, governed by your Windows licence",
        notes: ["CreatorFlow has not verified whether your Windows licence permits publishing synthesised speech commercially; check Microsoft's terms before publishing."],
      },
    };
    if (!voices.length) return { ready: false, code: "VOICE_PROVIDER_UNAVAILABLE", message: "windows-sapi found no enabled SAPI voices", capabilities };
    return { ready: true, capabilities, fingerprint: { engine: engineVersion, adapter: SAPI_ADAPTER_VERSION, voices: voices.map((v) => `${v.id}@${v.version ?? "?"}`).join(",") } };
  }

  describeRate(speakingRate: number): string {
    const r = sapiRate(speakingRate);
    return `SAPI Rate ${r} (about ${(3 ** (r / 10)).toFixed(2)}x; requested ${speakingRate})`;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const rate = sapiRate(req.speakingRate);
    // One bridge process for every sentence; a generous bound per sentence, plus the step timeout via signal.
    const r = await this.bridge({ mode: "speak", voice: req.voice.name, rate, sampleRate: req.sampleRate, items: req.items.map((i) => ({ out: i.out, text: i.text })) }, req.signal, 30_000 + req.items.length * 30_000);
    if (!r.ok) return { ok: false, code: r.spawn ? "VOICE_PROVIDER_UNAVAILABLE" : "VOICE_SYNTHESIS_FAILED", message: r.message, retryable: !r.spawn };
    return { ok: true };
  }
}

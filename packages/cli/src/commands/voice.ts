import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreatorFlowError, ExitCode, writeFileAtomic, type ExitCodeValue } from "@creatorflow/core";
import { audioStats, chooseVoice, KNOWN_VOICE_PROVIDERS, parseWav, speechBounds, voiceProviderFor, type HealthResult } from "@creatorflow/voice";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

/** Hides the user's home directory in paths shown to the user or written to JSON. */
const redactHome = (s: string) => s.split(os.homedir()).join("~");

function describe(h: HealthResult) {
  const caps = h.ready ? h.capabilities : h.capabilities;
  return JSON.parse(redactHome(JSON.stringify({ ready: h.ready, ...(h.ready ? {} : { code: h.code, message: h.message }), capabilities: caps ?? null })));
}

export async function voiceProvidersCommand(o: Output, dir: string): Promise<ExitCodeValue> {
  const project = await requireProject(dir);
  const results = [];
  for (const id of KNOWN_VOICE_PROVIDERS) {
    const cfg = { ...project.config, providers: { ...project.config.providers, tts: { ...project.config.providers.tts, id } } };
    results.push({ id, configured: project.config.providers.tts.id === id, ...describe(await voiceProviderFor(cfg).health()) });
  }
  o.result({ ok: true, configured: project.config.providers.tts.id, voiceMode: project.profile.voice.mode, providers: results });
  o.line(`Narration: profile voice.mode "${project.profile.voice.mode}", providers.tts.id "${project.config.providers.tts.id}"`);
  for (const r of results) {
    const c = r.capabilities as { voices?: { name: string; language: string }[]; engineVersion?: string; controls?: { speakingRate: { supported: boolean; mapping?: string } } } | null;
    o.line(`  ${r.configured ? "*" : " "} ${r.id.padEnd(13)} ${r.ready ? "READY" : "UNAVAILABLE"}${r.ready ? ` — ${c?.engineVersion}; voices: ${c?.voices?.map((v) => `${v.name} (${v.language})`).join(", ")}; rate: ${c?.controls?.speakingRate.supported ? c.controls.speakingRate.mapping : "not supported"}; pitch: not supported; timestamps: measured from audio by CreatorFlow (sentence level)` : ` — ${r.message}`}`);
  }
  o.line("All providers run locally; nothing is downloaded. Install engines and models yourself (see skills/creatorflow/references/voice.md).");
  return ExitCode.OK;
}

/** Synthesises one sample sentence with the configured provider and measures it (no workflow state changes). */
export async function voiceTestCommand(o: Output, dir: string, f: { text?: string; out?: string; lang?: string }): Promise<ExitCodeValue> {
  const project = await requireProject(dir);
  const provider = voiceProviderFor(project.config);
  const h = await provider.health();
  if (!h.ready) {
    o.result({ ok: false, provider: provider.id, ...describe(h) });
    o.line(`${provider.id}: UNAVAILABLE — ${h.message}`);
    return ExitCode.CHECK_FAILED;
  }
  const lang = f.lang ?? project.profile.languages.primary;
  const v = chooseVoice(h.capabilities.voices, lang, project.profile.voice.voiceId);
  if (!v.ok) throw new CreatorFlowError(v.message, { code: v.code, exitCode: ExitCode.CHECK_FAILED });
  const text = f.text ?? "This is a CreatorFlow narration test.";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `cf-voice-${process.pid}-`));
  try {
    const out = path.join(tmp, "test.wav");
    const sampleRate = h.capabilities.output.sampleRates === "any" ? project.config.voice.sampleRate : h.capabilities.output.sampleRates[0]!;
    const ac = new AbortController();
    const r = await provider.synthesize({ voice: v.voice, speakingRate: project.profile.voice.speakingRate, sampleRate, items: [{ id: "t", text, out }], tmpDir: tmp, signal: ac.signal });
    if (!r.ok) throw new CreatorFlowError(r.message, { code: r.code, exitCode: ExitCode.CHECK_FAILED });
    const buf = await fs.readFile(out);
    const a = parseWav(buf);
    const st = audioStats(a);
    const b = speechBounds(a);
    let saved: string | undefined;
    if (f.out) {
      saved = path.resolve(f.out);
      await writeFileAtomic(saved, buf);
    }
    const ok = Boolean(b);
    o.result({ ok, provider: provider.id, voice: v.voice, rate: provider.describeRate(project.profile.voice.speakingRate), sampleRate: a.sampleRate, ...st, speech: b ? { startMs: Math.round((b.start * 1000) / a.sampleRate), endMs: Math.round((b.end * 1000) / a.sampleRate) } : null, saved: saved ? redactHome(saved) : null });
    o.line(`${provider.id} / ${v.voice.name} (${v.voice.language}): ${st.durationMs} ms at ${a.sampleRate} Hz, peak ${st.peakDbfs} dBFS, RMS ${st.rmsDbfs} dBFS, ${st.clippedSamples} clipped samples; speech ${b ? "detected" : "NOT detected"}`);
    if (saved) o.line(`  saved to ${saved}`);
    return ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

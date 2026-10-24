import type { CreatorFlowConfig } from "@creatorflow/schemas";
import { PiperProvider } from "./piper.ts";
import { KNOWN_VOICE_PROVIDERS, NoVoiceProvider, type VoiceProvider } from "./provider.ts";
import { WindowsSapiProvider } from "./sapi.ts";

const cache = new Map<string, VoiceProvider>();

/**
 * Provider for providers.tts.id. Instances are memoised per configuration so
 * health checks (which start a process) are not repeated for every job.
 * Unknown ids throw: they are configuration errors, not "unavailable" engines.
 */
export function voiceProviderFor(config: CreatorFlowConfig): VoiceProvider {
  const id = config.providers.tts.id;
  const key = JSON.stringify({ id, voice: config.voice });
  const hit = cache.get(key);
  if (hit) return hit;
  let p: VoiceProvider;
  if (id === "none") p = new NoVoiceProvider();
  else if (id === "windows-sapi") p = new WindowsSapiProvider(config);
  else if (id === "piper") p = new PiperProvider(config);
  else throw new Error(`providers.tts.id "${id}" is not a known voice provider (known: ${KNOWN_VOICE_PROVIDERS.join(", ")})`);
  cache.set(key, p);
  return p;
}

/** Test hook: forget memoised providers (and their cached health). */
export function clearVoiceProviderCache(): void {
  cache.clear();
}

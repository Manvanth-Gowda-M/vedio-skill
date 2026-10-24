import { ManualSourcesProvider } from "./local-provider.ts";
import { selectResearchProvider, type ProviderFactory, type ResearchProvider } from "./provider.ts";
import type { ProviderRef } from "@creatorflow/schemas";

export * from "./text.ts";
export * from "./provider.ts";
export * from "./local-provider.ts";
export * from "./assess.ts";
export * from "./session.ts";
export * from "./scoring.ts";
export * from "./planner.ts";
export * from "./executor.ts";

/** Research providers available in this release. Only local import is implemented; nothing here goes online. */
export const RESEARCH_PROVIDERS: Record<string, ProviderFactory> = {
  "manual-sources": () => new ManualSourcesProvider(),
};

export function researchProviderFor(ref: ProviderRef): ResearchProvider {
  return selectResearchProvider(ref, RESEARCH_PROVIDERS);
}

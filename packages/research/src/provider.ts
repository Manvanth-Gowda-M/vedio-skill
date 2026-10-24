import type { CandidateInput, ClaimInput, ImportIssue, ProviderRef, SourceInput } from "@creatorflow/schemas";

/**
 * Provider-neutral research interface. Providers report what they can do;
 * callers must check capabilities and handle typed `UNSUPPORTED` results.
 * No provider may fabricate sources, dates, quotes or trend data.
 */
export interface ResearchCapabilities {
  /** Import user-supplied files from the local filesystem. */
  importLocal: boolean;
  /** Query a search engine for current sources. */
  webSearch: boolean;
  /** Fetch a URL and snapshot it. */
  fetchUrl: boolean;
  /** Use a language model to summarise or extract claims (output must still cite sources). */
  modelAssist: boolean;
}

export type ProviderErrorCode = "UNSUPPORTED" | "INVALID_INPUT" | "NOT_FOUND" | "DISABLED";

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  capability?: keyof ResearchCapabilities;
  issues?: ImportIssue[];
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export interface ParsedSnapshot {
  originalName: string;
  mediaType: "text/html" | "text/plain" | "text/markdown";
  sha256: string;
  bytes: number;
  /** Extracted plain text (untrusted data). */
  text: string;
}

export interface ParsedSource {
  input: SourceInput;
  importedFrom: string;
  snapshot?: ParsedSnapshot;
}

/** Records that passed per-record validation, plus issues for those that did not. */
export interface ImportBundle {
  files: string[];
  inputHash: string;
  sessionTopic?: string;
  sources: ParsedSource[];
  claims: ClaimInput[];
  candidates: CandidateInput[];
  issues: ImportIssue[];
}

export interface ResearchProvider {
  readonly id: string;
  readonly version: string;
  readonly capabilities: ResearchCapabilities;
  importLocal(request: { path: string }): Promise<ProviderResult<ImportBundle>>;
  search(request: { query: string }): Promise<ProviderResult<ImportBundle>>;
}

export const NO_CAPABILITIES: ResearchCapabilities = { importLocal: false, webSearch: false, fetchUrl: false, modelAssist: false };

export function unsupported(providerId: string, capability: keyof ResearchCapabilities, detail?: string): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code: "UNSUPPORTED",
      capability,
      message: `Research provider "${providerId}" does not support ${capability}${detail ? `: ${detail}` : ""}.`,
    },
  };
}

/** Stands in for providers that are configured but not implemented. Never returns data. */
export class UnavailableResearchProvider implements ResearchProvider {
  readonly id: string;
  readonly version = "0";
  readonly capabilities = NO_CAPABILITIES;
  readonly reason: string;
  constructor(id: string, reason: string) {
    this.id = id;
    this.reason = reason;
  }
  async importLocal(): Promise<ProviderResult<ImportBundle>> {
    return { ok: false, error: { code: this.reason.startsWith("disabled") ? "DISABLED" : "UNSUPPORTED", capability: "importLocal", message: `Research provider "${this.id}" is ${this.reason}.` } };
  }
  async search(): Promise<ProviderResult<ImportBundle>> {
    return { ok: false, error: { code: this.reason.startsWith("disabled") ? "DISABLED" : "UNSUPPORTED", capability: "webSearch", message: `Research provider "${this.id}" is ${this.reason}.` } };
  }
}

export type ProviderFactory = (ref: ProviderRef) => ResearchProvider;

/** Selects the configured provider. Unknown ids get an honest unavailable provider, never a substitute. */
export function selectResearchProvider(ref: ProviderRef, factories: Record<string, ProviderFactory>): ResearchProvider {
  if (!ref.enabled) return new UnavailableResearchProvider(ref.id, "disabled in creatorflow.config.json (providers.research.enabled = false)");
  const factory = factories[ref.id];
  if (!factory) {
    return new UnavailableResearchProvider(ref.id, `not available in this release (available: ${Object.keys(factories).join(", ")})`);
  }
  return factory(ref);
}

// FICTIONAL evidence packs and plan items for script/localization unit tests.
import { fingerprint } from "@creatorflow/core";
import {
  CreatorFlowConfigSchema,
  CreatorProfileSchema,
  PlanItemSchema,
  ResearchEvidencePackSchema,
  type CreatorFlowConfig,
  type CreatorProfile,
  type PlanItem,
  type ResearchEvidencePack,
} from "@creatorflow/schemas";
import type { ScriptRequest } from "@creatorflow/scriptwriter";
import { RESEARCH_PROFILE } from "./research-fixture.ts";

const H = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

export function makePack(over: Partial<ResearchEvidencePack> = {}): ResearchEvidencePack {
  return ResearchEvidencePackSchema.parse({
    schemaVersion: 1,
    kind: "research-evidence",
    contentId: "hooks-explained",
    sessionId: "main",
    candidateId: "cand-hooks-explained",
    evidenceHash: H(1),
    asOf: "2026-10-28",
    topic: "Agent hooks explained",
    claims: [
      { claimId: "clm-c-hooks", kind: "fact", text: "Hooks run before and after each tool call.", support: "supported", usage: "state-as-fact-with-citation", evidence: [{ sourceId: "src-docs", kind: "quote", excerpt: "Hooks run before and after each tool call", check: "found-in-snapshot" }] },
      { claimId: "clm-c-config", kind: "fact", text: "Hooks are configured in a JSON file.", support: "supported-unchecked", usage: "state-as-fact-cite-and-verify", evidence: [{ sourceId: "src-changelog", kind: "paraphrase", check: "not-checked" }] },
      { claimId: "clm-c-opinion", kind: "interpretation", text: "Hooks are the most underrated agent feature.", support: "interpretation", usage: "present-as-opinion", evidence: [] },
      { claimId: "clm-c-hypo", kind: "hypothesis", text: "Hooks may replace some CI checks.", support: "hypothesis", usage: "present-as-question", evidence: [] },
    ],
    sources: [
      { sourceId: "src-docs", contentHash: H(2), url: "https://docs.example.com/hooks", title: "Agent hooks (fictional docs)", publisher: "Example Tools", sourceType: "official-documentation", publishedAt: "2026-09-01", attribution: "Example Tools documentation", usageRestrictions: ["Quote at most two sentences"], verification: { status: "excerpts-found-in-snapshot", notes: [] }, missingMetadata: [], untrustedContentWarnings: [] },
      { sourceId: "src-changelog", contentHash: H(3), url: "https://example.com/changelog", title: "Changelog (fictional)", publisher: "Example Tools", sourceType: "changelog", publishedAt: "2026-10-22", usageRestrictions: [], verification: { status: "no-snapshot", notes: [] }, missingMetadata: ["retrievedAt"], untrustedContentWarnings: [] },
    ],
    caveats: [],
    ...over,
  });
}

export function makeItem(over: Record<string, unknown> = {}): PlanItem {
  return PlanItemSchema.parse({
    contentId: "hooks-explained",
    publishDate: "2026-10-28",
    topic: "Agent hooks explained",
    workingTitle: "What agent hooks actually do",
    hook: "Your agent runs code you never see.",
    category: "explainer",
    platform: "youtube-shorts",
    aspectRatio: "9:16",
    language: "en",
    durationSec: 30,
    ...over,
  });
}

export function makeProfile(over: Record<string, unknown> = {}): CreatorProfile {
  return CreatorProfileSchema.parse({
    schemaVersion: 1,
    ...RESEARCH_PROFILE,
    brand: {
      name: "Fixture Brand",
      colors: { primary: "#111111", secondary: "#222222", accent: "#333333", background: "#000000", text: "#FFFFFF" },
      fonts: {
        heading: { family: "Inter", source: "google-fonts", license: "OFL-1.1" },
        body: { family: "Inter", source: "google-fonts", license: "OFL-1.1" },
        mono: { family: "JetBrains Mono", source: "google-fonts", license: "OFL-1.1" },
      },
    },
    visual: { styles: ["motion-typography", "technical-diagrams", "code-demos"] },
    voice: { mode: "none" },
    schedule: { timezone: "UTC", durations: { shortForm: { minSec: 20, maxSec: 60 }, longForm: { minSec: 120, maxSec: 900 } } },
    content: {},
    approval: {},
    ...over,
  });
}

export function makeConfig(over: Record<string, unknown> = {}): CreatorFlowConfig {
  return CreatorFlowConfigSchema.parse({ schemaVersion: 1, ...over });
}

export function makeRequest(over: { item?: PlanItem; pack?: ResearchEvidencePack; profile?: CreatorProfile; config?: CreatorFlowConfig } = {}): ScriptRequest {
  const item = over.item ?? makeItem();
  return {
    jobId: `2026-w44-${item.contentId}`,
    item,
    itemHash: fingerprint(item),
    plan: { weekId: "2026-W44", version: 1, contentHash: H(4) },
    evidence: over.pack ?? makePack(),
    evidenceFile: { path: "research/evidence.json", sha256: H(5) },
    profile: over.profile ?? makeProfile(),
    config: over.config ?? makeConfig(),
  };
}

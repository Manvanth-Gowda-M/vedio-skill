import { fingerprint } from "@creatorflow/core";
import type {
  CandidateRecord,
  ClaimRecord,
  ClaimSupport,
  EvidenceRecord,
  ResearchSession,
  SourceRecord,
  SourceType,
} from "@creatorflow/schemas";
import { dateOnly } from "./text.ts";

/** Evidence weight by source type (documented in references/research-standards.md). */
export const SOURCE_TIER: Record<SourceType, { tier: "primary" | "secondary" | "tertiary"; weight: number }> = {
  "official-documentation": { tier: "primary", weight: 1 },
  "official-announcement": { tier: "primary", weight: 1 },
  changelog: { tier: "primary", weight: 1 },
  repository: { tier: "primary", weight: 1 },
  paper: { tier: "primary", weight: 1 },
  "reputable-reporting": { tier: "secondary", weight: 0.8 },
  community: { tier: "tertiary", weight: 0.4 },
  "user-notes": { tier: "tertiary", weight: 0.3 },
  other: { tier: "tertiary", weight: 0.3 },
};

export const CHECK_FACTOR: Record<EvidenceRecord["check"], number> = {
  "found-in-snapshot": 1,
  "not-checked": 0.7,
  "not-found-in-snapshot": 0,
};

/** The date a source says it was published (falls back to modified). Undefined when the source states neither. */
export function sourceDate(s: Pick<SourceRecord, "publishedAt" | "modifiedAt">): string | undefined {
  const d = s.publishedAt ?? s.modifiedAt;
  return d ? dateOnly(d) : undefined;
}

export interface AssessOptions {
  /** Evidence from sources dated after this day cannot support a claim as of this day. */
  asOf?: string;
  requireSnapshotMatch?: boolean;
}

export interface ClaimAssessment {
  support: ClaimSupport;
  /** Evidence that counts (excerpt not contradicted, source not from the future). */
  usable: EvidenceRecord[];
  /** Best evidence value 0..1 (tier weight x check factor); 0 for non-facts. */
  quality: number;
  notes: string[];
}

export function assessClaim(
  claim: Pick<ClaimRecord, "kind" | "evidence" | "text">,
  sources: Readonly<Record<string, SourceRecord>>,
  options: AssessOptions = {},
): ClaimAssessment {
  const notes: string[] = [];
  const usable: EvidenceRecord[] = [];
  for (const e of claim.evidence) {
    const src = sources[e.sourceId];
    if (!src) {
      notes.push(`evidence source ${e.sourceId} is missing from the session`);
      continue;
    }
    if (e.check === "not-found-in-snapshot") {
      notes.push(`excerpt was not found in the snapshot of "${src.title}"`);
      continue;
    }
    const d = sourceDate(src);
    if (options.asOf && d && d > options.asOf) {
      notes.push(`"${src.title}" is dated ${d}, after ${options.asOf}`);
      continue;
    }
    usable.push(e);
  }
  if (claim.kind !== "fact") return { support: claim.kind, usable, quality: 0, notes };

  let best = 0;
  let checkedStrong = false;
  let uncheckedStrong = false;
  for (const e of usable) {
    const t = SOURCE_TIER[sources[e.sourceId]!.sourceType];
    best = Math.max(best, t.weight * CHECK_FACTOR[e.check]);
    if (t.tier !== "tertiary") {
      if (e.check === "found-in-snapshot") checkedStrong = true;
      else uncheckedStrong = true;
    }
  }
  let support: ClaimSupport;
  if (checkedStrong) support = "supported";
  else if (uncheckedStrong) support = options.requireSnapshotMatch ? "weak" : "supported-unchecked";
  else support = usable.length ? "weak" : "unsupported";
  if (support === "weak" && uncheckedStrong) notes.push("snapshot match required by config but no excerpt was checked");
  return { support, usable, quality: Math.round(best * 1000) / 1000, notes };
}

export interface EvidenceSubset {
  candidate: CandidateRecord;
  claims: ClaimRecord[];
  sources: SourceRecord[];
  /** Claim ids referenced by the candidate but absent from the session. */
  missingClaims: string[];
}

export function evidenceSubset(session: ResearchSession, candidateId: string): EvidenceSubset | undefined {
  const candidate = session.candidates[candidateId];
  if (!candidate) return undefined;
  const claims: ClaimRecord[] = [];
  const missingClaims: string[] = [];
  const sourceIds = new Set<string>();
  for (const id of candidate.claimIds) {
    const c = session.claims[id];
    if (!c) {
      missingClaims.push(id);
      continue;
    }
    claims.push(c);
    for (const e of c.evidence) sourceIds.add(e.sourceId);
  }
  const sources = [...sourceIds].sort().flatMap((id) => (session.sources[id] ? [session.sources[id]!] : []));
  return { candidate, claims, sources, missingClaims };
}

/** Fingerprint of exactly the records a planned item relies on; independent of unrelated records. */
export function evidenceHash(subset: EvidenceSubset): string {
  return fingerprint({
    candidate: [subset.candidate.candidateId, subset.candidate.contentHash],
    claims: subset.claims.map((c) => [c.claimId, c.contentHash]),
    sources: subset.sources.map((s) => [s.sourceId, s.contentHash]),
    missing: subset.missingClaims,
  });
}

export function usageFor(support: ClaimSupport): "state-as-fact-with-citation" | "state-as-fact-cite-and-verify" | "present-as-opinion" | "present-as-question" {
  switch (support) {
    case "supported":
      return "state-as-fact-with-citation";
    case "supported-unchecked":
      return "state-as-fact-cite-and-verify";
    case "interpretation":
      return "present-as-opinion";
    default:
      return "present-as-question";
  }
}

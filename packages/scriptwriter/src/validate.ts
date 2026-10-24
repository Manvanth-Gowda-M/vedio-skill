import { CanonicalScriptSchema, validateArtifact, type CanonicalScript, type EditorialIssue, type ResearchEvidencePack } from "@creatorflow/schemas";
import { baseLanguage } from "./text.ts";

const USAGE: Record<string, string> = {
  supported: "state-as-fact-with-citation",
  "supported-unchecked": "state-as-fact-cite-and-verify",
  interpretation: "present-as-opinion",
};
const usageFor = (support: string) => USAGE[support] ?? "present-as-question";
const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().replace(/[.!?…।]+$/, "");

/**
 * Checks a script against its evidence pack. Provider-independent, so future
 * model-written scripts get the same checks. What it proves: every claim
 * reference exists in this item's pack with the same kind/support/usage, facts
 * are usable, claim-origin segments contain the claim text verbatim, quotes
 * match excerpts found in a saved copy, and every cited source is attributed.
 * What it cannot prove: that free-form (plan/template) wording adds no new
 * facts. That is only flagged heuristically by the provider.
 */
export function validateScriptAgainstEvidence(script: CanonicalScript, pack: ResearchEvidencePack): EditorialIssue[] {
  const issues: EditorialIssue[] = [];
  const err = (code: string, message: string, segmentId?: string) => issues.push({ severity: "error", code, message, ...(segmentId ? { segmentId } : {}) });
  const schema = validateArtifact(CanonicalScriptSchema, script);
  if (!schema.ok) for (const i of schema.issues) err("SCRIPT_SCHEMA", `${i.path}: ${i.message}`);
  if (script.contentId !== pack.contentId) err("EVIDENCE_MISMATCH", `Script is for ${script.contentId} but the evidence pack is for ${pack.contentId}`);
  if (script.evidence.evidenceHash !== pack.evidenceHash) err("EVIDENCE_MISMATCH", "Script was written from different evidence (evidence hash differs)");

  const claims = new Map(pack.claims.map((c) => [c.claimId, c]));
  const sources = new Map(pack.sources.map((s) => [s.sourceId, s]));
  const cited = new Set<string>();
  for (const seg of script.segments) {
    for (const ref of seg.claimRefs) {
      const c = claims.get(ref.claimId);
      if (!c) {
        err("UNKNOWN_CLAIM", `${ref.claimId} is not in this item's evidence pack`, seg.segmentId);
        continue;
      }
      if (ref.kind !== c.kind || ref.support !== c.support) err("CLAIM_STATUS_MISMATCH", `${ref.claimId} is ${c.kind}/${c.support} in the evidence, not ${ref.kind}/${ref.support}`, seg.segmentId);
      if (ref.usage !== usageFor(c.support)) err("CLAIM_USAGE_MISMATCH", `${ref.claimId} must be used as ${usageFor(c.support)}`, seg.segmentId);
      if (c.kind === "fact" && c.support !== "supported" && c.support !== "supported-unchecked") err("CLAIM_NOT_SUPPORTED", `${ref.claimId} is ${c.support} and cannot be stated as fact`, seg.segmentId);
      for (const s of ref.sourceIds) {
        if (!sources.has(s)) err("UNKNOWN_SOURCE", `${s} is not in the evidence pack`, seg.segmentId);
        cited.add(s);
      }
      if (seg.textOrigin.includes("claim") && !norm(seg.narration).includes(norm(c.text))) {
        err("CLAIM_TEXT_ALTERED", `Narration does not contain the exact text of ${ref.claimId}`, seg.segmentId);
      }
      if (baseLanguage(script.language) === "en" && c.kind !== "fact" && /^according to\b/i.test(seg.narration)) {
        err("OPINION_AS_FACT", `${ref.claimId} is ${c.kind} but is phrased as a sourced fact`, seg.segmentId);
      }
    }
    if (seg.visual.sceneType === "source-quote") {
      const quoted = /"([^"]+)"/.exec(seg.narration)?.[1];
      const ok = quoted && seg.claimRefs.some((r) => claims.get(r.claimId)?.evidence.some((e) => e.check === "found-in-snapshot" && e.excerpt && norm(e.excerpt) === norm(quoted)));
      if (!ok) err("QUOTE_NOT_VERIFIED", "Quotation does not match an excerpt found in a saved copy of the source", seg.segmentId);
    }
    for (const s of seg.sourceRefs) {
      if (!sources.has(s)) err("UNKNOWN_SOURCE", `${s} is not in the evidence pack`, seg.segmentId);
      cited.add(s);
    }
    if ((seg.purpose === "explanation" || seg.purpose === "demonstration") && seg.claimRefs.length === 0) err("FACT_WITHOUT_CLAIM", `${seg.purpose} segment references no claim`, seg.segmentId);
    if (seg.textOrigin.includes("claim") && seg.claimRefs.length === 0) err("FACT_WITHOUT_CLAIM", "Segment says it uses claim text but references no claim", seg.segmentId);
  }
  const attributed = new Map(script.attributions.map((a) => [a.sourceId, a]));
  for (const s of cited) {
    const a = attributed.get(s);
    const src = sources.get(s);
    if (!a) err("ATTRIBUTION_MISSING", `Source ${s} is cited but has no attribution entry`);
    else if (src && (a.requiredText ?? null) !== (src.attribution ?? null)) err("ATTRIBUTION_ALTERED", `Attribution text for ${s} must match the source record exactly (required: ${src.attribution ? `"${src.attribution}"` : "none"})`);
    else if (src && JSON.stringify(a.usageRestrictions) !== JSON.stringify(src.usageRestrictions)) err("RESTRICTIONS_DROPPED", `Usage restrictions for ${s} were not kept`);
  }
  return issues;
}

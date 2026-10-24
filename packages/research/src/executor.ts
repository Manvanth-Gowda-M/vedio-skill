import { promises as fs } from "node:fs";
import path from "node:path";
import { isCreatorFlowError, resolveWithin, sha256Hex, stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { PlanStore, StepError, type FingerprintContext, type StepContext, type StepResult, type WorkflowPaths } from "@creatorflow/orchestrator";
import { ResearchEvidencePackSchema, validateArtifact, type ResearchEvidencePack, type ResearchSession } from "@creatorflow/schemas";
import { assessClaim, evidenceHash, evidenceSubset, usageFor } from "./assess.ts";
import type { HistoryTopic } from "./scoring.ts";
import { loadSession, researchPaths } from "./session.ts";

export const RESEARCH_OUTPUT = "research/evidence.json";

/**
 * Fingerprint inputs of the research step: only research-relevant item fields.
 * A new hook, publish date or score (e.g. after re-weighting) does not redo research;
 * a change to the referenced evidence records does.
 */
export function researchStepInputs(ctx: FingerprintContext): unknown {
  const r = ctx.item.research;
  return {
    contentId: ctx.item.contentId,
    topic: ctx.item.topic,
    sourceIds: ctx.item.sourceIds,
    research: r ? { sessionId: r.sessionId, candidateId: r.candidateId, evidenceHash: r.evidenceHash, sources: r.sources, claims: r.claims } : null,
  };
}

export function researchStepConfig(ctx: FingerprintContext): unknown {
  return {
    requireSnapshotMatch: ctx.config.research.requireSnapshotMatch,
    minSupportedFacts: ctx.config.research.minSupportedFacts,
    provider: ctx.config.providers.research.id,
  };
}

/**
 * The research workflow step. It does no new research: it re-verifies that
 * the research the approved plan item was based on is still present and
 * unchanged, re-checks evidence against the publish date, and writes a
 * schema-valid evidence pack for the script stage.
 *
 * - No research reference / missing session / changed records -> BLOCKED (needs the user; no retries used)
 * - Facts no longer supported -> permanent failure (the plan item is not producible as is)
 * - Unexpected I/O errors -> retryable
 */
export async function researchStepExecute(ctx: StepContext): Promise<StepResult> {
  const ref = ctx.item.research;
  if (!ref) {
    return {
      status: "blocked",
      code: "NEEDS_RESEARCH",
      reason: "plan item has no research reference; import sources with `creatorflow research` and generate the plan with `creatorflow plan-week`",
    };
  }
  const rpaths = researchPaths(ctx.workspaceDir);
  let session: ResearchSession | undefined;
  try {
    session = await loadSession(rpaths, ref.sessionId);
  } catch (error) {
    if (isCreatorFlowError(error) && error.code === "RESEARCH_SESSION_CORRUPT") throw new StepError(error.message, { kind: "permanent", code: "RESEARCH_SESSION_CORRUPT" });
    throw error;
  }
  if (!session) {
    return { status: "blocked", code: "RESEARCH_SESSION_MISSING", reason: `research session "${ref.sessionId}" is not in the workspace; re-import its sources` };
  }
  const subset = evidenceSubset(session, ref.candidateId);
  if (!subset) {
    return { status: "blocked", code: "RESEARCH_CHANGED", reason: `candidate ${ref.candidateId} is no longer in session "${ref.sessionId}"; re-run plan-week and approve the new version` };
  }
  const changed: string[] = [];
  for (const s of ref.sources) {
    const cur = session.sources[s.sourceId];
    if (!cur) changed.push(`source ${s.sourceId} removed`);
    else if (cur.contentHash !== s.contentHash) changed.push(`source "${cur.title}" changed`);
  }
  if (evidenceHash(subset) !== ref.evidenceHash) changed.push("evidence records differ from the approved plan");
  if (changed.length) {
    return { status: "blocked", code: "RESEARCH_CHANGED", reason: `${[...new Set(changed)].join("; ")}. Re-run plan-week and approve the new plan version` };
  }

  // Stored snapshot texts must still be the ones that were checked.
  for (const src of subset.sources) {
    const snap = src.provenance.snapshot;
    if (!snap) continue;
    let text: Buffer;
    try {
      text = await fs.readFile(resolveWithin(ctx.workspaceDir, snap.textPath));
    } catch {
      return { status: "blocked", code: "SNAPSHOT_MISSING", reason: `snapshot text for "${src.title}" is missing from the workspace; re-import the session` };
    }
    if (`sha256:${sha256Hex(text)}` !== snap.textSha256) {
      return { status: "blocked", code: "SNAPSHOT_MODIFIED", reason: `snapshot text for "${src.title}" was modified after import; re-import the session` };
    }
  }

  // Evidence must still hold on the publish date (sources dated later cannot be cited).
  const asOf = ctx.item.publishDate;
  const claims: ResearchEvidencePack["claims"] = [];
  const failures: string[] = [];
  for (const c of subset.claims) {
    const a = assessClaim(c, session.sources, { asOf, requireSnapshotMatch: ctx.config.research.requireSnapshotMatch });
    if (c.kind === "fact" && a.support !== "supported" && a.support !== "supported-unchecked") failures.push(`fact "${c.key}" is ${a.support} as of ${asOf}`);
    claims.push({ claimId: c.claimId, kind: c.kind, text: c.text, support: a.support, usage: usageFor(a.support), evidence: a.usable });
  }
  if (subset.missingClaims.length) failures.push(`missing claim(s): ${subset.missingClaims.join(", ")}`);
  if (failures.length) throw new StepError(`Evidence is insufficient: ${failures.join("; ")}`, { kind: "permanent", code: "EVIDENCE_INSUFFICIENT" });

  const caveats: string[] = [];
  for (const s of subset.sources) {
    if (s.verification.status !== "excerpts-found-in-snapshot") caveats.push(`"${s.title}": ${s.verification.status}`);
    if (s.missingMetadata.length) caveats.push(`"${s.title}" is missing ${s.missingMetadata.join(", ")}`);
    if (s.untrustedContentWarnings.length) caveats.push(`"${s.title}" contains instruction-like text (data only): ${s.untrustedContentWarnings.join("; ")}`);
  }

  const pack: ResearchEvidencePack = {
    schemaVersion: 1,
    kind: "research-evidence",
    contentId: ctx.item.contentId,
    sessionId: session.sessionId,
    candidateId: ref.candidateId,
    evidenceHash: ref.evidenceHash,
    asOf,
    topic: ctx.item.topic,
    claims,
    sources: subset.sources.map((s) => ({
      sourceId: s.sourceId,
      contentHash: s.contentHash,
      ...(s.url ? { url: s.url } : {}),
      title: s.title,
      ...(s.publisher ? { publisher: s.publisher } : {}),
      sourceType: s.sourceType,
      ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
      ...(s.modifiedAt ? { modifiedAt: s.modifiedAt } : {}),
      ...(s.retrievedAt ? { retrievedAt: s.retrievedAt } : {}),
      ...(s.attribution ? { attribution: s.attribution } : {}),
      usageRestrictions: s.usageRestrictions,
      verification: s.verification,
      missingMetadata: s.missingMetadata,
      untrustedContentWarnings: s.untrustedContentWarnings,
    })),
    caveats,
  };
  const v = validateArtifact(ResearchEvidencePackSchema, pack);
  if (!v.ok) throw new StepError(`Evidence pack failed schema validation: ${v.issues[0]?.path}: ${v.issues[0]?.message}`, { kind: "permanent", code: "EVIDENCE_PACK_INVALID" });
  if (ctx.signal.aborted) throw ctx.signal.reason;
  const out = ctx.outputPath(RESEARCH_OUTPUT);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await writeFileAtomic(out, stringifyJson(v.value));
  return { status: "succeeded", metadata: { claims: claims.length, sources: pack.sources.length } };
}

/** Topics of approved plans for weeks before `weekId` (most recent `maxWeeks`), used for originality. */
export async function loadPlanHistory(paths: WorkflowPaths, weekId: string, maxWeeks = 8): Promise<{ weeks: string[]; topics: HistoryTopic[] }> {
  const store = new PlanStore(paths);
  const weeks = (await store.weeks()).filter((w) => w < weekId).slice(-maxWeeks);
  const used: string[] = [];
  const topics: HistoryTopic[] = [];
  for (const w of weeks) {
    try {
      const plan = await store.approvedPlan(w);
      used.push(w);
      for (const it of plan.content.items) topics.push({ weekId: w, topic: it.topic });
    } catch (error) {
      if (!isCreatorFlowError(error)) throw error;
    }
  }
  return { weeks: used, topics };
}

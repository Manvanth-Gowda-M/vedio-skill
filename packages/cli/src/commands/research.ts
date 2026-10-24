import { promises as fs } from "node:fs";
import path from "node:path";
import { CreatorFlowError, ExitCode, fingerprint, resolveWithin, stringifyJson, writeFileExclusive, type ExitCodeValue } from "@creatorflow/core";
import { assertWeekId, PlanStore, versionFileName, workflowPaths } from "@creatorflow/orchestrator";
import {
  importIntoSession,
  loadPlanHistory,
  planningFingerprints,
  planWeek,
  publicScore,
  rankCandidates,
  requireSession,
  researchPaths,
  researchProviderFor,
  SCORING_MODEL_VERSION,
  todayIn,
  type ImportResult,
  type ProviderError,
} from "@creatorflow/research";
import { isoWeekOf, PlanningRunSchema, RESEARCH_SCHEMA_VERSION, Slug, validateArtifact, type PlanningRun } from "@creatorflow/schemas";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(v: string, flag: string): string {
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new CreatorFlowError(`${flag} must be a date like 2026-10-26 (got "${v}").`, { code: "USAGE", exitCode: ExitCode.USAGE });
  }
  return v;
}

function assertSession(v: string): string {
  if (!Slug.safeParse(v).success) {
    throw new CreatorFlowError(`Invalid research session id "${v}".`, { code: "USAGE", hint: "Use lowercase letters, digits and single hyphens.", exitCode: ExitCode.USAGE });
  }
  return v;
}

function providerError(e: ProviderError): CreatorFlowError {
  switch (e.code) {
    case "NOT_FOUND":
      return new CreatorFlowError(e.message, { code: "RESEARCH_INPUT_NOT_FOUND", exitCode: ExitCode.NOT_FOUND });
    case "INVALID_INPUT":
      return new CreatorFlowError(e.message, {
        code: "RESEARCH_INPUT_INVALID",
        hint: "Fix the file (schema: packages/schemas/json/research-input.schema.json); nothing was imported.",
        exitCode: ExitCode.CHECK_FAILED,
        ...(e.issues ? { details: e.issues } : {}),
      });
    default:
      return new CreatorFlowError(e.message, {
        code: e.code === "DISABLED" ? "PROVIDER_DISABLED" : "PROVIDER_UNSUPPORTED",
        hint: "This release has no live web research. Save sources locally (JSON + optional HTML/text snapshots) and import them with --input using the manual-sources provider.",
        exitCode: ExitCode.CONFIG,
        details: { capability: e.capability },
      });
  }
}

// ------------------------------------------------------------------ research

export interface ResearchFlags {
  input?: string;
  session: string;
  topic?: string;
  replace?: boolean;
  asOf?: string;
  query?: string;
}

export async function researchCommand(o: Output, dir: string, f: ResearchFlags): Promise<ExitCodeValue> {
  const sessionId = assertSession(f.session);
  const project = await requireProject(dir);
  const ws = resolveWithin(project.paths.dir, project.config.workspaceDir);
  const rpaths = researchPaths(ws);
  const provider = researchProviderFor(project.config.providers.research);

  if (f.query !== undefined) {
    const r = await provider.search({ query: f.query });
    if (!r.ok) throw providerError(r.error);
    throw new CreatorFlowError("Search results are not supported in this release.", { code: "PROVIDER_UNSUPPORTED", exitCode: ExitCode.CONFIG });
  }

  let imported: ImportResult | undefined;
  if (f.input !== undefined) {
    const r = await provider.importLocal({ path: f.input });
    if (!r.ok) throw providerError(r.error);
    imported = await importIntoSession({
      paths: rpaths,
      sessionId,
      bundle: r.value,
      providerId: provider.id,
      ...(f.topic ? { topic: f.topic } : {}),
      replace: Boolean(f.replace),
      requireSnapshotMatch: project.config.research.requireSnapshotMatch,
    });
  }
  const session = imported?.session ?? (await requireSession(rpaths, sessionId));
  const asOf = f.asOf ? assertDate(f.asOf, "--as-of") : todayIn(project.profile.schedule.timezone);
  const history = await loadPlanHistory(workflowPaths(ws), isoWeekOf(asOf));
  const ranking = rankCandidates({ session, profile: project.profile, config: project.config, asOf, history: history.topics }).map(publicScore);
  const unresolved =
    imported?.unresolvedClaims ??
    Object.values(session.claims)
      .filter((c) => c.kind === "fact" && c.support !== "supported" && c.support !== "supported-unchecked")
      .map((c) => ({ claimId: c.claimId, support: c.support, text: c.text }));
  const errors = (imported?.issues ?? []).filter((i) => i.severity === "error");

  o.result({
    ok: errors.length === 0,
    provider: { id: provider.id, capabilities: provider.capabilities },
    limitation: "Only user-supplied sources were used. No live web research or trend data was retrieved.",
    session: {
      sessionId,
      revision: session.revision,
      topic: session.topic,
      sources: Object.keys(session.sources).length,
      claims: Object.keys(session.claims).length,
      candidates: Object.keys(session.candidates).length,
      file: rpaths.sessionFile(sessionId),
    },
    ...(imported ? { import: { status: imported.status, counts: imported.counts, issues: imported.issues } } : {}),
    unresolvedClaims: unresolved,
    asOf,
    scoringModel: SCORING_MODEL_VERSION,
    ranking,
  });

  o.line(`Research session "${sessionId}" (revision ${session.revision}) via ${provider.id}: ${Object.keys(session.sources).length} source(s), ${Object.keys(session.claims).length} claim(s), ${Object.keys(session.candidates).length} candidate(s)`);
  if (imported) {
    const c = imported.counts;
    o.line(`Import ${imported.status}: ${c.added} added, ${c.changed} changed, ${c.unchanged} unchanged, ${c.removed} removed, ${c.duplicates} duplicate(s), ${c.rejected} rejected`);
    for (const i of imported.issues) o.line(`  ${i.severity === "error" ? "REJECTED" : "warning "} ${i.record} ${i.path}: ${i.message}`);
  }
  if (unresolved.length) {
    o.line(`Unresolved fact claims (${unresolved.length}):`);
    for (const u of unresolved) o.line(`  ${u.claimId} [${u.support}] ${u.text.slice(0, 100)}`);
  }
  o.line(`Ranking as of ${asOf} (${SCORING_MODEL_VERSION}; heuristic, not a prediction):`);
  for (const r of ranking) {
    o.line(`  ${r.eligible ? "ELIGIBLE  " : "INELIGIBLE"} ${String(r.score).padStart(5)}  ${r.contentId.padEnd(32)} ${r.category}`);
    if (!r.eligible) for (const x of r.rejections) o.line(`             - ${x.code}: ${x.message}`);
  }
  o.line("Note: only user-supplied sources were used; no live web research or trend data.");
  return errors.length ? ExitCode.CHECK_FAILED : ExitCode.OK;
}

// ------------------------------------------------------------------ plan-week

export interface PlanWeekFlags {
  week?: string;
  session: string;
  asOf?: string;
}

function nextIsoWeek(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  return isoWeekOf(new Date(d.getTime() + 7 * 86_400_000).toISOString().slice(0, 10));
}

export async function planWeekCommand(o: Output, dir: string, f: PlanWeekFlags): Promise<ExitCodeValue> {
  const sessionId = assertSession(f.session);
  const project = await requireProject(dir);
  const ws = resolveWithin(project.paths.dir, project.config.workspaceDir);
  const paths = workflowPaths(ws);
  const rpaths = researchPaths(ws);
  const weekId = assertWeekId(f.week ?? nextIsoWeek(todayIn(project.profile.schedule.timezone)));
  const asOf = f.asOf ? assertDate(f.asOf, "--as-of") : undefined;
  const session = await requireSession(rpaths, sessionId);
  const history = await loadPlanHistory(paths, weekId);
  const result = planWeek({ session, profile: project.profile, config: project.config, weekId, ...(asOf ? { asOf } : {}), history: history.topics });

  if (!result.content) {
    throw new CreatorFlowError(`No eligible topics in research session "${sessionId}" as of ${result.asOf}; no plan was saved.`, {
      code: "NO_ELIGIBLE_TOPICS",
      hint: `Run \`creatorflow research --session ${sessionId} --as-of ${result.asOf}\` to see why each candidate was rejected, then add sourced candidates.`,
      exitCode: ExitCode.CHECK_FAILED,
      details: result.notSelected.map((n) => ({ path: n.candidateId, message: n.reason })),
    });
  }

  const added = await new PlanStore(paths).addVersion(result.content);
  const fps = planningFingerprints(project.profile, project.config);
  const run: PlanningRun = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    kind: "planning-run",
    sessionId,
    sessionRevision: session.revision,
    sessionFingerprint: fingerprint({ sources: Object.values(session.sources).map((s) => [s.sourceId, s.contentHash]), claims: Object.values(session.claims).map((c) => [c.claimId, c.contentHash]), candidates: Object.values(session.candidates).map((c) => [c.candidateId, c.contentHash]) }),
    weekId,
    asOf: result.asOf,
    createdAt: new Date().toISOString(),
    scoringModel: SCORING_MODEL_VERSION,
    weights: { ...project.config.research.weights },
    profileFingerprint: fps.profile,
    configFingerprint: fps.config,
    historyWeeks: history.weeks,
    target: result.target,
    ranking: result.ranking.map(publicScore),
    selected: result.selected,
    notSelected: result.notSelected,
    ...(result.shortfall ? { shortfall: result.shortfall } : {}),
    plan: { version: added.version, contentHash: added.contentHash, status: added.status },
  };
  const v = validateArtifact(PlanningRunSchema, run);
  if (!v.ok) throw new CreatorFlowError("Planning run record is invalid.", { code: "PLANNING_RUN_INVALID", exitCode: ExitCode.INTERNAL, details: v.issues });
  const runFile = resolveWithin(rpaths.runsDir(sessionId), `${weekId}-${versionFileName(added.version)}`);
  await fs.mkdir(path.dirname(runFile), { recursive: true });
  const runWritten = await writeFileExclusive(runFile, stringifyJson(v.value)); // first run for a version is kept; identical re-runs add nothing

  const approveCmd = `creatorflow approve-plan --week ${weekId} --plan-version ${added.version} --hash ${added.contentHash}`;
  o.result({
    ok: !result.shortfall,
    weekId,
    asOf: result.asOf,
    plan: { status: added.status, version: added.version, contentHash: added.contentHash, approved: false },
    items: result.content.items.map((i) => ({ contentId: i.contentId, publishDate: i.publishDate, category: i.category, platform: i.platform, language: i.language, score: i.research?.score, sources: i.sourceIds.length })),
    notSelected: result.notSelected,
    ...(result.shortfall ? { shortfall: result.shortfall } : {}),
    runFile: runWritten ? runFile : undefined,
    next: approveCmd,
  });

  o.line(`${added.status === "created" ? "Saved" : "Unchanged:"} ${weekId} plan v${added.version} (${result.content.items.length} item(s), as of ${result.asOf}) — NOT approved`);
  o.line(`  hash: ${added.contentHash}`);
  for (const i of result.content.items) {
    o.line(`  ${i.publishDate}  ${i.contentId.padEnd(32)} ${i.category.padEnd(10)} ${i.platform.padEnd(15)} ${i.language}  score ${i.research?.score}  ${i.sourceIds.length} source(s)`);
  }
  if (result.notSelected.length) {
    o.line("Not selected:");
    for (const n of result.notSelected) o.line(`  ${n.candidateId}: ${n.reason}`);
  }
  if (result.shortfall) o.warn(`SHORTFALL: ${result.shortfall.message}`);
  o.line(`Review the plan, then approve the exact version with:\n  ${approveCmd}`);
  return result.shortfall ? ExitCode.CHECK_FAILED : ExitCode.OK;
}

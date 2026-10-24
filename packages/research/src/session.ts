import { promises as fs } from "node:fs";
import {
  assertSafeId,
  CreatorFlowError,
  ExitCode,
  fingerprint,
  resolveWithin,
  sha256Hex,
  stringifyJson,
  toPosix,
  withLock,
  writeFileAtomic,
} from "@creatorflow/core";
import {
  RESEARCH_SCHEMA_VERSION,
  ResearchSessionSchema,
  validateArtifact,
  type CandidateRecord,
  type ClaimRecord,
  type EvidenceRecord,
  type ImportIssue,
  type ResearchSession,
  type SourceRecord,
} from "@creatorflow/schemas";
import { assessClaim } from "./assess.ts";
import type { ImportBundle, ParsedSource } from "./provider.ts";
import { canonicalUrl, containsExcerpt, injectionWarnings } from "./text.ts";

export interface ResearchPaths {
  workspaceDir: string;
  root: string;
  sessionDir(id: string): string;
  sessionFile(id: string): string;
  sessionBackup(id: string): string;
  sessionLock(id: string): string;
  snapshotsDir(id: string): string;
  runsDir(id: string): string;
}

export function researchPaths(workspaceDir: string): ResearchPaths {
  const ws = resolveWithin(workspaceDir, ".");
  const root = resolveWithin(ws, "research");
  const dir = (id: string) => resolveWithin(root, assertSafeId(id, "research session id"));
  return {
    workspaceDir: ws,
    root,
    sessionDir: dir,
    sessionFile: (id) => resolveWithin(dir(id), "session.json"),
    sessionBackup: (id) => resolveWithin(dir(id), "session.prev.json"),
    sessionLock: (id) => resolveWithin(dir(id), "session.lock"),
    snapshotsDir: (id) => resolveWithin(dir(id), "snapshots"),
    runsDir: (id) => resolveWithin(dir(id), "runs"),
  };
}

export async function loadSession(paths: ResearchPaths, sessionId: string): Promise<ResearchSession | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.sessionFile(sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw corrupt(paths, sessionId, [{ path: "(file)", message: (error as Error).message }]);
  }
  const v = validateArtifact(ResearchSessionSchema, data);
  if (!v.ok || v.value.sessionId !== sessionId) throw corrupt(paths, sessionId, v.ok ? [{ path: "sessionId", message: "does not match directory" }] : v.issues);
  return v.value;
}

export async function requireSession(paths: ResearchPaths, sessionId: string): Promise<ResearchSession> {
  const s = await loadSession(paths, sessionId);
  if (!s) {
    throw new CreatorFlowError(`Research session "${sessionId}" does not exist.`, {
      code: "RESEARCH_SESSION_NOT_FOUND",
      hint: `Import sources first: creatorflow research --session ${sessionId} --input <file-or-dir>`,
      exitCode: ExitCode.NOT_FOUND,
    });
  }
  return s;
}

function corrupt(paths: ResearchPaths, id: string, issues: { path: string; message: string }[]): CreatorFlowError {
  return new CreatorFlowError(`Research session "${id}" is corrupt.`, {
    code: "RESEARCH_SESSION_CORRUPT",
    hint: `Inspect ${paths.sessionFile(id)}; the previous valid copy is ${paths.sessionBackup(id)}.`,
    exitCode: ExitCode.CHECK_FAILED,
    details: issues,
  });
}

/** Stable source id: from the canonical URL when present, otherwise from the user key. */
export function sourceIdFor(input: { url?: string | undefined; key: string }): string {
  if (input.url) return `src-${sha256Hex(canonicalUrl(input.url)).slice(0, 16)}`;
  return `src-k-${input.key}`;
}

export interface ImportCounts {
  added: number;
  changed: number;
  unchanged: number;
  removed: number;
  rejected: number;
  duplicates: number;
}

export interface ImportResult {
  status: "created" | "updated" | "unchanged";
  session: ResearchSession;
  counts: ImportCounts;
  issues: ImportIssue[];
  /** Fact claims in the session without strong support (as imported). */
  unresolvedClaims: { claimId: string; support: string; text: string }[];
}

type Tracked<T> = { record: T; hash: string };

function stamp<T extends { firstImportedAt: string; lastChangedAt: string }>(
  prev: T | undefined,
  hash: string,
  prevHash: string | undefined,
  now: string,
  counts: ImportCounts,
): { firstImportedAt: string; lastChangedAt: string } {
  if (!prev) {
    counts.added++;
    return { firstImportedAt: now, lastChangedAt: now };
  }
  if (prevHash === hash) {
    counts.unchanged++;
    return { firstImportedAt: prev.firstImportedAt, lastChangedAt: prev.lastChangedAt };
  }
  counts.changed++;
  return { firstImportedAt: prev.firstImportedAt, lastChangedAt: now };
}

function sourceContentHash(p: ParsedSource): string {
  const { key: _k, snapshot: _s, ...fields } = p.input;
  return fingerprint({ ...fields, url: p.input.url ? canonicalUrl(p.input.url) : null, snapshot: p.snapshot?.sha256 ?? null });
}

/** Strips import timestamps so "did anything change?" ignores them. */
function comparable(s: Pick<ResearchSession, "topic" | "sources" | "claims" | "candidates">): string {
  const strip = (r: Record<string, { firstImportedAt: string; lastChangedAt: string }>) =>
    Object.fromEntries(Object.entries(r).map(([k, { firstImportedAt: _a, lastChangedAt: _b, ...rest }]) => [k, rest]));
  return fingerprint({ topic: s.topic ?? null, sources: strip(s.sources), claims: strip(s.claims), candidates: strip(s.candidates) });
}

export interface ImportOptions {
  paths: ResearchPaths;
  sessionId: string;
  bundle: ImportBundle;
  providerId: string;
  topic?: string;
  /** Replace the session's records with exactly this input (records not in it are removed). Default: merge. */
  replace?: boolean;
  requireSnapshotMatch?: boolean;
  now?: () => Date;
}

/**
 * Merges an import into a session under the session lock. Deterministic:
 * the same session + same input always yields the same records, and an import
 * that changes nothing does not write anything.
 */
export async function importIntoSession(o: ImportOptions): Promise<ImportResult> {
  const now = (o.now ?? (() => new Date()))().toISOString();
  const { paths, sessionId, bundle } = o;
  await fs.mkdir(paths.sessionDir(sessionId), { recursive: true });

  return withLock(paths.sessionLock(sessionId), { purpose: `research import ${sessionId}`, waitMs: 10_000, pollMs: 50 }, async () => {
    const existing = await loadSession(paths, sessionId);
    const base = o.replace || !existing ? { sources: {}, claims: {}, candidates: {} } : existing;
    const issues: ImportIssue[] = [...bundle.issues];
    const counts: ImportCounts = { added: 0, changed: 0, unchanged: 0, removed: 0, rejected: new Set(bundle.issues.filter((i) => i.severity === "error").map((i) => i.record)).size, duplicates: 0 };
    const reject = (record: string, path: string, message: string) => {
      issues.push({ severity: "error", record, path, message });
      counts.rejected++;
    };
    const warn = (record: string, path: string, message: string) => issues.push({ severity: "warning", record, path, message });

    // ---------------- sources
    const sources: Record<string, SourceRecord> = { ...(base.sources as Record<string, SourceRecord>) };
    const bundleSources = new Map<string, Tracked<ParsedSource> & { id: string }>();
    const keyToSource = new Map<string, string>();
    if (!o.replace && existing) for (const s of Object.values(existing.sources)) keyToSource.set(s.key, s.sourceId);
    const bundleKeys = new Map<string, string>();
    for (const p of bundle.sources) {
      const id = sourceIdFor(p.input);
      const hash = sourceContentHash(p);
      const label = `${p.importedFrom}:source(${p.input.key})`;
      const prevKey = bundleKeys.get(p.input.key);
      if (prevKey && prevKey !== id) {
        reject(label, "key", `Source key "${p.input.key}" is already used by a different source in this import`);
        continue;
      }
      const dup = bundleSources.get(id);
      if (dup) {
        if (dup.hash === hash) {
          counts.duplicates++;
          bundleKeys.set(p.input.key, id);
          keyToSource.set(p.input.key, id);
        } else {
          reject(label, "url", `Duplicate of source "${dup.record.input.key}" (same canonical URL) with different details; the first occurrence was kept`);
        }
        continue;
      }
      bundleSources.set(id, { record: p, hash, id });
      bundleKeys.set(p.input.key, id);
      keyToSource.set(p.input.key, id);
    }

    // Snapshot texts are stored content-addressed inside the session directory.
    const snapshotText = new Map<string, string>();
    for (const { record: p, id } of bundleSources.values()) {
      if (p.snapshot) snapshotText.set(id, p.snapshot.text);
    }
    const existingSnapshotText = async (s: SourceRecord): Promise<string | undefined> => {
      if (!s.provenance.snapshot) return undefined;
      try {
        return await fs.readFile(resolveWithin(paths.workspaceDir, s.provenance.snapshot.textPath), "utf8");
      } catch {
        return undefined;
      }
    };

    // ---------------- claims
    const claims: Record<string, ClaimRecord> = { ...(base.claims as Record<string, ClaimRecord>) };
    const seenClaims = new Map<string, string>();
    for (const c of bundle.claims) {
      const id = `clm-${c.key}`;
      const label = `claim(${c.key})`;
      const evidence: EvidenceRecord[] = [];
      for (const [i, e] of c.evidence.entries()) {
        const sid = keyToSource.get(e.source);
        if (!sid) {
          reject(label, `evidence[${i}].source`, `Unknown source key "${e.source}"; the evidence entry was dropped`);
          continue;
        }
        let check: EvidenceRecord["check"] = "not-checked";
        if (e.excerpt) {
          const older = sources[sid];
          const text = bundleSources.has(sid) ? snapshotText.get(sid) : older ? await existingSnapshotText(older) : undefined;
          if (text !== undefined) {
            check = containsExcerpt(text, e.excerpt) ? "found-in-snapshot" : "not-found-in-snapshot";
            if (check === "not-found-in-snapshot") warn(label, `evidence[${i}].excerpt`, `Excerpt not found in the snapshot of source "${e.source}"; it will not count as evidence`);
          }
        }
        evidence.push({ sourceId: sid, kind: e.kind, ...(e.excerpt ? { excerpt: e.excerpt } : {}), ...(e.locator ? { locator: e.locator } : {}), check });
      }
      const hash = fingerprint({ text: c.text, kind: c.kind, evidence });
      const seen = seenClaims.get(id);
      if (seen !== undefined) {
        if (seen === hash) counts.duplicates++;
        else reject(label, "key", `Claim key "${c.key}" appears twice with different content; the first occurrence was kept`);
        continue;
      }
      seenClaims.set(id, hash);
      const prev = existing?.claims[id];
      const times = stamp(prev, hash, prev?.contentHash, now, counts);
      claims[id] = { claimId: id, key: c.key, contentHash: hash, text: c.text, kind: c.kind, evidence, support: "unsupported", ...times };
    }

    // ---------------- source records (after claims, so verification reflects excerpt checks)
    for (const { record: p, hash, id } of bundleSources.values()) {
      let snapshot: SourceRecord["provenance"]["snapshot"];
      if (p.snapshot) {
        const textSha = sha256Hex(p.snapshot.text);
        const abs = resolveWithin(paths.snapshotsDir(sessionId), `${textSha}.txt`);
        if (!(await fs.stat(abs).catch(() => undefined))) await writeFileAtomic(abs, p.snapshot.text);
        snapshot = {
          originalName: p.snapshot.originalName,
          mediaType: p.snapshot.mediaType,
          sha256: p.snapshot.sha256,
          bytes: p.snapshot.bytes,
          textPath: toPosix(`research/${sessionId}/snapshots/${textSha}.txt`),
          textSha256: `sha256:${textSha}`,
        };
      }
      const i = p.input;
      const missing: string[] = [];
      if (!i.url && i.sourceType !== "user-notes") missing.push("url");
      if (!i.publisher) missing.push("publisher");
      if (!i.publishedAt && !i.modifiedAt) missing.push("publishedAt");
      if (!i.retrievedAt) missing.push("retrievedAt");
      const warnings = [...new Set(injectionWarnings([i.title, i.notes ?? "", i.confidenceNotes ?? "", p.snapshot?.text ?? ""].join("\n")))];
      if (warnings.length) warn(`source(${i.key})`, "content", `Contains text that looks like instructions to an AI (${warnings.join("; ")}); it is stored as data only`);
      const prev = existing?.sources[id];
      const times = stamp(prev, hash, prev?.contentHash, now, counts);
      sources[id] = {
        sourceId: id,
        key: i.key,
        contentHash: hash,
        ...(i.url ? { url: i.url, canonicalUrl: canonicalUrl(i.url) } : {}),
        title: i.title,
        ...(i.publisher ? { publisher: i.publisher } : {}),
        sourceType: i.sourceType,
        ...(i.otherDescription ? { otherDescription: i.otherDescription } : {}),
        ...(i.publishedAt ? { publishedAt: i.publishedAt } : {}),
        ...(i.modifiedAt ? { modifiedAt: i.modifiedAt } : {}),
        ...(i.retrievedAt ? { retrievedAt: i.retrievedAt } : {}),
        ...(i.notes ? { notes: i.notes } : {}),
        ...(i.confidenceNotes ? { confidenceNotes: i.confidenceNotes } : {}),
        ...(i.attribution ? { attribution: i.attribution } : {}),
        usageRestrictions: i.usageRestrictions,
        provenance: { origin: "user-supplied", provider: o.providerId, importedFrom: p.importedFrom, ...(snapshot ? { snapshot } : {}) },
        verification: { status: "no-snapshot", notes: [] },
        missingMetadata: missing,
        untrustedContentWarnings: warnings,
        ...times,
      };
    }

    // ---------------- candidates
    const candidates: Record<string, CandidateRecord> = { ...(base.candidates as Record<string, CandidateRecord>) };
    const seenCand = new Map<string, string>();
    for (const c of bundle.candidates) {
      const id = `cand-${c.key}`;
      const label = `candidate(${c.key})`;
      const unknown = c.claims.filter((k) => !claims[`clm-${k}`]);
      if (unknown.length) {
        reject(label, "claims", `Unknown claim key(s): ${unknown.join(", ")}; candidate rejected`);
        continue;
      }
      const { key, claims: claimKeys, ...rest } = c;
      const fields = { ...rest, contentId: key, claimIds: claimKeys.map((k) => `clm-${k}`) };
      const hash = fingerprint(fields);
      const seen = seenCand.get(id);
      if (seen !== undefined) {
        if (seen === hash) counts.duplicates++;
        else reject(label, "key", `Candidate key "${key}" appears twice with different content; the first occurrence was kept`);
        continue;
      }
      seenCand.set(id, hash);
      const prev = existing?.candidates[id];
      const times = stamp(prev, hash, prev?.contentHash, now, counts);
      candidates[id] = { candidateId: id, contentHash: hash, ...fields, ...times } as CandidateRecord;
    }

    if (o.replace && existing) {
      for (const kind of ["sources", "claims", "candidates"] as const) {
        const prev = Object.keys(existing[kind]);
        const next = kind === "sources" ? sources : kind === "claims" ? claims : candidates;
        counts.removed += prev.filter((k) => !(k in next)).length;
      }
    }

    // ---------------- derived: claim support and source verification (deterministic from records)
    for (const c of Object.values(claims)) c.support = assessClaim(c, sources, { requireSnapshotMatch: o.requireSnapshotMatch ?? false }).support;
    for (const s of Object.values(sources)) {
      const ev = Object.values(claims).flatMap((c) => c.evidence.filter((e) => e.sourceId === s.sourceId && e.excerpt));
      const found = ev.filter((e) => e.check === "found-in-snapshot").length;
      const notFound = ev.filter((e) => e.check === "not-found-in-snapshot").length;
      const notes: string[] = [];
      let status: SourceRecord["verification"]["status"];
      if (!s.provenance.snapshot) {
        status = "no-snapshot";
        notes.push("No local snapshot; excerpts could not be checked. This record is user-asserted.");
      } else if (notFound) {
        status = "excerpt-mismatch";
        notes.push(`${notFound} excerpt(s) not found in the snapshot`);
      } else if (found) {
        status = "excerpts-found-in-snapshot";
        notes.push(`${found} excerpt(s) found verbatim in the snapshot. This shows the snapshot contains the text; it does not prove the snapshot matches the live page.`);
      } else {
        status = "snapshot-without-excerpts";
        notes.push("Snapshot stored, but no excerpt references it");
      }
      s.verification = { status, notes };
    }

    const topic = o.topic ?? bundle.sessionTopic ?? existing?.topic;
    const nextBody = { ...(topic ? { topic } : {}), sources, claims, candidates };
    const unresolvedClaims = Object.values(claims)
      .filter((c) => c.kind === "fact" && c.support !== "supported" && c.support !== "supported-unchecked")
      .map((c) => ({ claimId: c.claimId, support: c.support, text: c.text }))
      .sort((a, b) => (a.claimId < b.claimId ? -1 : 1));

    if (existing && comparable(existing) === comparable(nextBody)) {
      return { status: "unchanged", session: existing, counts, issues, unresolvedClaims };
    }

    const session: ResearchSession = {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      kind: "research-session",
      sessionId,
      revision: (existing?.revision ?? -1) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...nextBody,
      imports: [
        ...(existing?.imports ?? []),
        { at: now, provider: o.providerId, inputs: bundle.files, inputHash: bundle.inputHash, mode: o.replace ? "replace" : "merge", counts },
      ],
      lastImportIssues: issues.map((i) => ({ ...i, message: i.message.slice(0, 2000) })),
    };
    const v = validateArtifact(ResearchSessionSchema, session);
    if (!v.ok) {
      throw new CreatorFlowError("Refusing to write an invalid research session.", { code: "RESEARCH_SESSION_INVALID", exitCode: ExitCode.CHECK_FAILED, details: v.issues });
    }
    if (existing) await writeFileAtomic(paths.sessionBackup(sessionId), await fs.readFile(paths.sessionFile(sessionId), "utf8"));
    await writeFileAtomic(paths.sessionFile(sessionId), stringifyJson(v.value));
    return { status: existing ? "updated" : "created", session: v.value, counts, issues, unresolvedClaims };
  });
}

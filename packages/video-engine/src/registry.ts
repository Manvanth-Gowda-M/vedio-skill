import { promises as fs } from "node:fs";
import path from "node:path";
import { CreatorFlowError, ExitCode, pathExists, resolveWithin, slugify, stringifyJson, withLock, writeFileAtomic } from "@creatorflow/core";
import {
  AssetRegistrySchema,
  AssetRegistryV2Schema,
  AssetType,
  validateArtifact,
  type AssetEntry,
  type AssetMedia,
  type AssetProvenance,
  type AssetRegistry,
  type AssetRegistryV1,
  type AssetRegistryV2,
  type ClipSettings,
} from "@creatorflow/schemas";

export const REGISTRY_REL = "assets/registry.json";
export const REGISTRY_BACKUP_REL = "assets/registry.prev.json";
export const REGISTRY_V1_BACKUP_REL = "assets/registry.v1.json";
const LOCK_REL = "assets/.registry.lock";

export type RegistryLoad =
  | { status: "missing" }
  | { status: "ok"; registry: AssetRegistry; raw: string }
  | { status: "corrupt"; problem: string; backup: "valid" | "invalid" | "missing" };

function parse(raw: string): { ok: true; registry: AssetRegistry } | { ok: false; problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { ok: false, problem: `${REGISTRY_REL} is not valid JSON: ${(e as Error).message}` };
  }
  const v = validateArtifact(AssetRegistrySchema, data);
  return v.ok ? { ok: true, registry: v.value } : { ok: false, problem: `${REGISTRY_REL} is invalid: ${v.issues[0]?.path}: ${v.issues[0]?.message}` };
}

export async function readRegistry(workspaceDir: string): Promise<RegistryLoad> {
  const raw = await fs.readFile(resolveWithin(workspaceDir, REGISTRY_REL), "utf8").catch(() => undefined);
  if (raw === undefined) return { status: "missing" };
  const p = parse(raw);
  if (p.ok) return { status: "ok", registry: p.registry, raw };
  const b = await fs.readFile(resolveWithin(workspaceDir, REGISTRY_BACKUP_REL), "utf8").catch(() => undefined);
  return { status: "corrupt", problem: p.problem, backup: b === undefined ? "missing" : parse(b).ok ? "valid" : "invalid" };
}

/** A filled scene slot, in the same shape for Stage F (v1) and Stage G (v2) registries. */
export interface SlotBinding {
  jobId: string;
  assetId: string;
  registryId?: string;
  type?: AssetType;
  path: string;
  sha256: string;
  provenance: AssetProvenance;
  clip?: ClipSettings;
  legacy: boolean;
}

export function legacyProvenance(e: AssetRegistryV1["assets"][number]): AssetProvenance {
  return {
    origin: "unknown",
    license: e.license,
    ...(e.attribution ? { attribution: e.attribution } : {}),
    attributionRequired: Boolean(e.attribution),
    verification: "unverified",
    ...(e.source && /^https?:\/\/\S+$/i.test(e.source) ? { sourceUrl: e.source } : {}),
    notes: `Hand-registered in a Stage F registry${e.source && !/^https?:\/\//i.test(e.source) ? `; source: ${e.source}` : ""}.`.slice(0, 1000),
  };
}

export function bindingsOf(reg: AssetRegistry): SlotBinding[] {
  if (reg.schemaVersion === 1) return reg.assets.map((e) => ({ jobId: e.jobId, assetId: e.assetId, path: e.path, sha256: e.sha256, provenance: legacyProvenance(e), legacy: true }));
  return reg.assets.flatMap((e) => e.uses.map((u) => ({ jobId: u.jobId, assetId: u.assetId, registryId: e.id, type: e.type, path: e.path, sha256: e.sha256, provenance: e.provenance, ...(u.clip ? { clip: u.clip } : {}), legacy: false })));
}

/** Loads the registry for the assets step: bindings, or an explanation of why the registry cannot be used. */
export async function loadRegistry(workspaceDir: string): Promise<{ bindings: SlotBinding[]; problem?: string }> {
  const l = await readRegistry(workspaceDir);
  if (l.status === "missing") return { bindings: [] };
  if (l.status === "corrupt") return { bindings: [], problem: `${l.problem}${l.backup === "valid" ? " (a valid backup exists: run `creatorflow assets recover`)" : ""}` };
  return { bindings: bindingsOf(l.registry) };
}

export const emptyRegistry = (): AssetRegistryV2 => ({ schemaVersion: 2, kind: "asset-registry", revision: 0, assets: [] });

/** Stable id from a file name, unique among `taken`. */
export function deriveAssetId(file: string, taken: ReadonlySet<string>): string {
  const base = `ast-${slugify(path.basename(file, path.extname(file)), 50) || "file"}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export type Measure = (rel: string) => Promise<{ bytes: number; media: AssetMedia; type?: AssetType } | undefined>;

/**
 * Converts a Stage F registry to version 2. Entries that point at the same
 * file with the same hash become one asset with several uses. Files that
 * cannot be measured keep no media data (validate reports them).
 */
export async function migrateV1(reg: AssetRegistryV1, measure: Measure, now: string): Promise<AssetRegistryV2> {
  const out = emptyRegistry();
  const taken = new Set<string>();
  for (const e of reg.assets) {
    const key = e.path.replace(/\\/g, "/").toLowerCase();
    const same = out.assets.find((a) => a.path.replace(/\\/g, "/").toLowerCase() === key);
    if (same) {
      if (same.sha256 !== e.sha256) throw new CreatorFlowError(`Cannot migrate ${REGISTRY_REL}: ${e.path} is listed twice with different hashes.`, { code: "REGISTRY_INVALID", hint: "Fix or remove one of the two entries by hand, then retry.", exitCode: ExitCode.CHECK_FAILED });
      same.uses.push({ jobId: e.jobId, assetId: e.assetId });
      continue;
    }
    const m = await measure(e.path);
    const fromSlot = /^ast-scn-\d{2}-([a-z-]+)$/.exec(e.assetId)?.[1];
    const slotType = AssetType.safeParse(fromSlot);
    const type: AssetType = slotType.success && !(slotType.data === "screen-recording" || slotType.data === "b-roll") ? slotType.data : (m?.type ?? (m?.media.kind === "text" ? "code-snippet" : "other"));
    const id = deriveAssetId(e.path, taken);
    taken.add(id);
    out.assets.push({ id, type, path: e.path, ...(m ? { bytes: m.bytes, media: m.media } : {}), sha256: e.sha256, provenance: legacyProvenance(e), registeredAt: now, updatedAt: now, uses: [{ jobId: e.jobId, assetId: e.assetId }] });
  }
  return out;
}

export interface MutateOptions {
  purpose: string;
  now: () => Date;
  /** Measures files when a Stage F registry has to be migrated. */
  measure: Measure;
  lockWaitMs?: number;
}

/**
 * Read-modify-write of the registry under an exclusive lock:
 * migrates a Stage F file (keeping registry.v1.json), validates the result,
 * refuses to write if the file changed underneath (compare-and-swap on the
 * raw bytes), keeps the previous version as registry.prev.json and replaces
 * the file atomically. A corrupt registry is never overwritten.
 */
export async function mutateRegistry<T>(workspaceDir: string, o: MutateOptions, fn: (draft: AssetRegistryV2) => Promise<T> | T): Promise<{ result: T; registry: AssetRegistryV2; migrated: boolean }> {
  const file = resolveWithin(workspaceDir, REGISTRY_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withLock(resolveWithin(workspaceDir, LOCK_REL), { purpose: o.purpose, waitMs: o.lockWaitMs ?? 15_000, pollMs: 50 }, async () => {
    const l = await readRegistry(workspaceDir);
    if (l.status === "corrupt") {
      throw new CreatorFlowError(`The asset registry is corrupt: ${l.problem}`, {
        code: "REGISTRY_CORRUPT",
        hint: l.backup === "valid" ? "Run `creatorflow assets recover` to restore the last valid version (the corrupt file is kept)." : "No valid backup exists. Fix the JSON by hand, or move the file aside and register the assets again.",
        exitCode: ExitCode.CHECK_FAILED,
      });
    }
    const raw = l.status === "ok" ? l.raw : undefined;
    let draft: AssetRegistryV2;
    let migrated = false;
    if (l.status === "ok" && l.registry.schemaVersion === 1) {
      draft = await migrateV1(l.registry, o.measure, o.now().toISOString());
      migrated = true;
    } else draft = l.status === "ok" ? (structuredClone(l.registry) as AssetRegistryV2) : emptyRegistry();
    const prevRevision = draft.revision;
    const result = await fn(draft);
    draft.revision = prevRevision + 1;
    const v = validateArtifact(AssetRegistryV2Schema, draft);
    if (!v.ok) throw new CreatorFlowError(`Refusing to write an invalid asset registry: ${v.issues[0]?.path}: ${v.issues[0]?.message}`, { code: "REGISTRY_INVALID", exitCode: ExitCode.CHECK_FAILED, details: v.issues });
    const now = await fs.readFile(file, "utf8").catch(() => undefined);
    if (now !== raw) throw new CreatorFlowError(`${REGISTRY_REL} was changed by something else while this command ran.`, { code: "REGISTRY_CONFLICT", hint: "Re-run the command. Edit the registry only with `creatorflow assets` commands.", exitCode: ExitCode.CONFLICT });
    if (raw !== undefined) {
      if (migrated && !(await pathExists(resolveWithin(workspaceDir, REGISTRY_V1_BACKUP_REL)))) await writeFileAtomic(resolveWithin(workspaceDir, REGISTRY_V1_BACKUP_REL), raw);
      await writeFileAtomic(resolveWithin(workspaceDir, REGISTRY_BACKUP_REL), raw);
    }
    await writeFileAtomic(file, stringifyJson(v.value));
    return { result, registry: v.value, migrated };
  });
}

/** Restores registry.prev.json over a corrupt registry.json (kept as registry.json.corrupt-<time>). */
export async function recoverRegistry(workspaceDir: string, now: () => Date): Promise<{ status: "recovered"; quarantined: string; revision: number | null } | { status: "valid" | "missing" }> {
  return withLock(resolveWithin(workspaceDir, LOCK_REL), { purpose: "assets recover", waitMs: 15_000, pollMs: 50 }, async () => {
    const l = await readRegistry(workspaceDir);
    if (l.status === "missing") return { status: "missing" as const };
    if (l.status === "ok") return { status: "valid" as const };
    if (l.backup !== "valid") throw new CreatorFlowError(`The asset registry is corrupt and ${l.backup === "missing" ? "has no backup" : "its backup is also invalid"}.`, { code: "REGISTRY_CORRUPT", hint: "Fix registry.json by hand or move it aside and register the assets again.", exitCode: ExitCode.CHECK_FAILED });
    const file = resolveWithin(workspaceDir, REGISTRY_REL);
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    let q = `${file}.corrupt-${stamp}`;
    for (let i = 1; await pathExists(q); i++) q = `${file}.corrupt-${stamp}-${i}`;
    await fs.rename(file, q);
    const backup = await fs.readFile(resolveWithin(workspaceDir, REGISTRY_BACKUP_REL), "utf8");
    await writeFileAtomic(file, backup);
    const p = parse(backup);
    return { status: "recovered" as const, quarantined: path.basename(q), revision: p.ok && p.registry.schemaVersion === 2 ? p.registry.revision : null };
  });
}

export function findEntry(reg: AssetRegistryV2, id: string): AssetEntry | undefined {
  return reg.assets.find((a) => a.id === id);
}

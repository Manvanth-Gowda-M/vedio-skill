import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId, CreatorFlowError, ExitCode, isWithin, resolveWithin, toPosix, type ExitCodeValue } from "@creatorflow/core";
import { JobStore, workflowPaths } from "@creatorflow/orchestrator";
import {
  AssetOrigin,
  AssetProvenanceSchema,
  AssetType,
  ClipSettingsSchema,
  SceneManifestSchema,
  validateArtifact,
  type AssetEntry,
  type AssetProvenance,
  type AssetRegistryV2,
  type ClipSettings,
  type CreatorFlowConfig,
} from "@creatorflow/schemas";
import { SCRIPT_OUTPUTS } from "@creatorflow/scriptwriter";
import {
  bindingsOf,
  checkAssetFile,
  deriveAssetId,
  findEntry,
  mediaToolsLoader,
  mutateRegistry,
  readRegistry,
  recoverRegistry,
  REGISTRY_REL,
  resolveClip,
  slotAccepts,
  SUPPORTED_EXTENSIONS,
  VIDEO_KINDS,
  type CheckOk,
  type Measure,
} from "@creatorflow/video-engine";
import type { Output } from "../output.ts";
import { requireProject } from "../project.ts";

export interface ProvenanceFlags {
  origin?: string;
  creator?: string;
  sourceUrl?: string;
  license?: string;
  attribution?: string;
  attributionRequired?: boolean;
  obtained?: string;
  attest?: boolean;
  notes?: string;
}
export interface ClipFlags {
  start?: string;
  end?: string;
  fit?: string;
}
export interface RegisterFlags extends ProvenanceFlags, ClipFlags {
  file: string;
  type: string;
  id?: string;
  job?: string;
  slot?: string;
}
export interface UpdateFlags extends ProvenanceFlags, ClipFlags {
  id: string;
  use?: string;
  unuse?: string;
  refresh?: boolean;
}

const usage = (message: string, hint?: string) => new CreatorFlowError(message, { code: "USAGE", exitCode: ExitCode.USAGE, ...(hint ? { hint } : {}) });

async function ctxOf(dir: string) {
  const project = await requireProject(dir);
  const ws = resolveWithin(project.paths.dir, project.config.workspaceDir);
  const root = resolveWithin(ws, "assets");
  return { project, ws, root, config: project.config, paths: workflowPaths(ws) };
}

/** Resolves --file to a path inside workspace/assets without following symlinks or junctions out of it. */
async function insideAssets(root: string, file: string): Promise<string> {
  const abs = path.resolve(file);
  if (!isWithin(root, abs)) {
    throw new CreatorFlowError(`${file} is outside the permitted asset directory.`, { code: "ASSET_OUTSIDE_ROOT", hint: `Copy the file into ${root} first; CreatorFlow only registers files there and never copies or downloads them.`, exitCode: ExitCode.IO });
  }
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) throw new CreatorFlowError(`${file} does not exist.`, { code: "ASSET_MISSING", exitCode: ExitCode.NOT_FOUND });
  if (st.isSymbolicLink()) throw new CreatorFlowError(`${file} is a symbolic link; only regular files are registered.`, { code: "ASSET_INVALID", exitCode: ExitCode.IO });
  if (!st.isFile()) throw new CreatorFlowError(`${file} is not a regular file.`, { code: "ASSET_INVALID", exitCode: ExitCode.IO });
  await fs.mkdir(root, { recursive: true });
  const [real, realRoot] = await Promise.all([fs.realpath(abs), fs.realpath(root)]);
  if (!isWithin(realRoot, real)) throw new CreatorFlowError(`${file} resolves outside ${root} (through a link or junction).`, { code: "ASSET_OUTSIDE_ROOT", exitCode: ExitCode.IO });
  return toPosix(path.relative(root, abs));
}

function parseDate(s: string | undefined, flag: string): string | undefined {
  if (s === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw usage(`${flag} must be a date like 2026-10-23`);
  return s;
}

/** Applies provenance flags; every value is recorded as a claim. */
function provenance(base: AssetProvenance | undefined, f: ProvenanceFlags): AssetProvenance {
  if (f.origin !== undefined && !AssetOrigin.safeParse(f.origin).success) throw usage(`--origin must be one of ${AssetOrigin.options.join(", ")}`);
  const p: AssetProvenance = {
    ...(base ?? { origin: "unknown", attributionRequired: false, verification: "unverified" }),
    ...(f.origin ? { origin: f.origin as AssetProvenance["origin"] } : {}),
    ...(f.creator !== undefined ? { creator: f.creator } : {}),
    ...(f.sourceUrl !== undefined ? { sourceUrl: f.sourceUrl } : {}),
    ...(f.license !== undefined ? { license: f.license } : {}),
    ...(f.attribution !== undefined ? { attribution: f.attribution } : {}),
    ...(f.attributionRequired !== undefined ? { attributionRequired: f.attributionRequired } : {}),
    ...(f.obtained !== undefined ? { obtainedAt: parseDate(f.obtained, "--obtained")! } : {}),
    ...(f.notes !== undefined ? { notes: f.notes } : {}),
  };
  if (f.attest) p.verification = "user-attested";
  if ((p.origin === "open-license-claim" || p.origin === "public-domain-claim") && !p.license) throw usage(`--origin ${p.origin} needs --license (the licence you are relying on)`);
  if (p.origin === "open-license-claim" && f.attributionRequired === undefined && base === undefined) p.attributionRequired = true;
  const v = AssetProvenanceSchema.safeParse(p);
  if (!v.success) throw usage(`invalid provenance: ${v.error.issues[0]?.path.join(".")}: ${v.error.issues[0]?.message}`);
  return v.data;
}

function clipOf(f: ClipFlags, base?: ClipSettings): ClipSettings | undefined {
  if (f.start === undefined && f.end === undefined && f.fit === undefined) return base;
  const num = (s: string | undefined, flag: string) => {
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) throw usage(`${flag} must be a number of seconds`);
    return n;
  };
  const c = { startSec: num(f.start, "--start") ?? base?.startSec ?? 0, ...(f.end !== undefined ? { endSec: num(f.end, "--end")! } : base?.endSec !== undefined ? { endSec: base.endSec } : {}), fit: (f.fit ?? base?.fit ?? "contain") as ClipSettings["fit"] };
  const v = ClipSettingsSchema.safeParse(c);
  if (!v.success) throw usage(`invalid clip: ${v.error.issues[0]?.path.join(".") || "clip"}: ${v.error.issues[0]?.message}`);
  return v.data;
}

/** Scene-manifest slot of a job, when the job has a verified script. */
async function manifestSlot(paths: ReturnType<typeof workflowPaths>, jobId: string, assetId: string): Promise<{ found: boolean; kind?: string; required?: boolean; note?: string }> {
  const l = await new JobStore(paths).load(jobId);
  if (l.status !== "ok") return { found: false, note: `job ${jobId} ${l.status === "missing" ? "does not exist yet" : "has a corrupt record"}; the slot could not be checked` };
  const rec = l.job.steps["script"]?.outputs.find((o) => o.path === SCRIPT_OUTPUTS.manifest);
  if (!rec) return { found: false, note: `job ${jobId} has no verified scene manifest yet; the slot could not be checked` };
  const raw = await fs.readFile(resolveWithin(paths.jobDir(jobId), SCRIPT_OUTPUTS.manifest), "utf8").catch(() => undefined);
  const v = raw ? validateArtifact(SceneManifestSchema, JSON.parse(raw)) : undefined;
  if (!v?.ok) return { found: false, note: `the scene manifest of ${jobId} is unreadable` };
  const a = v.value.assets.find((x) => x.assetId === assetId);
  if (!a) throw new CreatorFlowError(`Job ${jobId} has no asset slot ${assetId}.`, { code: "SLOT_NOT_FOUND", hint: `Slots: ${v.value.assets.filter((x) => x.kind !== "font").map((x) => `${x.assetId} (${x.kind}${x.required ? ", required" : ""})`).join(", ") || "none"}`, exitCode: ExitCode.NOT_FOUND });
  return { found: true, kind: a.kind, required: a.required };
}

function parseUse(s: string): { jobId: string; assetId: string } {
  const [jobId, assetId, extra] = s.split(":");
  if (!jobId || !assetId || extra !== undefined) throw usage(`--use/--unuse expects <jobId>:<slotAssetId>, got "${s}"`);
  assertSafeId(jobId, "job id");
  if (!/^ast-[a-z0-9-]+$/.test(assetId)) throw usage(`slot id must look like ast-..., got "${assetId}"`);
  return { jobId, assetId };
}

async function measureWith(root: string, config: CreatorFlowConfig, kind: string, rel: string, expected?: string) {
  const tools = mediaToolsLoader(config);
  return checkAssetFile(root, rel, { kind, limits: config.assets, tools: VIDEO_KINDS.has(kind) ? await tools() : null, ...(expected ? { expectedSha256: expected } : {}) });
}

function failCheck(c: Exclude<Awaited<ReturnType<typeof checkAssetFile>>, CheckOk>): never {
  throw new CreatorFlowError(c.message, { code: c.code, exitCode: c.code === "ASSET_MISSING" ? ExitCode.NOT_FOUND : c.code === "MEDIA_TOOLS_UNAVAILABLE" ? ExitCode.CONFIG : ExitCode.CHECK_FAILED });
}

/** Measures Stage F files during migration (images and code text; Stage F had no video). */
function migrationMeasure(root: string, config: CreatorFlowConfig): Measure {
  return async (rel) => {
    for (const kind of ["diagram", "code-snippet"]) {
      const c = await measureWith(root, config, kind, rel);
      if (c.ok) return { bytes: c.size, media: c.media, type: c.media.kind === "text" ? "code-snippet" : "other" };
    }
    return undefined;
  };
}

const now = () => new Date();

function summary(e: AssetEntry): string {
  const m = e.media;
  const dims = m?.video ? `${m.video.width}x${m.video.height} ${m.video.fps}fps ${m.video.durationSec}s ${m.video.codec}${m.video.audio ? ` +audio(${m.video.audio.codec})` : ""}` : m?.width ? `${m.width}x${m.height}` : (m?.mediaType ?? "unmeasured");
  return `${e.id.padEnd(28)} ${e.type.padEnd(16)} ${e.path}  [${dims}] licence ${e.provenance.license ?? "UNKNOWN"} (${e.provenance.origin}, ${e.provenance.verification})  uses ${e.uses.length}`;
}

// ------------------------------------------------------------------ list / inspect

export async function assetsListCommand(o: Output, dir: string, f: { job?: string; type?: string }): Promise<ExitCodeValue> {
  const { ws } = await ctxOf(dir);
  const l = await readRegistry(ws);
  if (l.status === "corrupt") throw new CreatorFlowError(`The asset registry is corrupt: ${l.problem}`, { code: "REGISTRY_CORRUPT", hint: l.backup === "valid" ? "Run `creatorflow assets recover`." : "Fix it by hand.", exitCode: ExitCode.CHECK_FAILED });
  if (l.status === "missing") {
    o.result({ ok: true, schemaVersion: null, assets: [] });
    o.line(`No asset registry yet (workspace/${REGISTRY_REL}). Register files with \`creatorflow assets register\`.`);
    return ExitCode.OK;
  }
  if (l.registry.schemaVersion === 1) {
    const b = bindingsOf(l.registry).filter((x) => !f.job || x.jobId === f.job);
    o.result({ ok: true, schemaVersion: 1, legacy: true, bindings: b });
    o.line(`Stage F registry (schemaVersion 1, ${b.length} entries). It is migrated to version 2 on the first \`assets register/update/remove\`.`);
    for (const x of b) o.line(`  ${x.jobId}:${x.assetId} -> ${x.path} licence ${x.provenance.license ?? "UNKNOWN"}`);
    return ExitCode.OK;
  }
  const list = l.registry.assets.filter((a) => (!f.job || a.uses.some((u) => u.jobId === f.job)) && (!f.type || a.type === f.type));
  o.result({ ok: true, schemaVersion: 2, revision: l.registry.revision, assets: list });
  o.line(`${list.length} asset(s) (registry revision ${l.registry.revision})`);
  for (const a of list) {
    o.line(`  ${summary(a)}`);
    for (const u of a.uses) o.line(`      used by ${u.jobId}:${u.assetId}${u.clip ? ` clip ${u.clip.startSec}-${u.clip.endSec ?? "end"}s ${u.clip.fit}` : ""}`);
  }
  o.line("Licences and origins are recorded as stated; CreatorFlow has not verified them.");
  return ExitCode.OK;
}

export async function assetsInspectCommand(o: Output, dir: string, f: { id: string }): Promise<ExitCodeValue> {
  const { ws, root, config, paths } = await ctxOf(dir);
  const l = await readRegistry(ws);
  if (l.status !== "ok" || l.registry.schemaVersion !== 2) throw new CreatorFlowError(l.status === "ok" ? "This is a Stage F registry without asset ids; use `assets list`." : `No usable registry (${l.status}).`, { code: "ASSET_NOT_FOUND", exitCode: ExitCode.NOT_FOUND });
  const e = findEntry(l.registry, f.id);
  if (!e) throw new CreatorFlowError(`No asset ${f.id}.`, { code: "ASSET_NOT_FOUND", hint: "Run `creatorflow assets list`.", exitCode: ExitCode.NOT_FOUND });
  const c = await measureWith(root, config, e.type, e.path, e.sha256);
  const refs = [];
  for (const u of e.uses) refs.push({ ...u, slot: await manifestSlot(paths, u.jobId, u.assetId).catch((err: CreatorFlowError): Awaited<ReturnType<typeof manifestSlot>> => ({ found: false, note: err.message })) });
  o.result({ ok: c.ok, asset: e, check: c.ok ? { ok: true, sha256: c.sha256, media: c.media } : c, references: refs });
  o.line(summary(e));
  o.line(`  sha256 ${e.sha256}  bytes ${e.bytes ?? "?"}  registered ${e.registeredAt}  updated ${e.updatedAt}`);
  const p = e.provenance;
  o.line(`  provenance (as stated, ${p.verification}): origin ${p.origin}${p.creator ? `, creator ${p.creator}` : ""}${p.sourceUrl ? `, source ${p.sourceUrl} (not fetched)` : ""}, licence ${p.license ?? "unknown"}, attribution ${p.attribution ?? "none"}${p.attributionRequired ? " (required)" : ""}${p.obtainedAt ? `, obtained ${p.obtainedAt}` : ""}`);
  if (p.notes) o.line(`  notes: ${p.notes}`);
  o.line(`  file check now: ${c.ok ? "OK (bytes, hash and content type match)" : `${c.code}: ${c.message}`}`);
  for (const r of refs) o.line(`  use ${r.jobId}:${r.assetId}${r.clip ? ` clip ${r.clip.startSec}-${r.clip.endSec ?? "end"}s ${r.clip.fit}` : ""} — ${r.slot.found ? `${r.slot.kind}${r.slot.required ? ", required" : ""}` : r.slot.note}`);
  return c.ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

// ------------------------------------------------------------------ register / update

export async function assetsRegisterCommand(o: Output, dir: string, f: RegisterFlags): Promise<ExitCodeValue> {
  const { ws, root, config, paths } = await ctxOf(dir);
  const type = AssetType.safeParse(f.type);
  if (!type.success) throw usage(`--type must be one of ${AssetType.options.join(", ")}`);
  if (Boolean(f.job) !== Boolean(f.slot)) throw usage("--job and --slot go together (the scene slot this file fills)");
  if (f.id && !/^ast-[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)) throw usage("--id must look like ast-<lowercase-slug>");
  const rel = await insideAssets(root, f.file);
  const c = await measureWith(root, config, type.data, rel);
  if (!c.ok) failCheck(c);
  const prov = provenance(undefined, f);
  const use = f.job && f.slot ? parseUse(`${f.job}:${f.slot}`) : undefined;
  const slot = use ? await manifestSlot(paths, use.jobId, use.assetId) : undefined;
  if (slot?.found && !slotAccepts(slot.kind!, type.data)) throw new CreatorFlowError(`Slot ${use!.assetId} needs a ${slot.kind} (${VIDEO_KINDS.has(slot.kind!) ? "video" : "image or text"}); ${type.data} does not fit.`, { code: "SLOT_TYPE_MISMATCH", exitCode: ExitCode.CHECK_FAILED });
  const clip = clipOf(f);
  if (clip && c.media.kind !== "video") throw usage("--start/--end/--fit apply to video assets only");
  if (clip && c.media.video) {
    const r = resolveClip(clip, c.media.video.durationSec, c.media.video.fps);
    if (!r.ok) throw new CreatorFlowError(`Invalid clip for ${rel}: ${r.message}.`, { code: "CLIP_INVALID", exitCode: ExitCode.CHECK_FAILED });
  }
  if (c.media.video && c.media.video.durationSec > 0 && !clip) o.line(`Note: no trim given; the whole ${c.media.video.durationSec}s clip is the window (set --start/--end to trim).`);
  const at = now().toISOString();
  const { result: entry, migrated } = await mutateRegistry(ws, { purpose: "assets register", now, measure: migrationMeasure(root, config) }, (reg: AssetRegistryV2) => {
    const dup = reg.assets.find((a) => a.sha256 === c.sha256);
    if (dup) throw new CreatorFlowError(`This content is already registered as ${dup.id} (${dup.path}, same sha256).`, { code: "ASSET_DUPLICATE", hint: use ? `Attach it to the slot instead: creatorflow assets update --id ${dup.id} --use ${use.jobId}:${use.assetId}` : `Use ${dup.id}; one registry entry can fill several scene slots.`, exitCode: ExitCode.CONFLICT, details: { id: dup.id, path: dup.path } });
    const samePath = reg.assets.find((a) => a.path.toLowerCase() === rel.toLowerCase());
    if (samePath) throw new CreatorFlowError(`${rel} is already registered as ${samePath.id} with different content (the file changed).`, { code: "ASSET_PATH_REGISTERED", hint: `If the change is intended: creatorflow assets update --id ${samePath.id} --refresh`, exitCode: ExitCode.CONFLICT });
    const taken = new Set(reg.assets.map((a) => a.id));
    if (f.id && taken.has(f.id)) throw new CreatorFlowError(`Asset id ${f.id} is already taken.`, { code: "ASSET_ID_TAKEN", exitCode: ExitCode.CONFLICT });
    if (use) {
      const holder = reg.assets.find((a) => a.uses.some((u) => u.jobId === use.jobId && u.assetId === use.assetId));
      if (holder) throw new CreatorFlowError(`Slot ${use.jobId}:${use.assetId} is already filled by ${holder.id}.`, { code: "SLOT_TAKEN", hint: `Detach it first: creatorflow assets update --id ${holder.id} --unuse ${use.jobId}:${use.assetId}`, exitCode: ExitCode.CONFLICT });
    }
    const e: AssetEntry = { id: f.id ?? deriveAssetId(rel, taken), type: type.data, path: rel, bytes: c.size, sha256: c.sha256, media: c.media, provenance: prov, registeredAt: at, updatedAt: at, uses: use ? [{ ...use, ...(clip ? { clip } : {}) }] : [] };
    reg.assets.push(e);
    return e;
  });
  o.result({ ok: true, asset: entry, migratedFromV1: migrated, slotCheck: slot ?? null });
  if (migrated) o.line(`Migrated the Stage F registry to version 2 (original kept as workspace/assets/registry.v1.json).`);
  o.line(`Registered ${summary(entry)}`);
  if (slot && !slot.found) o.warn(`warning: ${slot.note}`);
  if (!prov.license) o.warn("warning: licence unknown. Registration records the file; it does not mean you may publish it.");
  else o.line(`Licence "${prov.license}" is recorded as stated (${prov.verification}); CreatorFlow cannot verify it.`);
  return ExitCode.OK;
}

export async function assetsUpdateCommand(o: Output, dir: string, f: UpdateFlags): Promise<ExitCodeValue> {
  const { ws, root, config, paths } = await ctxOf(dir);
  const use = f.use ? parseUse(f.use) : undefined;
  const unuse = f.unuse ? parseUse(f.unuse) : undefined;
  const clipFlags = f.start !== undefined || f.end !== undefined || f.fit !== undefined;
  if (clipFlags && !use) throw usage("--start/--end/--fit need --use <jobId>:<slot> (clip settings belong to one scene use)");
  const l = await readRegistry(ws);
  const pre = l.status === "ok" && l.registry.schemaVersion === 2 ? findEntry(l.registry, f.id) : undefined;
  let refreshed: CheckOk | undefined;
  if (f.refresh && pre) {
    const c = await measureWith(root, config, pre.type, pre.path);
    if (!c.ok) failCheck(c);
    refreshed = c;
  }
  const slot = use ? await manifestSlot(paths, use.jobId, use.assetId) : undefined;
  const changes: string[] = [];
  const { result: entry, migrated } = await mutateRegistry(ws, { purpose: "assets update", now, measure: migrationMeasure(root, config) }, async (reg) => {
    const e = findEntry(reg, f.id);
    if (!e) throw new CreatorFlowError(`No asset ${f.id}.`, { code: "ASSET_NOT_FOUND", hint: "Run `creatorflow assets list`.", exitCode: ExitCode.NOT_FOUND });
    if (f.refresh) {
      const c = refreshed ?? (await measureWith(root, config, e.type, e.path));
      if (!c.ok) failCheck(c);
      const dup = reg.assets.find((a) => a.id !== e.id && a.sha256 === c.sha256);
      if (dup) throw new CreatorFlowError(`The new content of ${e.path} is identical to ${dup.id}.`, { code: "ASSET_DUPLICATE", exitCode: ExitCode.CONFLICT });
      if (c.sha256 !== e.sha256) changes.push(`content ${e.sha256.slice(0, 19)}… -> ${c.sha256.slice(0, 19)}…`);
      e.sha256 = c.sha256;
      e.bytes = c.size;
      e.media = c.media;
    }
    const before = JSON.stringify(e.provenance);
    e.provenance = provenance(e.provenance, f);
    if (JSON.stringify(e.provenance) !== before) changes.push("provenance");
    if (unuse) {
      const n = e.uses.length;
      e.uses = e.uses.filter((u) => !(u.jobId === unuse.jobId && u.assetId === unuse.assetId));
      if (e.uses.length === n) throw new CreatorFlowError(`${f.id} is not used by ${unuse.jobId}:${unuse.assetId}.`, { code: "USE_NOT_FOUND", exitCode: ExitCode.NOT_FOUND });
      changes.push(`detached from ${unuse.jobId}:${unuse.assetId}`);
    }
    if (use) {
      if (slot?.found && !slotAccepts(slot.kind!, e.type)) throw new CreatorFlowError(`Slot ${use.assetId} needs a ${slot.kind}; ${e.type} does not fit.`, { code: "SLOT_TYPE_MISMATCH", exitCode: ExitCode.CHECK_FAILED });
      const holder = reg.assets.find((a) => a.id !== e.id && a.uses.some((u) => u.jobId === use.jobId && u.assetId === use.assetId));
      if (holder) throw new CreatorFlowError(`Slot ${use.jobId}:${use.assetId} is already filled by ${holder.id}.`, { code: "SLOT_TAKEN", hint: `Detach it first: creatorflow assets update --id ${holder.id} --unuse ${use.jobId}:${use.assetId}`, exitCode: ExitCode.CONFLICT });
      const existing = e.uses.find((u) => u.jobId === use.jobId && u.assetId === use.assetId);
      const clip = clipOf(f, existing?.clip);
      if (clip && e.media?.kind !== "video") throw usage("--start/--end/--fit apply to video assets only");
      if (clip && e.media?.video) {
        const r = resolveClip(clip, e.media.video.durationSec, e.media.video.fps);
        if (!r.ok) throw new CreatorFlowError(`Invalid clip: ${r.message}.`, { code: "CLIP_INVALID", exitCode: ExitCode.CHECK_FAILED });
      }
      if (existing) {
        if (clip) existing.clip = clip;
        changes.push(`clip for ${use.jobId}:${use.assetId}`);
      } else {
        e.uses.push({ ...use, ...(clip ? { clip } : {}) });
        changes.push(`attached to ${use.jobId}:${use.assetId}`);
      }
    }
    if (!changes.length) throw usage("nothing to change", "Pass provenance flags, --use/--unuse, clip flags or --refresh.");
    e.updatedAt = now().toISOString();
    return e;
  });
  o.result({ ok: true, asset: entry, changes, migratedFromV1: migrated, slotCheck: slot ?? null });
  o.line(`Updated ${entry.id}: ${changes.join("; ")}`);
  if (slot && !slot.found) o.warn(`warning: ${slot.note}`);
  o.line("Jobs that use this asset re-check it on the next `resume`; other jobs are not affected.");
  return ExitCode.OK;
}

// ------------------------------------------------------------------ validate / remove / recover

export async function assetsValidateCommand(o: Output, dir: string, f: { id?: string }): Promise<ExitCodeValue> {
  const { ws, root, config } = await ctxOf(dir);
  const l = await readRegistry(ws);
  if (l.status === "missing") {
    o.result({ ok: true, results: [] });
    o.line("No asset registry yet; nothing to validate.");
    return ExitCode.OK;
  }
  if (l.status === "corrupt") {
    o.result({ ok: false, problem: l.problem, backup: l.backup });
    o.line(`INVALID registry: ${l.problem}`);
    if (l.backup === "valid") o.line("  A valid backup exists: run `creatorflow assets recover`.");
    return ExitCode.CHECK_FAILED;
  }
  const items =
    l.registry.schemaVersion === 2
      ? l.registry.assets.filter((a) => !f.id || a.id === f.id).map((a) => ({ label: a.id, kind: a.type, path: a.path, sha256: a.sha256, entry: a as AssetEntry | undefined }))
      : bindingsOf(l.registry).map((b) => ({ label: `${b.jobId}:${b.assetId}`, kind: /ast-scn-\d{2}-([a-z-]+)$/.exec(b.assetId)?.[1] ?? "diagram", path: b.path, sha256: b.sha256, entry: undefined as AssetEntry | undefined }));
  if (f.id && !items.length) throw new CreatorFlowError(`No asset ${f.id}.`, { code: "ASSET_NOT_FOUND", exitCode: ExitCode.NOT_FOUND });
  const results = [];
  for (const it of items) {
    const c = await measureWith(root, config, it.kind, it.path, it.sha256);
    const problems: string[] = [];
    if (!c.ok) problems.push(`${c.code}: ${c.message}`);
    else if (it.entry?.media && it.entry.media.kind !== c.media.kind) problems.push(`media kind changed from ${it.entry.media.kind} to ${c.media.kind}`);
    if (it.entry?.media?.video && c.ok && c.media.video) {
      for (const u of it.entry.uses) {
        const r = resolveClip(u.clip, c.media.video.durationSec, c.media.video.fps);
        if (!r.ok) problems.push(`clip for ${u.jobId}:${u.assetId}: ${r.message}`);
      }
    }
    const warnings: string[] = [];
    if (it.entry && !it.entry.provenance.license) warnings.push("licence unknown");
    if (it.entry?.provenance.attributionRequired && !it.entry.provenance.attribution) problems.push("attribution required but none recorded");
    results.push({ id: it.label, path: it.path, ok: problems.length === 0, problems, warnings });
  }
  const ok = results.every((r) => r.ok);
  o.result({ ok, schemaVersion: l.registry.schemaVersion, results });
  for (const r of results) {
    o.line(`${r.ok ? "VALID  " : "INVALID"} ${r.id} ${r.path}`);
    for (const p of r.problems) o.line(`  - ${p}`);
    for (const w of r.warnings) o.line(`  ~ ${w}`);
  }
  o.line(`${results.filter((r) => r.ok).length}/${results.length} asset(s) valid. Licences are recorded as stated, not verified.`);
  return ok ? ExitCode.OK : ExitCode.CHECK_FAILED;
}

/** Jobs whose latest verified asset resolution used this registry entry. */
async function verifiedUsers(paths: ReturnType<typeof workflowPaths>, e: AssetEntry): Promise<string[]> {
  const out: string[] = [];
  const store = new JobStore(paths);
  for (const id of await store.list()) {
    const l = await store.load(id);
    if (l.status !== "ok" || l.job.steps["assets"]?.status !== "succeeded") continue;
    const raw = await fs.readFile(resolveWithin(paths.jobDir(id), "assets/resolution.json"), "utf8").catch(() => "");
    if (raw.includes(`"registryId": "${e.id}"`) || raw.includes(`"sha256": "${e.sha256}"`)) out.push(id);
  }
  return out;
}

export async function assetsRemoveCommand(o: Output, dir: string, f: { id: string }): Promise<ExitCodeValue> {
  const { ws, root, config, paths } = await ctxOf(dir);
  const l = await readRegistry(ws);
  const pre = l.status === "ok" && l.registry.schemaVersion === 2 ? findEntry(l.registry, f.id) : undefined;
  const users = pre ? await verifiedUsers(paths, pre) : [];
  const { result: removed } = await mutateRegistry(ws, { purpose: "assets remove", now, measure: migrationMeasure(root, config) }, async (reg) => {
    const e = findEntry(reg, f.id);
    if (!e) throw new CreatorFlowError(`No asset ${f.id}.`, { code: "ASSET_NOT_FOUND", hint: "Run `creatorflow assets list`.", exitCode: ExitCode.NOT_FOUND });
    if (e.uses.length) {
      const slots = [];
      for (const u of e.uses) {
        const s = await manifestSlot(paths, u.jobId, u.assetId).catch(() => ({ found: false, required: undefined }));
        slots.push(`${u.jobId}:${u.assetId}${s.found ? (s.required ? " (required)" : " (optional)") : ""}`);
      }
      throw new CreatorFlowError(`${e.id} is still used by ${slots.join(", ")}; refusing to remove it.`, { code: "ASSET_IN_USE", hint: `Detach each use first (creatorflow assets update --id ${e.id} --unuse <jobId>:<slot>), then remove. Required slots will block their job until another file is registered.`, exitCode: ExitCode.CONFLICT, details: e.uses });
    }
    reg.assets = reg.assets.filter((a) => a.id !== e.id);
    return e;
  });
  o.result({ ok: true, removed, fileKept: removed.path, previouslyRenderedBy: users });
  o.line(`Removed ${removed.id} from the registry. The file workspace/assets/${removed.path} was NOT deleted.`);
  if (users.length) o.line(`  Jobs whose last verified assets step used it: ${users.join(", ")} (they re-check on the next resume).`);
  return ExitCode.OK;
}

export async function assetsRecoverCommand(o: Output, dir: string): Promise<ExitCodeValue> {
  const { ws } = await ctxOf(dir);
  const r = await recoverRegistry(ws, now);
  o.result({ ok: r.status !== "missing", ...r });
  if (r.status === "missing") {
    o.line("There is no asset registry to recover.");
    return ExitCode.NOT_FOUND;
  }
  if (r.status === "valid") {
    o.line("The asset registry is valid; nothing to recover.");
    return ExitCode.OK;
  }
  if (r.status !== "recovered") return ExitCode.INTERNAL;
  o.line(`Restored workspace/${REGISTRY_REL} from registry.prev.json${r.revision !== null ? ` (revision ${r.revision})` : ""}; the corrupt file is kept as ${r.quarantined}.`);
  return ExitCode.OK;
}

export const ASSET_FORMATS_HELP = `images ${SUPPORTED_EXTENSIONS.image.join(" ")}; code ${SUPPORTED_EXTENSIONS.text.join(" ")}; video ${SUPPORTED_EXTENSIONS.video.join(" ")}`;

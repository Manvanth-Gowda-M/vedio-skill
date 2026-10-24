import { promises as fs } from "node:fs";
import path from "node:path";
import { isWithin, readJsonFile, resolveWithin, sha256File, sha256Hex, stringifyJson, toPosix, writeFileAtomic } from "@creatorflow/core";
import { readVerifiedOutput, StepError, type FingerprintContext, type StepContext, type StepResult } from "@creatorflow/orchestrator";
import { FIXED_LABELS } from "@creatorflow/remotion-studio";
import { AssetResolutionSchema, CaptionsFileSchema, SceneManifestSchema, validateArtifact, type AssetMedia, type AssetResolution, type AssetType, type SceneManifest } from "@creatorflow/schemas";
import { SCRIPT_OUTPUTS } from "@creatorflow/scriptwriter";
import { findFfmpeg, findFfprobe } from "./environment.ts";
import { fontsourceDir, missingGlyphs, requiredCodePoints, resolveFont, unicodeRange, type FontSlot } from "./fonts.ts";
import { imageSize, probeVideo, VIDEO_EXTENSIONS, type AssetLimits, type MediaTools } from "./media.ts";
import { loadRegistry, REGISTRY_REL, type SlotBinding } from "./registry.ts";
import { projectDirOf } from "./verified.ts";

export { loadRegistry, REGISTRY_REL } from "./registry.ts";
export const ASSET_OUTPUT = "assets/resolution.json";
/** Defaults used when no config is at hand (unit tests, Stage F callers). */
export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  maxImageBytes: 25 * 1024 * 1024,
  maxVideoBytes: 512 * 1024 * 1024,
  maxVideoDurationSec: 600,
  maxVideoWidth: 3840,
  maxVideoHeight: 2160,
  maxVideoFps: 120,
  videoCodecs: ["h264", "vp8", "vp9"],
  decodeCheck: "full",
  probeTimeoutMs: 180_000,
};
const MAX_TEXT_BYTES = 1024 * 1024;

const IMAGE_TYPES: Record<string, { mediaType: string; magic: (b: Buffer) => boolean }> = {
  ".png": { mediaType: "image/png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  ".jpg": { mediaType: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".jpeg": { mediaType: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".webp": { mediaType: "image/webp", magic: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
};
const TEXT_TYPES: Record<string, string> = { ".txt": "text/plain", ".md": "text/plain" };
export const VIDEO_KINDS: ReadonlySet<string> = new Set(["screen-recording", "b-roll"]);
export const SUPPORTED_EXTENSIONS = { image: Object.keys(IMAGE_TYPES), text: Object.keys(TEXT_TYPES), video: Object.keys(VIDEO_EXTENSIONS) };

export interface AssetIssue {
  assetId: string;
  code: "ASSET_MISSING" | "ASSET_INVALID" | "UNSUPPORTED_ASSET_TYPE" | "ASSET_LIMIT_EXCEEDED" | "MEDIA_TOOLS_UNAVAILABLE" | "ATTRIBUTION_MISSING";
  message: string;
}

export interface CheckOptions {
  /** Scene-slot kind or registered asset type; decides which media are acceptable. */
  kind: string;
  expectedSha256?: string;
  limits?: AssetLimits;
  /** Needed for video; `null`/absent means no ffprobe/ffmpeg is available. */
  tools?: MediaTools | null;
  signal?: AbortSignal;
}

export type CheckOk = { ok: true; abs: string; sha256: string; size: number; mediaType: string; media: AssetMedia; text?: string };
export type CheckFail = { ok: false; code: AssetIssue["code"]; message: string };

/**
 * Verifies a file inside `rootDir` from its bytes: regular file (no symlink,
 * no escape from the root), size limits, sha256, and actual content type
 * (magic bytes and image header; for video, ffprobe stream data plus a decode
 * check). Extensions select the expected format but are never trusted alone.
 */
export async function checkAssetFile(rootDir: string, rel: string, opts: CheckOptions): Promise<CheckOk | CheckFail> {
  const limits = opts.limits ?? DEFAULT_ASSET_LIMITS;
  let abs: string;
  try {
    abs = resolveWithin(rootDir, rel);
  } catch {
    return { ok: false, code: "ASSET_INVALID", message: `path "${rel}" escapes ${rootDir}` };
  }
  const ext = path.extname(abs).toLowerCase();
  const video = VIDEO_KINDS.has(opts.kind);
  if (video && !VIDEO_EXTENSIONS[ext]) return { ok: false, code: "UNSUPPORTED_ASSET_TYPE", message: `${rel}: ${ext || "no extension"} is not a supported video format for ${opts.kind} (${SUPPORTED_EXTENSIONS.video.join(" ")})` };
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { ok: false, code: "ASSET_MISSING", message: `file ${rel} does not exist` };
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: "ASSET_INVALID", message: `${rel} is not a regular file (symbolic links are not followed)` };
  const real = await fs.realpath(abs);
  if (!isWithin(await fs.realpath(rootDir), real)) return { ok: false, code: "ASSET_INVALID", message: `${rel} resolves outside ${rootDir}` };
  if (st.size === 0) return { ok: false, code: "ASSET_INVALID", message: `${rel} is empty` };
  const maxBytes = video ? limits.maxVideoBytes : TEXT_TYPES[ext] ? MAX_TEXT_BYTES : limits.maxImageBytes;
  if (st.size > maxBytes) return { ok: false, code: video ? "ASSET_LIMIT_EXCEEDED" : "ASSET_INVALID", message: `${rel} is ${st.size} bytes, larger than the ${maxBytes}-byte limit${video ? " (assets.maxVideoBytes)" : ""}` };
  const { sha256, bytes: size } = await sha256File(abs);
  if (opts.expectedSha256 && sha256 !== opts.expectedSha256) return { ok: false, code: "ASSET_INVALID", message: `${rel} hash ${sha256.slice(0, 19)}… does not match the registered ${opts.expectedSha256.slice(0, 19)}… (the file changed after registration; run \`creatorflow assets update --id <id> --refresh\` if the change is intended)` };

  if (video) {
    const v = VIDEO_EXTENSIONS[ext]!;
    const p = await probeVideo(abs, rel, v.container, opts.tools, limits, opts.signal);
    if (!p.ok) return p;
    return { ok: true, abs, sha256, size, mediaType: v.mediaType, media: { kind: "video", mediaType: v.mediaType, width: p.info.width, height: p.info.height, video: p.info } };
  }
  const img = IMAGE_TYPES[ext];
  if (img) {
    const bytes = await fs.readFile(abs);
    if (!img.magic(bytes)) return { ok: false, code: "ASSET_INVALID", message: `${rel} does not contain ${img.mediaType} data` };
    const dim = imageSize(bytes, img.mediaType);
    if (!dim) return { ok: false, code: "ASSET_INVALID", message: `${rel} has a damaged ${img.mediaType} header (no readable dimensions)` };
    return { ok: true, abs, sha256, size, mediaType: img.mediaType, media: { kind: "image", mediaType: img.mediaType, ...dim } };
  }
  if (TEXT_TYPES[ext] && opts.kind === "code-snippet") {
    const text = (await fs.readFile(abs)).toString("utf8");
    if (text.includes("\uFFFD") || text.includes("\u0000")) return { ok: false, code: "ASSET_INVALID", message: `${rel} is not valid UTF-8 text` };
    return { ok: true, abs, sha256, size, mediaType: "text/plain", media: { kind: "text", mediaType: "text/plain" }, text };
  }
  if (VIDEO_EXTENSIONS[ext]) return { ok: false, code: "UNSUPPORTED_ASSET_TYPE", message: `${rel} is a video; ${opts.kind} slots take images${opts.kind === "code-snippet" ? " or text" : ""} (register it as screen-recording or b-roll for a video scene)` };
  return { ok: false, code: "UNSUPPORTED_ASSET_TYPE", message: `${rel}: ${ext || "no extension"} is not supported for ${opts.kind} (images: ${SUPPORTED_EXTENSIONS.image.join(" ")}${opts.kind === "code-snippet" ? `; code: ${SUPPORTED_EXTENSIONS.text.join(" ")}` : ""})` };
}

/** Whether a registered asset type may fill a scene slot of `slotKind` (video only in video slots). */
export function slotAccepts(slotKind: string, type: AssetType | undefined): boolean {
  if (!type) return true;
  return VIDEO_KINDS.has(slotKind) === VIDEO_KINDS.has(type);
}

/**
 * Validates a clip window against the measured source duration. Never trims
 * silently: an end beyond the source is an error, not a clamp.
 */
export function resolveClip(clip: { startSec: number; endSec?: number; fit: "contain" | "cover" } | undefined, durationSec: number, fps: number): { ok: true; clip: { startSec: number; endSec: number; fit: "contain" | "cover" } } | { ok: false; message: string } {
  const startSec = clip?.startSec ?? 0;
  const endSec = clip?.endSec ?? durationSec;
  const tol = 1 / Math.max(1, fps);
  if (startSec >= durationSec) return { ok: false, message: `clip start ${startSec}s is at or after the end of the ${durationSec}s source` };
  if (endSec > durationSec + tol) return { ok: false, message: `clip end ${endSec}s is after the end of the ${durationSec}s source` };
  if (endSec - startSec < 0.2) return { ok: false, message: `clip window ${startSec}–${endSec}s is shorter than 0.2 s` };
  return { ok: true, clip: { startSec, endSec: Math.min(endSec, durationSec), fit: clip?.fit ?? "contain" } };
}

/** Lazily located media tools (one lookup per step run). */
export function mediaToolsLoader(config: Parameters<typeof findFfprobe>[0]): () => Promise<MediaTools | null> {
  let p: Promise<MediaTools | null> | undefined;
  return () =>
    (p ??= (async () => {
      const [ffprobe, ffmpeg] = await Promise.all([findFfprobe(config), findFfmpeg(config)]);
      return ffprobe && ffmpeg ? { ffprobe, ffmpeg } : null;
    })());
}

// ------------------------------------------------------------------ step definition

export function assetsStepInputs(ctx: FingerprintContext): unknown {
  return { contentId: ctx.item.contentId };
}

export function assetsStepConfig(ctx: FingerprintContext): unknown {
  return { fonts: ctx.profile.brand.fonts, logoPath: ctx.profile.brand.logoPath ?? null, captions: ctx.config.render.captions, limits: ctx.config.assets };
}

const bindingFingerprint = (b: SlotBinding) => ({ assetId: b.assetId, registryId: b.registryId ?? null, type: b.type ?? null, path: b.path, sha256: b.sha256, provenance: b.provenance, clip: b.clip ?? null });

/**
 * Cheap change detector for a bound file (size + modification time, no hashing on every resume).
 * A change makes the assets step re-run, which then verifies the full content hash.
 */
async function fileStamp(assetsRoot: string, rel: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  try {
    const st = await fs.lstat(resolveWithin(assetsRoot, rel));
    return { bytes: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * Registry bindings for THIS job only (so unrelated registrations do not invalidate it), the
 * current size/mtime of each bound file (so an edited file is noticed even if the registry is
 * unchanged), the logo hash and font package versions.
 */
export async function assetsStepExternalInputs(ctx: FingerprintContext & { workspaceDir: string }): Promise<unknown> {
  const reg = await loadRegistry(ctx.workspaceDir);
  const root = resolveWithin(ctx.workspaceDir, "assets");
  const mine = reg.bindings.filter((a) => a.jobId === ctx.jobId).sort((a, b) => (a.assetId < b.assetId ? -1 : 1));
  const entries = [];
  for (const b of mine) entries.push({ ...bindingFingerprint(b), file: await fileStamp(root, b.path) });
  const versions: Record<string, string | null> = {};
  for (const f of Object.values(ctx.profile.brand.fonts)) {
    const dir = fontsourceDir(f.family);
    versions[f.family] = dir ? ((await readJsonFile(path.join(dir, "package.json"))) as { version: string }).version : null;
  }
  let logo: string | null = null;
  if (ctx.profile.brand.logoPath) {
    const p = path.resolve(path.dirname(path.resolve(projectDirOf(ctx.workspaceDir, ctx.config), ctx.config.profilePath)), ctx.profile.brand.logoPath);
    logo = await fs.readFile(p).then((b) => `sha256:${sha256Hex(b)}`, () => null);
  }
  return { registryProblem: reg.problem ?? null, entries, fontPackages: versions, logo };
}

/** Texts drawn with each font slot (see apps/remotion-studio/src/Video.tsx). */
export function slotTexts(manifest: SceneManifest, captionLines: string[], codeTexts: string[], attributions: string[] = []): Record<FontSlot, string[]> {
  const primaries = manifest.scenes.map((s) => s.text.primary);
  const secondaries = manifest.scenes.flatMap((s) => (s.text.secondary ? [s.text.secondary] : []));
  const brand = [manifest.brand.name, manifest.brand.name.toUpperCase()];
  const labels = ["Comparison point", "Key point"].flatMap((l) => [l, l.toUpperCase()]);
  return {
    heading: [...primaries, ...brand, "\u201C"],
    body: [...primaries, ...secondaries, ...captionLines, ...brand, ...labels, ...attributions, ...FIXED_LABELS.body],
    mono: [...codeTexts],
  };
}

/**
 * Assets step: resolves every scene-manifest asset against the local
 * registry, the brand logo and the brand fonts, verifying files, hashes,
 * actual media content (video streams are re-measured and decoded, never
 * taken from the registry), clip windows, attribution and glyph coverage.
 * Required assets that cannot be resolved block the job; optional ones fall
 * back to text-only scenes, recorded explicitly. Narration is handled by the
 * narrate step.
 */
export async function assetsStepExecute(ctx: StepContext): Promise<StepResult> {
  const m = await readVerifiedOutput(ctx, "script", SCRIPT_OUTPUTS.manifest);
  const cap = await readVerifiedOutput(ctx, "script", SCRIPT_OUTPUTS.captions);
  for (const r of [m, cap]) if (!r.ok) return { status: "blocked", code: r.code, reason: r.reason };
  if (!m.ok || !cap.ok) throw new Error("unreachable");
  const mv = validateArtifact(SceneManifestSchema, JSON.parse(m.file.raw));
  const cv = validateArtifact(CaptionsFileSchema, JSON.parse(cap.file.raw));
  if (!mv.ok || !cv.ok) throw new StepError("Scene manifest or captions failed schema validation", { kind: "permanent", code: "MANIFEST_INVALID" });
  const manifest = mv.value;
  const projectDir = projectDirOf(ctx.workspaceDir, ctx.config);
  const assetsRoot = resolveWithin(ctx.workspaceDir, "assets");
  const reg = await loadRegistry(ctx.workspaceDir);
  if (reg.problem) return { status: "blocked", code: "ASSET_REGISTRY_INVALID", reason: reg.problem };
  const tools = mediaToolsLoader(ctx.config);
  const limits = ctx.config.assets;

  const issues: AssetIssue[] = [];
  const warnings: string[] = [];
  const resolved: AssetResolution["assets"] = [];
  const codeTexts: string[] = [];
  const attributions: string[] = [];
  for (const a of manifest.assets) {
    if (a.kind === "font") {
      resolved.push({ assetId: a.assetId, kind: a.kind, required: a.required, status: "font", note: "resolved with the brand fonts below" });
      continue;
    }
    let check: CheckOk | CheckFail | undefined;
    let root: "assets" | "project" = "assets";
    let rel = "";
    let binding: SlotBinding | undefined;
    if (a.assetId === "ast-brand-logo") {
      root = "project";
      const profileDir = path.dirname(resolveWithin(projectDir, ctx.config.profilePath));
      rel = toPosix(path.relative(projectDir, path.resolve(profileDir, ctx.profile.brand.logoPath ?? "")));
      check = await checkAssetFile(projectDir, rel, { kind: "logo", limits });
    } else {
      binding = reg.bindings.find((e) => e.jobId === ctx.jobId && e.assetId === a.assetId);
      if (binding) {
        rel = binding.path;
        if (!slotAccepts(a.kind, binding.type)) check = { ok: false, code: "ASSET_INVALID", message: `${binding.registryId ?? rel} is registered as ${binding.type}, but scene slot ${a.assetId} needs ${VIDEO_KINDS.has(a.kind) ? "a video" : "an image or text"}` };
        else check = await checkAssetFile(assetsRoot, binding.path, { kind: a.kind, expectedSha256: binding.sha256, limits, tools: VIDEO_KINDS.has(a.kind) ? await tools() : null, signal: ctx.signal });
      }
    }
    if (check?.ok) {
      const entry: AssetResolution["assets"][number] = {
        assetId: a.assetId,
        kind: a.kind,
        required: a.required,
        status: "resolved",
        file: { root, path: rel, sha256: check.sha256, mediaType: check.mediaType, bytes: check.size, ...(binding?.registryId ? { registryId: binding.registryId } : {}) },
      };
      if (binding) {
        const pv = binding.provenance;
        entry.provenance = { origin: pv.origin, verification: pv.verification, ...(pv.license ? { license: pv.license } : {}), attributionRequired: pv.attributionRequired };
        entry.license = pv.license ?? "unknown";
        if (pv.attribution) entry.attribution = pv.attribution;
        if (!pv.license) warnings.push(`${a.assetId}: licence unknown (origin ${pv.origin}); registration does not mean the file is cleared for publication`);
        if (pv.attributionRequired && !pv.attribution) {
          issues.push({ assetId: a.assetId, code: "ATTRIBUTION_MISSING", message: `${binding.registryId ?? rel} requires attribution but none is recorded; add it with \`creatorflow assets update --id ${binding.registryId ?? "<id>"} --attribution "..."\`` });
          continue;
        }
        if (pv.attributionRequired && pv.attribution) attributions.push(pv.attribution);
      } else entry.license = "brand asset (declared in creator profile)";
      if (check.media.kind === "video") {
        const info = check.media.video!;
        const c = resolveClip(binding?.clip, info.durationSec, info.fps);
        if (!c.ok) {
          issues.push({ assetId: a.assetId, code: "ASSET_INVALID", message: `${rel}: ${c.message}; fix it with \`creatorflow assets update --id ${binding?.registryId ?? "<id>"} --use ${ctx.jobId}:${a.assetId} --start <s> --end <s>\`` });
          continue;
        }
        entry.video = info;
        entry.clip = c.clip;
        if (info.rotation % 360 !== 0) warnings.push(`${a.assetId}: source has ${info.rotation}° rotation metadata; check the framing in the render`);
      }
      resolved.push(entry);
      if (check.text !== undefined) codeTexts.push(check.text);
      continue;
    }
    const why = check ? check.message : `not registered in workspace/${REGISTRY_REL} for job ${ctx.jobId}`;
    const code: AssetIssue["code"] = check ? check.code : "ASSET_MISSING";
    if (!a.required && code !== "ASSET_INVALID" && code !== "ASSET_LIMIT_EXCEEDED") {
      resolved.push({ assetId: a.assetId, kind: a.kind, required: false, status: "text-only-fallback", note: `optional ${a.kind} unavailable (${why}); the scene is rendered text-only` });
      warnings.push(`${a.assetId}: optional ${a.kind} unavailable; text-only fallback`);
      continue;
    }
    issues.push({ assetId: a.assetId, code, message: why });
  }

  // Fonts with verified glyph coverage for every character they will draw.
  const texts = slotTexts(manifest, cv.value.tracks.flatMap((t) => t.cues.flatMap((c) => c.lines)), codeTexts, attributions);
  const fonts: AssetResolution["fonts"] = [];
  const fontProblems: string[] = [];
  for (const slot of ["heading", "body", "mono"] as const) {
    const r = await resolveFont(slot, ctx.profile.brand.fonts[slot], projectDir);
    if (!r.ok) {
      fontProblems.push(`${r.code}: ${r.message}`);
      continue;
    }
    const need = requiredCodePoints(texts[slot]);
    const missing = missingGlyphs(r.files, need);
    if (missing.length) {
      fontProblems.push(`FONT_GLYPHS_MISSING: ${slot} font "${r.family}" has no glyphs for ${missing.length} character(s): ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", …" : ""}. Use a font that covers this script (for example a Noto Sans family as a local-file font)`);
      continue;
    }
    fonts.push({
      slot,
      family: r.family,
      source: r.source,
      license: r.license,
      files: r.files.map((f) => ({ root: f.root, path: f.path, sha256: f.sha256, weight: f.weight, unicodeRange: unicodeRange(f.codePoints) })),
      coverage: "verified",
      checkedCharacters: need.size,
    });
    if (r.license === "unknown") warnings.push(`${slot} font "${r.family}" has no recorded licence`);
  }

  if (issues.length || fontProblems.length) {
    const parts: string[] = [];
    if (issues.length) parts.push(`${issues.length} required asset(s) unavailable: ${issues.map((i) => `${i.assetId} [${i.code}] ${i.message}`).join("; ")}. Register local files with \`creatorflow assets register --file <path> --type <type> --job ${ctx.jobId} --slot <assetId>\``);
    parts.push(...fontProblems);
    const precedence: AssetIssue["code"][] = ["ASSET_INVALID", "ASSET_LIMIT_EXCEEDED", "ATTRIBUTION_MISSING", "MEDIA_TOOLS_UNAVAILABLE", "UNSUPPORTED_ASSET_TYPE"];
    const code = fontProblems.length && !issues.length ? (fontProblems[0]!.split(":")[0] as string) : (precedence.find((c) => issues.some((i) => i.code === c)) ?? "ASSETS_MISSING");
    return { status: "blocked", code, reason: parts.join(". ") };
  }

  const out: AssetResolution = {
    schemaVersion: 1,
    kind: "asset-resolution",
    contentId: manifest.contentId,
    manifest: { path: SCRIPT_OUTPUTS.manifest, sha256: m.file.sha256 },
    assets: resolved,
    fonts,
    narration: { mode: ctx.profile.voice.mode, audio: ctx.profile.voice.mode === "none" ? "none" : "narration-step" },
    warnings,
  };
  const v = validateArtifact(AssetResolutionSchema, out);
  if (!v.ok) throw new StepError(`Asset resolution invalid: ${v.issues[0]?.path}: ${v.issues[0]?.message}`, { kind: "permanent", code: "ASSET_RESOLUTION_INVALID" });
  if (ctx.signal.aborted) throw ctx.signal.reason;
  await fs.mkdir(path.dirname(ctx.outputPath(ASSET_OUTPUT)), { recursive: true });
  await writeFileAtomic(ctx.outputPath(ASSET_OUTPUT), stringifyJson(v.value));
  return { status: "succeeded", metadata: { assets: resolved.length, fallbacks: resolved.filter((r) => r.status === "text-only-fallback").length, videos: resolved.filter((r) => r.video).length, fonts: fonts.length } };
}

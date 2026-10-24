import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { resolveWithin, sha256Hex, toPosix } from "@creatorflow/core";
import type { CreatorProfile } from "@creatorflow/schemas";

/**
 * Glyph coverage is read from each font file's own `cmap` table (TrueType /
 * OpenType / WOFF 1.0). WOFF2 is not parsed (Brotli + table transforms), so
 * WOFF2-only fonts cannot be verified and are rejected rather than trusted.
 */
export class FontParseError extends Error {}

function sfntTables(buf: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  const sig = buf.toString("latin1", 0, 4);
  if (sig === "wOFF") {
    const num = buf.readUInt16BE(12);
    for (let i = 0; i < num; i++) {
      const o = 44 + i * 20;
      const tag = buf.toString("latin1", o, o + 4);
      const off = buf.readUInt32BE(o + 4);
      const comp = buf.readUInt32BE(o + 8);
      const orig = buf.readUInt32BE(o + 12);
      const data = buf.subarray(off, off + comp);
      tables.set(tag, comp < orig ? inflateSync(data) : Buffer.from(data));
    }
    return tables;
  }
  if (sig === "wOF2") throw new FontParseError("WOFF2 fonts cannot be checked for glyph coverage; use the .woff, .ttf or .otf file");
  const v = buf.readUInt32BE(0);
  if (v !== 0x00010000 && sig !== "OTTO" && sig !== "true") throw new FontParseError("not a TrueType/OpenType/WOFF font");
  const num = buf.readUInt16BE(4);
  for (let i = 0; i < num; i++) {
    const o = 12 + i * 16;
    const tag = buf.toString("latin1", o, o + 4);
    const off = buf.readUInt32BE(o + 8);
    const len = buf.readUInt32BE(o + 12);
    tables.set(tag, buf.subarray(off, off + len));
  }
  return tables;
}

/** Code points with a non-zero glyph in the font's best Unicode cmap subtable (format 4 or 12). */
export function fontCodePoints(buf: Buffer): Set<number> {
  const cmap = sfntTables(buf).get("cmap");
  if (!cmap) throw new FontParseError("font has no cmap table");
  const n = cmap.readUInt16BE(2);
  let best: { off: number; format: number } | undefined;
  for (let i = 0; i < n; i++) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const off = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(off);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (!best || (format === 12 && best.format === 4)) best = { off, format };
  }
  if (!best) throw new FontParseError("font has no Unicode cmap (format 4/12)");
  const out = new Set<number>();
  const t = cmap.subarray(best.off);
  if (best.format === 12) {
    const groups = t.readUInt32BE(12);
    for (let g = 0; g < groups; g++) {
      const start = t.readUInt32BE(16 + g * 12);
      const end = t.readUInt32BE(20 + g * 12);
      const glyph = t.readUInt32BE(24 + g * 12);
      for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
    }
    return out;
  }
  const segX2 = t.readUInt16BE(6);
  const endO = 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = t.readUInt16BE(endO + s * 2);
    const start = t.readUInt16BE(startO + s * 2);
    const delta = t.readInt16BE(deltaO + s * 2);
    const ro = t.readUInt16BE(rangeO + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (ro === 0) glyph = (c + delta) & 0xffff;
      else {
        const gi = rangeO + s * 2 + ro + (c - start) * 2;
        glyph = gi + 1 < t.length ? t.readUInt16BE(gi) : 0;
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(c);
    }
  }
  return out;
}

/** Compact CSS unicode-range from a code-point set. */
export function unicodeRange(cps: ReadonlySet<number>): string {
  const sorted = [...cps].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const hex = (n: number) => n.toString(16).toUpperCase();
    parts.push(i === j ? `U+${hex(sorted[i]!)}` : `U+${hex(sorted[i]!)}-${hex(sorted[j]!)}`);
    i = j + 1;
  }
  return parts.join(",");
}

/** Characters that need a glyph (whitespace, controls, format characters such as ZWJ/ZWNJ excluded). */
export function requiredCodePoints(texts: Iterable<string>): Set<number> {
  const out = new Set<number>();
  for (const t of texts) for (const ch of t.normalize("NFC")) {
    if (/[\s\p{Cc}\p{Cf}]/u.test(ch)) continue;
    out.add(ch.codePointAt(0)!);
  }
  return out;
}

export type FontSlot = "heading" | "body" | "mono";
export const SLOT_WEIGHTS: Record<FontSlot, number[]> = { heading: [700], body: [400, 600], mono: [400] };

export interface ResolvedFontFile {
  root: "fontsource" | "project";
  /** Relative to root. */
  path: string;
  abs: string;
  sha256: string;
  weight: number;
  codePoints: Set<number>;
}

export type FontResolution =
  | { ok: true; slot: FontSlot; family: string; source: string; license: string; files: ResolvedFontFile[] }
  | { ok: false; slot: FontSlot; family: string; code: "FONT_UNAVAILABLE" | "FONT_UNVERIFIABLE"; message: string };

const require = createRequire(import.meta.url);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Directory of an installed @fontsource package, if any. Never downloads. */
export function fontsourceDir(family: string): string | undefined {
  try {
    return path.dirname(require.resolve(`@fontsource/${slug(family)}/package.json`));
  } catch {
    return undefined;
  }
}

async function loadFile(root: ResolvedFontFile["root"], rootDir: string, rel: string, weight: number): Promise<ResolvedFontFile> {
  const abs = resolveWithin(rootDir, rel);
  const st = await fs.lstat(abs);
  if (!st.isFile()) throw new FontParseError(`${rel} is not a regular file`);
  const buf = await fs.readFile(abs);
  return { root, path: toPosix(rel), abs, sha256: `sha256:${sha256Hex(buf)}`, weight, codePoints: fontCodePoints(buf) };
}

/**
 * Resolves a brand font slot to local files without network access:
 * - google-fonts / bundled: an installed @fontsource/<family> package (all subsets, normal style)
 * - local-file: profile `path` inside the project directory (.woff/.ttf/.otf)
 * - system: rejected, because glyph coverage cannot be verified
 */
export async function resolveFont(slot: FontSlot, font: CreatorProfile["brand"]["fonts"]["heading"], projectDir: string): Promise<FontResolution> {
  const base = { slot, family: font.family };
  try {
    if (font.source === "system") {
      return { ...base, ok: false, code: "FONT_UNVERIFIABLE", message: `${slot} font "${font.family}" is a system font; its glyph coverage cannot be verified. Use source "local-file" with a .woff/.ttf/.otf path, or an installed @fontsource package` };
    }
    if (font.source === "local-file") {
      if (!font.path) return { ...base, ok: false, code: "FONT_UNAVAILABLE", message: `${slot} font "${font.family}" has source "local-file" but no path` };
      if (!/\.(woff|ttf|otf)$/i.test(font.path)) return { ...base, ok: false, code: "FONT_UNVERIFIABLE", message: `${slot} font file ${font.path} must be .woff, .ttf or .otf so glyph coverage can be checked` };
      const files = [];
      for (const w of SLOT_WEIGHTS[slot]) files.push(await loadFile("project", projectDir, font.path, w));
      return { ...base, ok: true, source: font.source, license: font.license, files };
    }
    const dir = fontsourceDir(font.family);
    if (!dir) {
      return { ...base, ok: false, code: "FONT_UNAVAILABLE", message: `${slot} font "${font.family}" (${font.source}) is not installed locally and CreatorFlow does not download fonts. Install @fontsource/${slug(font.family)} or use a local-file font` };
    }
    const names = await fs.readdir(path.join(dir, "files"));
    const files: ResolvedFontFile[] = [];
    for (const w of SLOT_WEIGHTS[slot]) {
      const re = new RegExp(`^${slug(font.family)}-[a-z-]+-${w}-normal\\.woff$`);
      for (const n of names.filter((x) => re.test(x)).sort()) files.push(await loadFile("fontsource", path.dirname(dir), `${path.basename(dir)}/files/${n}`, w));
    }
    if (files.length === 0) return { ...base, ok: false, code: "FONT_UNAVAILABLE", message: `@fontsource/${slug(font.family)} has no .woff files for weight ${SLOT_WEIGHTS[slot].join("/")}` };
    return { ...base, ok: true, source: font.source, license: font.license, files };
  } catch (error) {
    return { ...base, ok: false, code: error instanceof FontParseError ? "FONT_UNVERIFIABLE" : "FONT_UNAVAILABLE", message: `${slot} font "${font.family}": ${(error as Error).message}` };
  }
}

/** Root directory for each font file root kind. */
export function fontRootDir(root: ResolvedFontFile["root"], family: string, projectDir: string): string {
  if (root === "project") return projectDir;
  const dir = fontsourceDir(family);
  if (!dir) throw new Error(`@fontsource package for ${family} is no longer installed`);
  return path.dirname(dir);
}

/** Characters (as "x U+XXXX") missing from every file of a slot, per weight. */
export function missingGlyphs(files: readonly ResolvedFontFile[], need: ReadonlySet<number>): string[] {
  const byWeight = new Map<number, Set<number>>();
  for (const f of files) {
    const s = byWeight.get(f.weight) ?? new Set<number>();
    for (const c of f.codePoints) s.add(c);
    byWeight.set(f.weight, s);
  }
  const missing = new Set<number>();
  for (const cps of byWeight.values()) for (const c of need) if (!cps.has(c)) missing.add(c);
  return [...missing].sort((a, b) => a - b).map((c) => `${String.fromCodePoint(c)} U+${c.toString(16).toUpperCase().padStart(4, "0")}`);
}

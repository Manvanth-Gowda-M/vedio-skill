import { promises as fs } from "node:fs";
import { resolveWithin, sha256File, sha256Hex } from "@creatorflow/core";
import type { StepContext } from "./pipeline.ts";

export interface VerifiedFile {
  raw: string;
  sha256: string;
}

export type VerifiedRead = { ok: true; file: VerifiedFile } | { ok: false; code: string; reason: string };

/**
 * Reads a job file recorded as a verified output of `stepId` and checks that
 * its bytes still match the recorded hash. Anything else is reported, never used.
 */
export async function readVerifiedOutput(ctx: Pick<StepContext, "verified" | "jobDir">, stepId: string, rel: string): Promise<VerifiedRead> {
  const rec = ctx.verified[stepId]?.find((o) => o.path === rel);
  if (!rec) return { ok: false, code: "UPSTREAM_MISSING", reason: `${rel} is not a verified output of the ${stepId} step` };
  let raw: string;
  try {
    raw = await fs.readFile(resolveWithin(ctx.jobDir, rel), "utf8");
  } catch {
    return { ok: false, code: "UPSTREAM_MISSING", reason: `${rel} is missing; run resume to regenerate it` };
  }
  const sha256 = `sha256:${sha256Hex(raw)}`;
  if (sha256 !== rec.sha256) return { ok: false, code: "UPSTREAM_MODIFIED", reason: `${rel} changed after the ${stepId} step verified it; run resume to re-verify` };
  return { ok: true, file: { raw, sha256 } };
}

/** Like readVerifiedOutput for binary files: streams the hash and returns the absolute path only. */
export async function verifiedBinaryOutput(ctx: Pick<StepContext, "verified" | "jobDir">, stepId: string, rel: string): Promise<{ ok: true; abs: string; sha256: string; bytes: number } | { ok: false; code: string; reason: string }> {
  const rec = ctx.verified[stepId]?.find((o) => o.path === rel);
  if (!rec) return { ok: false, code: "UPSTREAM_MISSING", reason: `${rel} is not a verified output of the ${stepId} step` };
  const abs = resolveWithin(ctx.jobDir, rel);
  const h = await sha256File(abs).catch(() => undefined);
  if (!h) return { ok: false, code: "UPSTREAM_MISSING", reason: `${rel} is missing; run resume to regenerate it` };
  if (h.sha256 !== rec.sha256) return { ok: false, code: "UPSTREAM_MODIFIED", reason: `${rel} changed after the ${stepId} step verified it; run resume to re-verify` };
  return { ok: true, abs, sha256: h.sha256, bytes: h.bytes };
}

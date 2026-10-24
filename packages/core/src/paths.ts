import path from "node:path";
import { CreatorFlowError, ExitCode } from "./errors.ts";

/** True when `candidate` is `root` itself or located inside it (after resolution). */
export function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `relativePath` against `root`, refusing anything that escapes `root`
 * (path traversal, absolute paths on another drive, etc.).
 */
export function resolveWithin(root: string, relativePath: string): string {
  if (relativePath.includes("\0")) {
    throw new CreatorFlowError("Path contains a NUL byte.", {
      code: "PATH_INVALID",
      exitCode: ExitCode.IO,
    });
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!isWithin(resolvedRoot, resolved)) {
    throw new CreatorFlowError(`Path "${relativePath}" escapes the allowed directory.`, {
      code: "PATH_TRAVERSAL",
      hint: `Use a path inside ${resolvedRoot}.`,
      exitCode: ExitCode.IO,
      details: { root: resolvedRoot, requested: relativePath },
    });
  }
  return resolved;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates identifiers used as directory or file names (content IDs, job IDs). */
export function assertSafeId(id: string, label = "identifier"): string {
  if (id.length === 0 || id.length > 80 || !SLUG_RE.test(id)) {
    throw new CreatorFlowError(`Invalid ${label} "${id}".`, {
      code: "ID_INVALID",
      hint: "Use 1-80 lowercase letters, digits and single hyphens.",
      exitCode: ExitCode.USAGE,
    });
  }
  return id;
}

/** Converts free text into a safe slug. Returns "" if nothing usable remains. */
export function slugify(text: string, maxLength = 60): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** Normalises a path for display/storage using forward slashes. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

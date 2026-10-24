import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Fingerprint semantics, version 1 ("cf-fp-v1"):
 * - Values are serialised as canonical JSON: object keys sorted by UTF-16 code
 *   unit order, no whitespace, array order preserved, `undefined` properties
 *   dropped, strings not Unicode-normalised.
 * - Non-JSON values (functions, symbols, bigint, NaN/Infinity, Dates, class
 *   instances) are rejected so they can never silently change a hash.
 * - The digest is sha256 over "cf-fp-v1\n" + canonical JSON, written "sha256:<hex>".
 * Changing any of these rules requires bumping FINGERPRINT_VERSION, which
 * intentionally invalidates every stored fingerprint.
 */
export const FINGERPRINT_VERSION = "cf-fp-v1";

export function canonicalJson(value: unknown): string {
  const walk = (v: unknown, at: string): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
        return JSON.stringify(v);
      case "boolean":
        return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) throw new TypeError(`Non-finite number at ${at || "(root)"} cannot be fingerprinted`);
        return JSON.stringify(v);
      case "object": {
        if (Array.isArray(v)) return `[${v.map((item, i) => walk(item === undefined ? null : item, `${at}[${i}]`)).join(",")}]`;
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) {
          throw new TypeError(`Non-plain object at ${at || "(root)"} cannot be fingerprinted`);
        }
        const entries = Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${walk(val, at ? `${at}.${k}` : k)}`).join(",")}}`;
      }
      default:
        throw new TypeError(`Value of type ${typeof v} at ${at || "(root)"} cannot be fingerprinted`);
    }
  };
  return walk(value, "");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Versioned content fingerprint of a JSON-compatible value. */
export function fingerprint(value: unknown): string {
  return `sha256:${sha256Hex(`${FINGERPRINT_VERSION}\n${canonicalJson(value)}`)}`;
}

/** Streams a file through sha256; returns "sha256:<hex>" and the byte count. */
export function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    createReadStream(filePath)
      .on("data", (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve({ sha256: `sha256:${hash.digest("hex")}`, bytes }));
  });
}

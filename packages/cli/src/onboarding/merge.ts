export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges plain objects left to right. Arrays and scalars from later
 * sources replace earlier ones; `undefined` never overwrites a value.
 */
export function deepMerge<T>(...sources: unknown[]): T {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined) continue;
      const prev = out[key];
      out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : structuredClone(value);
    }
  }
  return out as T;
}

export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

export function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

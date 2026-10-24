/**
 * Text helpers for untrusted source material. Nothing here executes, renders
 * or follows anything in the input: HTML is reduced to plain text with
 * regular expressions solely so excerpts can be matched.
 */

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text from an HTML document: drops comments, scripts, styles and all tags. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(p|div|br|li|h[1-6]|tr|section|article|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Normalisation used for excerpt matching: NFKC, lower case, unified quotes/dashes, collapsed whitespace. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsExcerpt(text: string, excerpt: string): boolean {
  const e = normalizeForMatch(excerpt);
  return e.length > 0 && normalizeForMatch(text).includes(e);
}

const STOPWORDS = new Set(
  "a an and are as at be by can for from has have how in into is it its of on or that the their this to vs was what when where which who why will with without you your new using use guide".split(" "),
);

/** Lower-case word tokens without stopwords; trailing plural "s" removed for words longer than 3 letters. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const words = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** True when every token of `term` occurs in `text` tokens (whole-word, order-independent). */
export function mentionsTerm(textTokens: ReadonlySet<string>, term: string): boolean {
  const t = tokens(term);
  if (t.size === 0) return false;
  for (const x of t) if (!textTokens.has(x)) return false;
  return true;
}

const INJECTION_PATTERNS: readonly [RegExp, string][] = [
  [/\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i, "asks to ignore previous instructions"],
  [/\byou are now\b|\bact as (an?|the) (ai|assistant|agent)\b/i, "tries to assign a new role"],
  [/\b(system prompt|developer message|<\s*\/?\s*system\s*>)/i, "mentions system prompts"],
  [/\b(run|execute)\b[^.\n]{0,30}\b(command|shell|script|curl|rm -rf|powershell)\b/i, "asks to run commands"],
];

/** Flags text that looks like instructions aimed at an AI agent. The text is still treated purely as data. */
export function injectionWarnings(text: string): string[] {
  return INJECTION_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/**
 * Canonical form of an http(s) URL: lower-case host, no fragment, no default
 * port, tracking parameters removed, remaining parameters sorted, no trailing slash.
 */
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const params = [...u.searchParams.entries()].filter(([k]) => !/^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i.test(k));
  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  u.search = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/** UTC calendar date (YYYY-MM-DD) of a source date string. */
export function dateOnly(d: string): string {
  return d.length === 10 ? d : new Date(d).toISOString().slice(0, 10);
}

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${dateOnly(toDate)}T00:00:00Z`) - Date.parse(`${dateOnly(fromDate)}T00:00:00Z`)) / 86_400_000);
}

/** Today's calendar date in an IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

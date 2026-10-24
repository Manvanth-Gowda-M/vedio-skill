/**
 * Unicode-aware text helpers. Lengths are measured in grapheme clusters, so
 * Indic conjuncts, combining marks and emoji are never split; words and
 * sentences come from Intl.Segmenter for the given language.
 */

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

export function graphemes(s: string): string[] {
  return Array.from(graphemeSegmenter.segment(s), (x) => x.segment);
}

export function graphemeLength(s: string): number {
  let n = 0;
  for (const _ of graphemeSegmenter.segment(s)) n++;
  return n;
}

const segmenterCache = new Map<string, Intl.Segmenter>();
function segmenter(lang: string, granularity: "word" | "sentence"): Intl.Segmenter {
  const key = `${lang}|${granularity}`;
  let s = segmenterCache.get(key);
  if (!s) {
    try {
      s = new Intl.Segmenter(lang, { granularity });
    } catch {
      s = new Intl.Segmenter("und", { granularity });
    }
    segmenterCache.set(key, s);
  }
  return s;
}

export function wordCount(text: string, lang: string): number {
  let n = 0;
  for (const s of segmenter(lang, "word").segment(text)) if (s.isWordLike) n++;
  return n;
}

export function sentences(text: string, lang: string): string[] {
  return Array.from(segmenter(lang, "sentence").segment(text), (s) => s.segment.trim()).filter(Boolean);
}

export function baseLanguage(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

/** Words per minute for a language: exact tag, then base language, then "default". */
export function speechRateFor(rates: Readonly<Record<string, number>>, lang: string): number {
  return rates[lang] ?? rates[baseLanguage(lang)] ?? rates["default"] ?? 150;
}

/** Spoken-duration estimate in seconds (no pauses). Provisional until real narration exists. */
export function estimateSpeechSec(text: string, lang: string, wpm: number, speakingRate = 1): number {
  return (wordCount(text, lang) / wpm) * 60 / speakingRate;
}

interface Token {
  text: string;
  spaceBefore: boolean;
}

function tokenize(text: string, lang: string, maxChars: number): Token[] {
  const tokens: Token[] = [];
  for (const chunk of text.split(/\s+/).filter(Boolean)) {
    if (graphemeLength(chunk) <= maxChars) {
      tokens.push({ text: chunk, spaceBefore: true });
      continue;
    }
    // Long chunk (e.g. scripts without spaces): split at word boundaries, keeping every character.
    let first = true;
    let buf = "";
    for (const s of segmenter(lang, "word").segment(chunk)) {
      if (buf && graphemeLength(buf + s.segment) > maxChars) {
        tokens.push({ text: buf, spaceBefore: first });
        first = false;
        buf = "";
      }
      buf += s.segment;
    }
    if (buf) tokens.push({ text: buf, spaceBefore: first });
  }
  return tokens;
}

/**
 * Greedy word wrap to `maxChars` graphemes per line. Never drops or truncates
 * text: a single word longer than the limit gets its own line and `overlong`.
 */
export function wrapText(text: string, lang: string, maxChars: number): { lines: string[]; overlong: boolean } {
  const lines: string[] = [];
  let cur = "";
  let overlong = false;
  for (const t of tokenize(text.trim(), lang, maxChars)) {
    const joined = cur ? `${cur}${t.spaceBefore ? " " : ""}${t.text}` : t.text;
    if (cur && graphemeLength(joined) > maxChars) {
      lines.push(cur);
      cur = t.text;
    } else {
      cur = joined;
    }
    if (graphemeLength(t.text) > maxChars) overlong = true;
  }
  if (cur) lines.push(cur);
  return { lines, overlong };
}

/** True when `lines` contain exactly the characters of `original` (whitespace aside). */
export function preservesText(original: string, lines: readonly string[]): boolean {
  return lines.join("").replace(/\s+/g, "") === original.replace(/\s+/g, "");
}

const UNSUPPORTED_PATTERNS: readonly [RegExp, string][] = [
  [/\d/, "contains a number"],
  [/\b(fastest|best|first|only|biggest|largest|cheapest|#1|number one|most popular|world'?s)\b/i, "contains a superlative"],
  [/\b(studies show|research shows|proven|guaranteed|scientifically|experts agree|everyone is)\b/i, "contains an unsourced authority claim"],
];
const CLICKBAIT_PATTERNS: readonly RegExp[] = [
  /\b(you won'?t believe|before it'?s too late|insane|mind[- ]?blowing|game[- ]?changer|secret (trick|hack)|shocking|act now|don'?t miss)\b/i,
  /!{2,}/,
];

/** Heuristic flags for text that is not taken verbatim from a supported claim. */
export function assertionFlags(text: string): string[] {
  return UNSUPPORTED_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export function clickbaitFlag(text: string): boolean {
  return CLICKBAIT_PATTERNS.some((re) => re.test(text));
}

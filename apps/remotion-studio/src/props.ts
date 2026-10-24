/**
 * Props contract between the Node render orchestrator (packages/video-engine)
 * and the Remotion composition. Plain JSON only: no functions, no code.
 * Built from the validated scene manifest, captions and asset resolution.
 */
export const COMPOSITION_ID = "CreatorFlowVideo";
export const RENDERER_VERSION = "2";

export type ComponentId = "Hook" | "Title" | "Explanation" | "Diagram" | "CodeDemo" | "Comparison" | "Quote" | "Summary" | "Outro" | "ScreenCapture";

/** Manifest scene type -> component. Anything not listed is rejected before rendering. */
export const SCENE_COMPONENTS: Readonly<Record<string, ComponentId>> = {
  "hook-typography": "Hook",
  "title-intro": "Title",
  "concept-explanation": "Explanation",
  "technical-diagram": "Diagram",
  "code-terminal-demo": "CodeDemo",
  "comparison-layout": "Comparison",
  "screen-capture": "ScreenCapture",
  "source-quote": "Quote",
  summary: "Summary",
  outro: "Outro",
};
/** Scene types the manifest can contain but this renderer cannot draw yet. */
export const UNSUPPORTED_SCENES: Readonly<Record<string, string>> = {};

/** Components that show a video inside a frame; every other component uses a video as a dimmed backdrop. */
export const FRAMED_VIDEO_COMPONENTS: ReadonlySet<ComponentId> = new Set(["ScreenCapture", "CodeDemo"]);

export interface VideoProp {
  /** File name under the bundle's public dir (staticFile). */
  file: string;
  /** Source offset in composition frames. */
  trimBefore: number;
  /** Frames of source shown (from trimBefore). */
  playFrames: number;
  /** Frames the last shown source frame is held when the clip is shorter than the scene. */
  holdFrames: number;
  fit: "contain" | "cover";
  layout: "frame" | "backdrop";
  width: number;
  height: number;
}

export interface FontFaceProp {
  /** File name under the bundle's public dir (staticFile). */
  file: string;
  weight: number;
  unicodeRange: string;
}

export interface SceneProp {
  sceneId: string;
  type: string;
  component: ComponentId;
  startFrame: number;
  durationInFrames: number;
  index: number;
  total: number;
  primary: string;
  secondary?: string;
  motion: { intent: string; intensity: "low" | "medium" | "high"; transitionIn: "cut" | "fade" | "slide" | "none" };
  safeArea: { top: number; bottom: number; left: number; right: number };
  /** Registered image (public dir file name) shown by Diagram/Quote/Outro/CodeDemo. */
  image?: { file: string; alt: string };
  /** Registered code text shown by CodeDemo. */
  code?: string;
  /** Registered, validated video clip. */
  video?: VideoProp;
  /** Attribution text the asset's provenance requires, shown verbatim. */
  attribution?: string;
  /** Optional media was unavailable; the scene is drawn text-only (recorded in the render report). */
  textOnlyFallback: boolean;
}

export interface CaptionProp {
  startFrame: number;
  endFrame: number;
  lines: string[];
}

export interface RenderProps {
  [key: string]: unknown;
  format: { width: number; height: number; fps: number; durationInFrames: number };
  brand: {
    name: string;
    colors: { primary: string; secondary: string; accent: string; background: string; text: string };
    fonts: Record<"heading" | "body" | "mono", { family: string; faces: FontFaceProp[] }>;
  };
  scenes: SceneProp[];
  captions: CaptionProp[];
  /** How caption times were obtained (see the narrate step). */
  captionsTiming: "estimated" | "sentence-aligned" | "word-aligned";
  /** Verified narration track (public dir file name). Absent = silent video. */
  audio?: { file: string };
}

// ------------------------------------------------------------------ pure layout helpers (unit-tested)

/** Font family name used in CSS for a slot (unique per render so system fonts never shadow it). */
export const cssFamily = (slot: "heading" | "body" | "mono") => `cf-${slot}`;

/** Base unit: 1% of the shorter side. Keeps typography proportional across aspect ratios. */
export function unit(width: number, height: number): number {
  return Math.min(width, height) / 100;
}

/** Headline size from text length: short hooks large, long claims smaller, within readable bounds. */
export function headlineSize(text: string, width: number, height: number, kind: "hook" | "headline" | "body"): number {
  const u = unit(width, height);
  const len = [...text].length;
  const base = kind === "hook" ? 9 : kind === "headline" ? 7 : 5.2;
  const scale = len <= 30 ? 1 : len <= 60 ? 0.85 : len <= 100 ? 0.72 : 0.62;
  return Math.round(base * scale * u);
}

/** Captions active at a frame (end exclusive). Never more than one by construction of the track. */
export function captionAt(captions: readonly CaptionProp[], frame: number): CaptionProp | undefined {
  return captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
}

export function sceneAt(scenes: readonly SceneProp[], frame: number): SceneProp | undefined {
  return scenes.find((s) => frame >= s.startFrame && frame < s.startFrame + s.durationInFrames);
}

/** Box for a framed video inside the safe area: "contain" keeps the source
 * aspect ratio (bounded by maxHeight), "cover" fills a fixed-height box and
 * crops the centre.
 */
export function videoBox(v: Pick<VideoProp, "width" | "height" | "fit">, innerWidth: number, maxHeight: number): { width: number; height: number } {
  const natural = (innerWidth * v.height) / v.width;
  return { width: Math.round(innerWidth), height: Math.round(v.fit === "contain" ? Math.min(maxHeight, natural) : maxHeight) };
}

/** Relative luminance and WCAG contrast ratio for #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Texts drawn with each font slot (used for glyph-coverage checks before rendering). */
export const FIXED_LABELS = { body: ["Source:", "Captions: estimated timing", "Open question"], mono: ["$", ">"] };

/**
 * Font sizes used by the composition, in units of `unit()` (1% of the shorter side).
 * Shared by Video.tsx and the QA step's minimum-font-size check, so both use one source.
 */
export const FONT_UNITS = { caption: 3.6, sourceLabel: 3.4, label: 3.2, code: 2.9, attribution: 2.6, outroBrand: 7, outroLine: 4 } as const;

/**
 * Caption box geometry (pixels) for a frame, as drawn by Video.tsx: centred
 * between 8% margins, bottom edge at 45% of the scene's bottom safe-area inset.
 * The box width depends on the text; `maxTextWidth` is the width available to it.
 */
export function captionLayout(width: number, height: number, sceneSafeBottom: number, lines: number) {
  const u = unit(width, height);
  const fontPx = u * FONT_UNITS.caption;
  const padV = u * 1.4;
  const padH = u * 2.4;
  const bottomPx = sceneSafeBottom * height * 0.45;
  const boxHeight = lines * fontPx * 1.3 + 2 * padV;
  return { fontPx, padV, padH, left: width * 0.08, right: width * 0.92, bottomPx, boxHeight, top: height - bottomPx - boxHeight, bottom: height - bottomPx, maxTextWidth: width * 0.84 - 2 * padH };
}

import type { CreatorFlowConfigInput, CreatorProfileInput } from "@creatorflow/schemas";

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type ProfileDraft = DeepPartial<CreatorProfileInput>;
export type ConfigDraft = DeepPartial<CreatorFlowConfigInput>;

/**
 * Non-essential defaults. They describe presentation choices only and never
 * assert facts about the creator, so applying them silently is safe.
 */
export const PROFILE_DEFAULTS: ProfileDraft = {
  schemaVersion: 1,
  languages: { additional: [] },
  platforms: { secondary: [] },
  brand: {
    colors: {
      primary: "#7C5CFF",
      secondary: "#22D3EE",
      accent: "#F59E0B",
      background: "#0B0D12",
      text: "#F5F7FA",
    },
    fonts: {
      heading: { family: "Inter", source: "google-fonts", license: "OFL-1.1" },
      body: { family: "Inter", source: "google-fonts", license: "OFL-1.1" },
      mono: { family: "JetBrains Mono", source: "google-fonts", license: "OFL-1.1" },
    },
  },
  visual: { styles: ["motion-typography", "technical-diagrams", "code-demos"], animationIntensity: "medium" },
  // No TTS provider is configured by default, so do not pretend narration exists.
  voice: { mode: "none", speakingRate: 1, glossary: [] },
  schedule: {
    weeklyTarget: 7,
    durations: { shortForm: { minSec: 30, maxSec: 60 }, longForm: { minSec: 480, maxSec: 900 } },
  },
  content: { restrictions: [], avoidTopics: [], newsFreshnessDays: 14, requireSourcesForClaims: true },
  approval: { requirePlanApproval: true, requireFinalReview: true, publishing: "manual-only" },
};

export const CONFIG_DEFAULTS: ConfigDraft = {
  schemaVersion: 1,
  profilePath: "creator-profile.json",
  workspaceDir: "workspace",
  hardware: { maxConcurrentRenders: 1 },
  providers: {},
  budget: { currency: "USD", monthlyLimit: 0, allowPaidProviders: false },
  offline: { preferOffline: true, allowNetworkResearch: false },
  logging: { level: "info" },
};

/** Opt-in starting points. Applied only when the user passes --preset. */
export const PRESETS: Record<string, ProfileDraft> = {
  "ai-dev-tools": {
    creator: {
      niche: "AI tools, coding agents, and developer technology",
      topics: ["AI coding agents", "developer tools", "model and API releases", "AI-assisted workflows", "open-source AI"],
      audience: {
        description: "Software developers and technical creators who want accurate, practical updates on AI tooling",
        expertise: "intermediate",
      },
    },
    platforms: { primary: "youtube-shorts", secondary: ["youtube-long", "instagram-reels"] },
    visual: {
      styles: ["motion-typography", "technical-diagrams", "code-demos", "screen-recordings", "comparison-layouts"],
    },
    voice: {
      glossary: [
        { term: "Claude Code", doNotTranslate: true },
        { term: "Kiro", doNotTranslate: true },
        { term: "OpenCode", doNotTranslate: true },
        { term: "Antigravity", doNotTranslate: true },
        { term: "Remotion", doNotTranslate: true },
      ],
    },
  },
};

/** Essential fields: init asks for these (and only these) when they are missing. */
export interface EssentialField {
  path: string;
  question: string;
  kind: "text" | "list" | "language" | "platform" | "platforms" | "timezone";
  /** Suggested default shown in interactive mode; never applied silently. */
  suggest?: (draft: ProfileDraft) => string | undefined;
}

export const ESSENTIAL_FIELDS: readonly EssentialField[] = [
  { path: "creator.displayName", question: "Creator / channel display name", kind: "text" },
  { path: "creator.niche", question: "Niche (one line)", kind: "text" },
  { path: "creator.topics", question: "Core topics (comma-separated)", kind: "list" },
  { path: "creator.audience.description", question: "Who is the audience?", kind: "text" },
  { path: "languages.primary", question: "Primary language (BCP 47, e.g. en, hi, es)", kind: "language", suggest: () => "en" },
  {
    path: "platforms.primary",
    question: "Primary platform (youtube-shorts, youtube-long, instagram-reels, tiktok, linkedin-video)",
    kind: "platform",
    suggest: () => "youtube-shorts",
  },
  {
    path: "schedule.timezone",
    question: "Time zone (IANA, e.g. Asia/Kolkata)",
    kind: "timezone",
    suggest: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  {
    path: "brand.name",
    question: "Brand name shown in videos",
    kind: "text",
    suggest: (d) => (d.creator?.displayName as string | undefined) ?? undefined,
  },
];

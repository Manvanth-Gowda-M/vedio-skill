import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CreatorProfileInput } from "@creatorflow/schemas";

/** Creates a unique temp directory; call the returned cleanup in afterEach. */
export async function makeTempDir(prefix = "cf-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export function validProfile(overrides: Record<string, unknown> = {}): CreatorProfileInput & Record<string, unknown> {
  return {
    schemaVersion: 1,
    creator: {
      displayName: "Test Channel",
      niche: "AI developer tools",
      topics: ["coding agents"],
      audience: { description: "Developers" },
    },
    languages: { primary: "en", additional: ["hi"] },
    platforms: { primary: "youtube-shorts", secondary: ["youtube-long"] },
    brand: {
      name: "Test",
      colors: { primary: "#111111", secondary: "#222222", accent: "#333333", background: "#000000", text: "#FFFFFF" },
      fonts: {
        heading: { family: "Inter", source: "google-fonts", license: "OFL-1.1" },
        body: { family: "Inter", source: "google-fonts", license: "OFL-1.1" },
        mono: { family: "JetBrains Mono", source: "google-fonts", license: "OFL-1.1" },
      },
    },
    visual: { styles: ["motion-typography"] },
    voice: { mode: "none" },
    schedule: {
      timezone: "Asia/Kolkata",
      durations: { shortForm: { minSec: 30, maxSec: 60 }, longForm: { minSec: 480, maxSec: 900 } },
    },
    content: {},
    approval: {},
    ...overrides,
  } as CreatorProfileInput & Record<string, unknown>;
}

export interface Captured {
  stdout: string;
  stderr: string;
  streams: { stdout: (s: string) => void; stderr: (s: string) => void };
}

export function captureStreams(): Captured {
  const c: Captured = {
    stdout: "",
    stderr: "",
    streams: {
      stdout: (s) => {
        c.stdout += s;
      },
      stderr: (s) => {
        c.stderr += s;
      },
    },
  };
  return c;
}

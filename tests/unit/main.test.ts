// In-process tests of main(): interactive init needs a TTY, which a child
// process cannot provide, so a scripted prompter stands in for the terminal.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/main.ts";
import { createScriptedPrompter } from "../../packages/cli/src/onboarding/prompter.ts";
import { captureStreams, makeTempDir } from "../helpers.ts";

describe("main()", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("runs interactive init when a TTY is present and asks only missing essentials", async () => {
    const io = captureStreams();
    const prompter = createScriptedPrompter(["My Channel", "", "", "", ""]);
    const code = await main(["node", "creatorflow", "-C", tmp.dir, "init", "--preset", "ai-dev-tools"], {
      streams: io.streams,
      prompter,
      isTty: true,
    });
    expect(code).toBe(0);
    // Preset covers niche/topics/audience/platform; language, timezone and brand accept suggestions.
    expect(prompter.asked).toHaveLength(4);
    expect(io.stdout).toContain("(created)");
    const profile = JSON.parse(await fs.readFile(path.join(tmp.dir, "creator-profile.json"), "utf8"));
    expect(profile.brand.name).toBe("My Channel");
    expect(profile.languages.primary).toBe("en");
  });

  it("never prompts in --json mode, even on a TTY", async () => {
    const io = captureStreams();
    const prompter = createScriptedPrompter([]);
    const code = await main(["node", "creatorflow", "-C", tmp.dir, "--json", "init"], { streams: io.streams, prompter, isTty: true });
    expect(code).toBe(2);
    expect(prompter.asked).toEqual([]);
    expect(JSON.parse(io.stdout)).toMatchObject({ ok: false, error: "INIT_MISSING_FIELDS" });
  });

  it("prints actionable human errors with hint and details", async () => {
    const io = captureStreams();
    const code = await main(["node", "creatorflow", "-C", tmp.dir, "init", "--non-interactive", "--name", "X"], { streams: io.streams });
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/error \[INIT_MISSING_FIELDS\]/);
    expect(io.stderr).toContain("- creator.niche:");
    expect(io.stderr).toMatch(/hint: /);
  });
});

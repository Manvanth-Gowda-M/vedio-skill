// End-to-end: spawns the real CLI launcher as a child process. No mocks.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = path.join(repoRoot, "packages", "cli", "bin", "creatorflow.js");
const exampleAnswers = path.join(repoRoot, "skills", "creatorflow", "assets", "answers.example.json");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [launcher, ...args],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const json = (r: Run) => JSON.parse(r.stdout) as Record<string, any>;

describe("creatorflow CLI (e2e, real process)", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  let home: string;
  beforeEach(async () => {
    tmp = await makeTempDir("cf-e2e-");
    home = path.join(tmp.dir, "home");
  });
  afterEach(() => tmp.cleanup());

  it("prints help and version; rejects unknown commands with exit 2", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    for (const c of ["init", "doctor", "profile", "skill"]) expect(help.stdout).toContain(c);
    expect((await cli(["--version"])).stdout.trim()).toBe("0.1.0");
    const bad = await cli(["publish"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown command");
  });

  it("1. initial setup: missing essentials -> exit 2 with field list; answers file -> files created", async () => {
    const missing = await cli(["-C", tmp.dir, "--json", "init", "--non-interactive"]);
    expect(missing.code).toBe(2);
    const err = json(missing);
    expect(err.ok).toBe(false);
    expect(err.error).toBe("INIT_MISSING_FIELDS");
    expect(err.details.map((d: { path: string }) => d.path)).toContain("schedule.timezone");

    const ok = await cli(["-C", tmp.dir, "--json", "init", "--non-interactive", "--answers", exampleAnswers]);
    expect(ok.code).toBe(0);
    const res = json(ok);
    expect(res.profile.status).toBe("created");
    const profile = JSON.parse(await fs.readFile(path.join(tmp.dir, "creator-profile.json"), "utf8"));
    expect(profile.creator.displayName).toBe("Example Dev Channel");
    expect(profile.languages).toEqual({ primary: "en", additional: ["hi"] });
    const config = JSON.parse(await fs.readFile(path.join(tmp.dir, "creatorflow.config.json"), "utf8"));
    expect(config.providers.publishing.id).toBe("package-only");

    const again = await cli(["-C", tmp.dir, "--json", "init", "--non-interactive"]);
    expect(json(again).profile.status).toBe("unchanged");
  });

  it("2. profile validation: valid -> 0, missing -> 3, invalid -> 1 with paths, secret -> 1 without echoing it", async () => {
    expect((await cli(["-C", tmp.dir, "profile", "validate"])).code).toBe(3);

    await cli(["-C", tmp.dir, "init", "--non-interactive", "--answers", exampleAnswers]);
    const valid = await cli(["-C", tmp.dir, "--json", "profile", "validate"]);
    expect(valid.code).toBe(0);
    expect(json(valid).ok).toBe(true);

    const pf = path.join(tmp.dir, "creator-profile.json");
    const p = JSON.parse(await fs.readFile(pf, "utf8"));
    p.platforms.primary = "myspace";
    await fs.writeFile(pf, JSON.stringify(p));
    const invalid = await cli(["-C", tmp.dir, "profile", "validate"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain("platforms.primary");

    const cf = path.join(tmp.dir, "creatorflow.config.json");
    const c = JSON.parse(await fs.readFile(cf, "utf8"));
    const secret = "sk-e2eSECRETabcdefghijklmnop";
    c.providers.llm.options = { apiKey: secret };
    await fs.writeFile(cf, JSON.stringify(c));
    const leaked = await cli(["-C", tmp.dir, "--json", "profile", "validate"]);
    expect(leaked.code).toBe(1);
    expect(leaked.stdout).toContain("providers.llm.options.apiKey");
    expect(leaked.stdout + leaked.stderr).not.toContain(secret);
  });

  it("doctor runs against the real machine and returns structured checks", async () => {
    await cli(["-C", tmp.dir, "init", "--non-interactive", "--answers", exampleAnswers]);
    const r = await cli(["-C", tmp.dir, "--json", "doctor"]);
    const report = json(r);
    expect(r.code).toBe(report.ok ? 0 : 1);
    const ids = report.checks.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["node", "npm", "ffmpeg", "ffprobe", "browser", "config", "profile", "workspace"]));
    expect(report.checks.find((c: { id: string }) => c.id === "node").status).toBe("pass");
    expect(report.checks.find((c: { id: string }) => c.id === "npm").status).toBe("pass");
    expect(report.checks.find((c: { id: string }) => c.id === "profile").status).toBe("pass");
  });

  it("skill validate and install into project and (temp) user scope", async () => {
    const v = await cli(["--json", "skill", "validate"]);
    expect(v.code).toBe(0);
    expect(json(v).name).toBe("creatorflow");

    const proj = await cli(["-C", tmp.dir, "--json", "skill", "install", "--agent", "claude-code"]);
    expect(proj.code).toBe(0);
    await expect(fs.stat(path.join(tmp.dir, ".claude", "skills", "creatorflow", "SKILL.md"))).resolves.toBeTruthy();

    const dup = await cli(["-C", tmp.dir, "--json", "skill", "install", "--agent", "claude-code"]);
    expect(dup.code).toBe(4);
    expect(json(dup).error).toBe("SKILL_ALREADY_INSTALLED");

    // os.homedir() honours USERPROFILE on Windows and HOME elsewhere; keep the real home untouched.
    const user = await cli(["--json", "skill", "install", "--agent", "kiro", "--scope", "user"], { HOME: home, USERPROFILE: home });
    expect(user.code).toBe(0);
    expect(json(user).target).toBe(path.join(home, ".kiro", "skills", "creatorflow"));

    const badAgent = await cli(["skill", "install", "--agent", "cursor"]);
    expect(badAgent.code).toBe(2);
  });
});

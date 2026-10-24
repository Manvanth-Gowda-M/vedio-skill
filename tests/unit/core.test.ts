import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeId,
  createLogger,
  CreatorFlowError,
  ExitCode,
  findSecretLikeValues,
  isWithin,
  memorySink,
  readJsonFile,
  redact,
  resolveWithin,
  runCommand,
  slugify,
  writeFileAtomic,
  writeJsonAtomic,
  envVarPresent,
} from "@creatorflow/core";
import { makeTempDir } from "../helpers.ts";

describe("path safety", () => {
  const root = path.resolve("/tmp/cf-root");

  it("resolves paths inside the root", () => {
    expect(resolveWithin(root, "a/b.json")).toBe(path.join(root, "a", "b.json"));
    expect(resolveWithin(root, ".")).toBe(root);
  });

  it.each(["../x", "a/../../x", path.resolve("/etc/passwd"), "..\\x"])("rejects traversal: %s", (p) => {
    expect(() => resolveWithin(root, p)).toThrow(CreatorFlowError);
    try {
      resolveWithin(root, p);
    } catch (e) {
      expect((e as CreatorFlowError).code).toBe("PATH_TRAVERSAL");
      expect((e as CreatorFlowError).exitCode).toBe(ExitCode.IO);
    }
  });

  it("rejects NUL bytes", () => {
    expect(() => resolveWithin(root, "a\0b")).toThrow(/NUL/);
  });

  it("does not treat sibling prefixes as inside", () => {
    expect(isWithin(root, path.resolve("/tmp/cf-root-evil/x"))).toBe(false);
  });

  it("validates and slugifies ids", () => {
    expect(assertSafeId("2026-w43-01-claude-code")).toBe("2026-w43-01-claude-code");
    for (const bad of ["", "A", "a--b", "-a", "a/b", "..", "x".repeat(81)]) {
      expect(() => assertSafeId(bad)).toThrow(CreatorFlowError);
    }
    expect(slugify("  Claude Code 2.0: What's New?! ")).toBe("claude-code-2-0-what-s-new");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("");
  });
});

describe("atomic fs", () => {
  let tmp: Awaited<ReturnType<typeof makeTempDir>>;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("writes, replaces and leaves no temp files", async () => {
    const file = path.join(tmp.dir, "nested", "state.json");
    await writeJsonAtomic(file, { v: 1 });
    await writeJsonAtomic(file, { v: 2 });
    expect(await readJsonFile(file)).toEqual({ v: 2 });
    expect(await fs.readdir(path.dirname(file))).toEqual(["state.json"]);
  });

  it("survives concurrent writers with a complete final file", async () => {
    const file = path.join(tmp.dir, "c.json");
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { i, pad: "x".repeat(5000) })));
    const v = (await readJsonFile(file)) as { i: number; pad: string };
    expect(v.pad).toHaveLength(5000);
    expect((await fs.readdir(tmp.dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reports missing and malformed JSON with codes", async () => {
    await expect(readJsonFile(path.join(tmp.dir, "nope.json"))).rejects.toMatchObject({ code: "FILE_NOT_FOUND", exitCode: ExitCode.CONFIG });
    const bad = path.join(tmp.dir, "bad.json");
    await writeFileAtomic(bad, "{ not json");
    await expect(readJsonFile(bad)).rejects.toMatchObject({ code: "JSON_INVALID" });
  });

  it("accepts a UTF-8 BOM (files saved by Windows editors)", async () => {
    const f = path.join(tmp.dir, "bom.json");
    await writeFileAtomic(f, "\uFEFF{\"a\":1}");
    expect(await readJsonFile(f)).toEqual({ a: 1 });
  });
});

describe("secrets", () => {
  it("flags secret-like keys and values without returning values", () => {
    const findings = findSecretLikeValues({
      providers: { tts: { apiKey: "anything", apiKeyEnv: "TTS_KEY", options: { note: "sk-abcdefghijklmnopqrstuvwx" } } },
      list: ["AKIAABCDEFGHIJKLMNOP"],
      token: "",
    });
    expect(findings).toEqual([
      { path: "providers.tts.apiKey", reason: "secret-like-key" },
      { path: "providers.tts.options.note", reason: "secret-like-value" },
      { path: "list[0]", reason: "secret-like-value" },
    ]);
    expect(JSON.stringify(findings)).not.toContain("sk-");
  });

  it("does not flag env-var references or ordinary text", () => {
    expect(findSecretLikeValues({ apiKeyEnv: "OPENAI_API_KEY", tokenEnv: "X_TOKEN", title: "Tokens explained" })).toEqual([]);
  });

  it("redacts known secrets and patterns", () => {
    const out = redact("key=sk-abcdefghijklmnopqrstuvwx and mysecretvalue", ["mysecretvalue"]);
    expect(out).toBe("key=[REDACTED] and [REDACTED]");
  });

  it("checks env presence only", () => {
    expect(envVarPresent("X", { X: "v" })).toBe(true);
    expect(envVarPresent("X", { X: "" })).toBe(false);
    expect(envVarPresent("Y", {})).toBe(false);
  });
});

describe("logger", () => {
  it("emits structured, level-filtered, redacted records", () => {
    const sink = memorySink();
    const log = createLogger({ level: "info", sinks: [sink], now: () => new Date("2026-01-01T00:00:00Z") }).child({ job: "j1" });
    log.debug("hidden");
    log.info("using sk-abcdefghijklmnopqrstuvwx", { header: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789", err: new Error("boom") });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      msg: "using [REDACTED]",
      job: "j1",
      header: "Bearer [REDACTED]",
      err: { name: "Error", message: "boom" },
    });
  });
});

describe("runCommand", () => {
  it("runs with argument arrays and never interprets shell syntax", async () => {
    const r = await runCommand(process.execPath, ["-e", "console.log(process.argv[1])", "a && echo pwned"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("a && echo pwned");
  });

  it("reports missing executables and non-zero exits", async () => {
    expect((await runCommand("definitely-not-a-real-binary-cf", [])).errorCode).toBe("ENOENT");
    expect((await runCommand(process.execPath, ["-e", "process.exit(3)"])).exitCode).toBe(3);
  });

  it("times out", async () => {
    const r = await runCommand(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 300 });
    expect(r.errorCode).toBe("TIMEOUT");
  });
});

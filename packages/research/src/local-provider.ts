import { promises as fs } from "node:fs";
import path from "node:path";
import { CreatorFlowError, findSecretLikeValues, fingerprint, readJsonFile, resolveWithin, sha256Hex } from "@creatorflow/core";
import { CandidateInputSchema, ClaimInputSchema, ResearchInputSchema, SourceInputSchema, zodIssues } from "@creatorflow/schemas";
import type { z } from "zod";
import { htmlToText } from "./text.ts";
import { unsupported, type ImportBundle, type ParsedSnapshot, type ProviderResult, type ResearchProvider } from "./provider.ts";

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const SNAPSHOT_TYPES: Record<string, ParsedSnapshot["mediaType"]> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/**
 * "manual-sources": imports research the user supplied as JSON bundles
 * (research-input.schema.json), optionally with locally saved HTML/text
 * snapshots. It never contacts the network and never fills in missing data.
 */
export class ManualSourcesProvider implements ResearchProvider {
  readonly id = "manual-sources";
  readonly version = "1";
  readonly capabilities = { importLocal: true, webSearch: false, fetchUrl: false, modelAssist: false };

  async search(): Promise<ProviderResult<ImportBundle>> {
    return unsupported(this.id, "webSearch", "it only imports files you supply; save sources locally and use --input");
  }

  async importLocal(request: { path: string }): Promise<ProviderResult<ImportBundle>> {
    const target = path.resolve(request.path);
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) return { ok: false, error: { code: "NOT_FOUND", message: `Research input not found: ${target}` } };
    let files: string[];
    if (stat.isDirectory()) {
      files = (await fs.readdir(target))
        .filter((f) => f.toLowerCase().endsWith(".json"))
        .sort()
        .map((f) => path.join(target, f));
      if (files.length === 0) return { ok: false, error: { code: "INVALID_INPUT", message: `No .json research files in ${target}` } };
    } else {
      files = [target];
    }
    const bundle: ImportBundle = { files: files.map((f) => path.basename(f)), inputHash: "", sources: [], claims: [], candidates: [], issues: [] };
    const hashes: string[] = [];
    for (const file of files) {
      const r = await this.parseFile(file, bundle, hashes);
      if (!r.ok) return r;
    }
    bundle.inputHash = fingerprint({ provider: this.id, version: this.version, files: hashes });
    return { ok: true, value: bundle };
  }

  private async parseFile(file: string, bundle: ImportBundle, hashes: string[]): Promise<ProviderResult<true>> {
    const name = path.basename(file);
    if ((await fs.stat(file)).size > MAX_INPUT_BYTES) {
      return { ok: false, error: { code: "INVALID_INPUT", message: `${name} is larger than ${MAX_INPUT_BYTES} bytes` } };
    }
    let raw: unknown;
    try {
      raw = await readJsonFile(file);
    } catch (error) {
      return { ok: false, error: { code: "INVALID_INPUT", message: error instanceof CreatorFlowError ? error.message : String(error) } };
    }
    const top = ResearchInputSchema.safeParse(raw);
    if (!top.success) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: `${name} is not a research input file (expected { sources, claims, candidates })`,
          issues: zodIssues(top.error).map((i) => ({ severity: "error", record: name, path: i.path, message: i.message })),
        },
      };
    }
    hashes.push(`sha256:${sha256Hex(await fs.readFile(file))}`);
    if (top.data.sessionTopic && !bundle.sessionTopic) bundle.sessionTopic = top.data.sessionTopic;
    const dir = path.dirname(file);

    const check = <S extends z.ZodType>(kind: string, i: number, item: unknown, schema: S): { label: string; value?: z.infer<S> } => {
      const key = (item as { key?: unknown } | null)?.key;
      const label = `${name}:${kind}[${i}]${typeof key === "string" ? `(${key})` : ""}`;
      const secrets = findSecretLikeValues(item);
      if (secrets.length) {
        for (const s of secrets) bundle.issues.push({ severity: "error", record: label, path: s.path, message: "Looks like a credential; remove it (secrets never belong in research files)" });
        return { label };
      }
      const parsed = schema.safeParse(item);
      if (!parsed.success) {
        for (const zi of zodIssues(parsed.error)) bundle.issues.push({ severity: "error", record: label, path: zi.path, message: zi.message });
        return { label };
      }
      return { label, value: parsed.data as z.infer<S> };
    };

    for (const [i, item] of top.data.sources.entries()) {
      const { label, value } = check("sources", i, item, SourceInputSchema);
      if (!value) continue;
      let snapshot: ParsedSnapshot | undefined;
      if (value.snapshot) {
        snapshot = await this.readSnapshot(dir, value.snapshot, (message) => bundle.issues.push({ severity: "error", record: label, path: "snapshot", message }));
        if (!snapshot) continue; // a declared snapshot that cannot be read rejects the source rather than silently dropping evidence checks
        hashes.push(snapshot.sha256);
      }
      bundle.sources.push({ input: value, importedFrom: name, ...(snapshot ? { snapshot } : {}) });
    }
    for (const [i, item] of top.data.claims.entries()) {
      const { value } = check("claims", i, item, ClaimInputSchema);
      if (value) bundle.claims.push(value);
    }
    for (const [i, item] of top.data.candidates.entries()) {
      const { value } = check("candidates", i, item, CandidateInputSchema);
      if (value) bundle.candidates.push(value);
    }
    return { ok: true, value: true };
  }

  private async readSnapshot(dir: string, rel: string, fail: (message: string) => void): Promise<ParsedSnapshot | undefined> {
    let abs: string;
    try {
      abs = resolveWithin(dir, rel);
    } catch (error) {
      fail(`${(error as Error).message} Snapshots must be inside the input file's directory.`);
      return undefined;
    }
    const ext = path.extname(abs).toLowerCase();
    const mediaType = SNAPSHOT_TYPES[ext];
    if (!mediaType) {
      fail(`Unsupported snapshot type "${ext}" (use .html, .htm, .txt or .md)`);
      return undefined;
    }
    const st = await fs.lstat(abs).catch(() => undefined);
    if (!st) {
      fail(`Snapshot file not found: ${rel}`);
      return undefined;
    }
    if (!st.isFile()) {
      fail(`Snapshot ${rel} is not a regular file (symbolic links are not followed)`);
      return undefined;
    }
    if (st.size > MAX_SNAPSHOT_BYTES) {
      fail(`Snapshot ${rel} is larger than ${MAX_SNAPSHOT_BYTES} bytes`);
      return undefined;
    }
    const bytes = await fs.readFile(abs);
    const decoded = bytes.toString("utf8").replace(/^\uFEFF/, "");
    return {
      originalName: path.basename(abs),
      mediaType,
      sha256: `sha256:${sha256Hex(bytes)}`,
      bytes: bytes.length,
      text: mediaType === "text/html" ? htmlToText(decoded) : decoded.replace(/\r\n/g, "\n"),
    };
  }
}

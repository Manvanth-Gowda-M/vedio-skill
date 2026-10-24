// Regenerates packages/schemas/json/*.schema.json from the Zod sources.
// Usage: npm run schemas:build   (tests fail if the committed files are stale)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyJson, writeFileAtomic } from "@creatorflow/core";
import { JSON_SCHEMA_EXPORTS, toJsonSchema } from "../src/index.ts";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "json");

for (const [file, schema] of Object.entries(JSON_SCHEMA_EXPORTS)) {
  await writeFileAtomic(path.join(outDir, file), stringifyJson(toJsonSchema(schema, file)));
  console.log(`wrote ${path.join("packages/schemas/json", file)}`);
}

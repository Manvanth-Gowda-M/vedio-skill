#!/usr/bin/env node
// Thin launcher: CreatorFlow sources are TypeScript executed via Node's
// built-in type stripping (Node >= 22.18), so no build step is required.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`CreatorFlow requires Node.js >= 22.18 (found ${process.versions.node}).\n`);
  process.exit(3);
}
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv);

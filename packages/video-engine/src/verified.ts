import path from "node:path";
import type { CreatorFlowConfig } from "@creatorflow/schemas";

export { readVerifiedOutput, verifiedBinaryOutput, type VerifiedFile, type VerifiedRead } from "@creatorflow/orchestrator";

/** Project directory (parent of the workspace) derived from the validated relative workspaceDir. */
export function projectDirOf(workspaceDir: string, config: CreatorFlowConfig): string {
  const depth = config.workspaceDir.split(/[\\/]/).filter((p) => p && p !== ".").length;
  return path.resolve(workspaceDir, ...Array.from({ length: depth }, () => ".."));
}

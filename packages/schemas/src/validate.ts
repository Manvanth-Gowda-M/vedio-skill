import { findSecretLikeValues } from "@creatorflow/core";
import { z } from "zod";
import { CreatorFlowConfigSchema, type CreatorFlowConfig } from "./config.ts";
import { CreatorProfileSchema, type CreatorProfile } from "./profile.ts";

export interface ValidationIssue {
  /** Dotted path into the document, "(root)" for top-level problems. */
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((seg, i) => (typeof seg === "number" ? `[${seg}]` : `${i === 0 ? "" : "."}${String(seg)}`))
    .join("");
}

export function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));
}

function secretIssues(data: unknown): ValidationIssue[] {
  return findSecretLikeValues(data).map((f) => ({
    path: f.path,
    message:
      f.reason === "secret-like-key"
        ? "Looks like a secret. Store it in an environment variable and reference it with apiKeyEnv"
        : "Value looks like a credential. Remove it and use an environment variable instead",
  }));
}

function validateWith<T>(schema: z.ZodType<T>, data: unknown): ValidationResult<T> {
  // Secret scan runs first and independently: a secret is an error even if the shape is otherwise valid.
  const secrets = secretIssues(data);
  const parsed = schema.safeParse(data);
  const issues = [...secrets, ...(parsed.success ? [] : zodIssues(parsed.error))];
  if (parsed.success && issues.length === 0) return { ok: true, value: parsed.data, issues: [] };
  return { ok: false, issues };
}

/** Schema validation plus secret scan, for any CreatorFlow artifact schema. */
export function validateArtifact<T>(schema: z.ZodType<T>, data: unknown): ValidationResult<T> {
  return validateWith(schema, data);
}

export function validateProfile(data: unknown): ValidationResult<CreatorProfile> {
  return validateWith(CreatorProfileSchema, data);
}

export function validateConfig(data: unknown): ValidationResult<CreatorFlowConfig> {
  return validateWith(CreatorFlowConfigSchema, data);
}

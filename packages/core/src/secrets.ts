/**
 * Heuristic secret detection and redaction. This is a safety net, not a
 * guarantee: configuration must reference secrets by environment-variable name.
 */

const SECRET_KEY_NAME = /(api[-_]?key|secret|token|password|passwd|bearer|private[-_]?key|credential)/i;

/** Keys that are allowed to *name* a secret without containing one. */
const SECRET_REFERENCE_KEY = /(env|envvar|env_var|apikeyenv|tokenenv|secretenv)$/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style / generic "sk-" keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

export interface SecretFinding {
  /** JSON-pointer-like path, e.g. "providers.tts.options.apiKey". */
  path: string;
  reason: "secret-like-key" | "secret-like-value";
}

/**
 * Walks a JSON value and reports fields that appear to contain secrets.
 * Values are never included in the findings.
 */
export function findSecretLikeValues(value: unknown, basePath = ""): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const visit = (node: unknown, p: string): void => {
    if (typeof node === "string") {
      if (looksLikeSecretValue(node)) findings.push({ path: p || "(root)", reason: "secret-like-value" });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${p}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const childPath = p ? `${p}.${key}` : key;
        if (
          SECRET_KEY_NAME.test(key) &&
          !SECRET_REFERENCE_KEY.test(key) &&
          typeof child === "string" &&
          child.length > 0
        ) {
          findings.push({ path: childPath, reason: "secret-like-key" });
          continue;
        }
        visit(child, childPath);
      }
    }
  };
  visit(value, basePath);
  return findings;
}

/** Replaces secret-looking substrings and values of known env secrets with a marker. */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  }
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[REDACTED]");
  }
  return out;
}

/** Presence check for an environment variable without ever returning its value. */
export function envVarPresent(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[name];
  return typeof v === "string" && v.length > 0;
}

import { createInterface } from "node:readline/promises";

/** Abstract question/answer channel so onboarding can be scripted in tests. */
export interface Prompter {
  ask(question: string, suggestion?: string): Promise<string>;
  /** Shows a validation message before re-asking. */
  warn(message: string): void;
  close(): void;
}

export function createTtyPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    async ask(question, suggestion) {
      const suffix = suggestion ? ` [${suggestion}]` : "";
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer || suggestion || "";
    },
    warn: (message) => process.stderr.write(`  ${message}\n`),
    close: () => rl.close(),
  };
}

/** Answers questions from a fixed list, in order. Throws if it runs out. */
export function createScriptedPrompter(answers: readonly string[]): Prompter & { asked: string[]; warnings: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const warnings: string[] = [];
  return {
    asked,
    warnings,
    async ask(question, suggestion) {
      asked.push(question);
      if (queue.length === 0) throw new Error(`Scripted prompter has no answer for: ${question}`);
      const a = queue.shift()!.trim();
      return a || suggestion || "";
    },
    warn: (message) => {
      warnings.push(message);
    },
    close: () => {},
  };
}

/** Output channel abstraction so commands are testable and --json is uniform. */
export interface Output {
  json: boolean;
  /** Human-readable line to stdout (suppressed in --json mode). */
  line(text?: string): void;
  /** Warning/diagnostic line to stderr (always shown). */
  warn(text: string): void;
  /** Final machine-readable result (only emitted in --json mode). */
  result(value: unknown): void;
}

export interface OutputStreams {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const processStreams: OutputStreams = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

export function createOutput(json: boolean, streams: OutputStreams = processStreams): Output {
  return {
    json,
    line: (text = "") => {
      if (!json) streams.stdout(`${text}\n`);
    },
    warn: (text) => streams.stderr(`${text}\n`),
    result: (value) => {
      if (json) streams.stdout(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

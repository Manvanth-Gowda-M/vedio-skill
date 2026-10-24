import { promises as fs } from "node:fs";
import path from "node:path";
import { redact } from "./secrets.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void | Promise<void>;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sinks?: LogSink[];
  base?: Record<string, unknown>;
  now?: () => Date;
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  // Round-trip through JSON so redaction covers nested strings uniformly.
  const json = JSON.stringify(fields, (_k, v: unknown) =>
    v instanceof Error ? { name: v.name, message: v.message } : v,
  );
  return JSON.parse(redact(json)) as Record<string, unknown>;
}

/** Structured JSON-lines logger with automatic secret redaction. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const sinks = options.sinks ?? [];
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record: LogRecord = {
      ts: now().toISOString(),
      level,
      msg: redact(msg),
      ...sanitizeFields({ ...base, ...fields }),
    };
    for (const sink of sinks) void sink(record);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** Sink appending JSON lines to a file (directory created on demand). */
export function fileSink(filePath: string): LogSink {
  let ready: Promise<void> | undefined;
  return async (record) => {
    ready ??= fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined);
    await ready;
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  };
}

/** Sink writing JSON lines to stderr, keeping stdout free for command output. */
export const stderrSink: LogSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/** In-memory sink for tests. */
export function memorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = ((record: LogRecord) => {
    records.push(record);
  }) as LogSink & { records: LogRecord[] };
  sink.records = records;
  return sink;
}

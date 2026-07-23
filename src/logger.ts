/**
 * Diagnostic logger (SPEC §14, D-11): a rotating, append-only JSONL log with
 * full stack traces, kept separate from conversation history so failures are
 * cheap to investigate. Synchronous file writes keep it simple for now; the
 * async single-writer AppendLog primitive (D-37) comes with persistence.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

export const LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LoggerOptions {
  /** Directory the log file lives in (created if missing). */
  readonly dir: string;
  /** Minimum level to record. Default: $JLCODE_LOG_LEVEL or "info". */
  readonly level?: LogLevel;
  /** File name within `dir`. Default: "diagnostic.log". */
  readonly fileName?: string;
  /** Rotate once the file would exceed this many bytes. Default: 5 MiB. */
  readonly maxBytes?: number;
  /** How many rotated backups to keep (>= 1). Default: 3. */
  readonly backups?: number;
  /** Also mirror error/warn to stderr. Default: true. */
  readonly mirror?: boolean;
}

export type Fields = Record<string, unknown>;

export interface Logger {
  error(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  debug(msg: string, fields?: Fields): void;
  readonly level: LogLevel;
  readonly file: string;
}

function parseLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  return value !== undefined && (LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : fallback;
}

/** Serialize a value, expanding Errors into {name, message, stack}. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? parseLevel(process.env.JLCODE_LOG_LEVEL, "info");
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const backups = Math.max(1, options.backups ?? 3);
  const mirror = options.mirror ?? true;
  const file = path.join(options.dir, options.fileName ?? "diagnostic.log");

  mkdirSync(options.dir, { recursive: true });

  function rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return; // no file yet
    }
    if (size === 0 || size + incomingBytes <= maxBytes) return;
    for (let i = backups - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      if (existsSync(src)) renameSync(src, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  }

  function write(entryLevel: LogLevel, msg: string, fields?: Fields): void {
    if (RANK[entryLevel] > RANK[level]) return;
    const record = { ts: new Date().toISOString(), level: entryLevel, msg, ...fields };
    const line = JSON.stringify(record, replacer) + "\n";
    rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(file, line);
    if (mirror && RANK[entryLevel] <= RANK.warn) {
      const extra = fields && Object.keys(fields).length > 0 ? " " + JSON.stringify(fields, replacer) : "";
      process.stderr.write(`[${record.ts}] ${entryLevel.toUpperCase()} ${msg}${extra}\n`);
    }
  }

  return {
    error: (msg, fields) => write("error", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    debug: (msg, fields) => write("debug", msg, fields),
    level,
    file,
  };
}

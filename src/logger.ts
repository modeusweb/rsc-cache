import type { Logger } from "./types.js";

const NOOP = (): void => {
  /* intentionally empty */
};

export const silentLogger: Logger = { debug: NOOP, warn: NOOP, error: NOOP };

const PREFIX = "[rsc-cache]";

export interface LoggerOptions {
  debug?: boolean;
  logger?: Logger;
  prefix?: string;
}

/**
 * Creates a logger.
 *
 * Debug logs are off unless `debug: true`. `warn`/`error` are always forwarded.
 * Values passed to the logger are redacted: long strings and objects are
 * summarized, so raw user input does not end up in logs.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const target = options.logger;
  const debugEnabled = options.debug === true;
  const prefix = options.prefix ?? PREFIX;

  if (!debugEnabled && !target) {
    return silentLogger;
  }

  return {
    debug(message, details) {
      if (!debugEnabled) {
        return;
      }
      const safe = redactDetails(details);
      if (target) {
        target.debug(message, safe);
        return;
      }
      console.debug(`${prefix} ${message}`, safe ?? "");
    },
    warn(message, details) {
      const safe = redactDetails(details);
      if (target) {
        target.warn(message, safe);
        return;
      }
      console.warn(`${prefix} ${message}`, safe ?? "");
    },
    error(message, details) {
      const safe = redactDetails(details);
      if (target) {
        target.error(message, safe);
        return;
      }
      console.error(`${prefix} ${message}`, safe ?? "");
    },
  };
}

function redactDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined) {
    return undefined;
  }
  return redact(details) as Record<string, unknown>;
}


const MAX_STRING = 64;

/**
 * Redacts a value for logging.
 *
 * Strings longer than 64 characters are truncated, objects are summarized,
 * functions are replaced by their name, and `undefined` is dropped. Errors are
 * kept as-is (they are needed for debugging).
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  switch (typeof value) {
    case "string":
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length})` : value;
    case "number":
    case "boolean":
    case "bigint":
      return value;
    case "function":
      return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
    case "symbol":
      return value.toString();
    default:
      break;
  }

  if (value instanceof Error) {
    return value;
  }
  if (value instanceof Date || value instanceof URL || value instanceof RegExp) {
    return value instanceof Date ? value.toISOString() : String(value);
  }
  if (depth >= 2) {
    return "[Object]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => redact(item, depth + 1));
  }
  if (value instanceof Uint8Array) {
    return `[Uint8Array ${value.length}]`;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 10);
  for (const [key, entryValue] of entries) {
    out[key] = redact(entryValue, depth + 1);
  }
  return out;
}

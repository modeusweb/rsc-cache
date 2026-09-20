import type { Duration } from "./types.js";
import { CacheConfigurationError } from "./errors.js";

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const UNIT_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/;
const FOREVER = new Set(["inf", "infinity", "never", "forever", "infinite"]);

/**
 * Parses a duration into milliseconds.
 *
 * - `undefined` / `null` → `undefined` (no expiry)
 * - numbers are milliseconds (`60_000`)
 * - strings support compound units: `"500ms"`, `"30s"`, `"5m"`, `"1h 30m"`, `"2d"`, `"1w"`
 * - `Infinity`, `"infinity"` and `"never"` → `Infinity`
 *
 * No external dependency is used on purpose: duration parsing is ~40 lines.
 */
export function parseDuration(
  value: Duration | null | undefined,
  name = "duration",
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new CacheConfigurationError(`Invalid ${name}: NaN`);
    }
    if (value < 0) {
      throw new CacheConfigurationError(`Invalid ${name}: ${value} (must be >= 0)`);
    }
    return value;
  }

  if (typeof value !== "string") {
    throw new CacheConfigurationError(
      `Invalid ${name}: expected a number of milliseconds or a duration string`,
    );
  }

  let input = value.trim().toLowerCase();
  if (input === "") {
    throw new CacheConfigurationError(`Invalid ${name}: empty string`);
  }

  if (FOREVER.has(input)) {
    return Infinity;
  }

  // Plain number string: milliseconds (documented).
  if (/^\d+(?:\.\d+)?$/.test(input)) {
    return Number(input);
  }

  let total = 0;
  while (input.length > 0) {
    const match = UNIT_PATTERN.exec(input);
    if (!match) {
      throw new CacheConfigurationError(
        `Invalid ${name}: "${value}" (expected formats like "500ms", "30s", "5m", "2h", "1d")`,
      );
    }
    const amount = Number(match[1]);
    const unit = match[2] as string;
    const factor = UNITS[unit];
    if (factor === undefined) {
      throw new CacheConfigurationError(`Invalid ${name}: unknown unit "${unit}"`);
    }
    total += amount * factor;
    input = input.slice(match[0].length).trim();
  }

  return total;
}

/** Same as {@link parseDuration} but throws when the value is missing. */
export function requireDuration(value: Duration, name: string): number {
  const parsed = parseDuration(value, name);
  if (parsed === undefined) {
    throw new CacheConfigurationError(`${name} is required`);
  }
  return parsed;
}

/** Formats milliseconds for logs: `300000` → `"5m"`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return "none";
  }
  if (!Number.isFinite(ms)) {
    return "inf";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms % 1000 === 0 && ms < 60_000) {
    return `${ms / 1000}s`;
  }
  return `${Math.round(ms / 1000)}s`;
}

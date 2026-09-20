import type { Clock } from "./types.js";

/** Production clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Wraps a custom time source (useful for tests and for runtimes with a virtual clock). */
export function createClock(now: () => number): Clock {
  return { now };
}

export interface FakeClock extends Clock {
  /** Initial timestamp. */
  readonly startedAt: number;
  /** Moves the clock forward. */
  advance(ms: number): number;
  /** Sets an absolute timestamp. */
  set(ms: number): number;
}

/**
 * Deterministic clock for tests: TTL, stale windows and expiry can be tested
 * without waiting for real time.
 */
export function createFakeClock(start = 0): FakeClock {
  let current = start;
  return {
    startedAt: start,
    now: () => current,
    advance(ms: number): number {
      current += ms;
      return current;
    },
    set(ms: number): number {
      current = ms;
      return current;
    },
  };
}

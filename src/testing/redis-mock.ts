/**
 * In-memory Redis client used by the test suite and available to users who want
 * to exercise their cache setup without a server.
 *
 * It implements the exact structural interface `createRedisStorage()` expects,
 * including `eval` — the shipped Lua scripts run through their TypeScript
 * simulators, so the *same* command sequences are exercised — and
 * `scanIterator`.
 *
 * Keys expire against an injectable clock, so TTL behaviour can be tested
 * without waiting.
 */

import { REDIS_SCRIPTS, type ScriptContext } from "../redis-scripts.js";
import type { RedisClientLike, RedisSetArguments } from "../redis.js";

interface StoredValue {
  value: string | Uint8Array;
  expiresAt: number;
}

export interface FakeRedisOptions {
  /** Provide `eval` so the adapter takes its atomic code path. Default `true`. */
  withEval?: boolean;
  /** Provide `scanIterator`. Default `true`. */
  withScan?: boolean;
  /** Initial clock value in milliseconds. */
  startTime?: number;
}

export interface FakeRedisClient extends RedisClientLike {
  readonly store: Map<string, StoredValue>;
  readonly sets: Map<string, Set<string>>;
  /** Number of commands issued (useful to assert round-trip counts). */
  readonly commands: number;
  keys(): string[];
  setMembers(key: string): string[];
  advanceTime(ms: number): void;
  reset(): void;
}

const normalise = (source: string): string => source.replace(/\s+/g, " ").trim();

export function createFakeRedisClient(options: FakeRedisOptions = {}): FakeRedisClient {
  const store = new Map<string, StoredValue>();
  const sets = new Map<string, Set<string>>();
  let currentTime = options.startTime ?? Date.now();
  let commands = 0;

  const now = (): number => currentTime;

  const purge = (key: string): void => {
    const entry = store.get(key);
    if (entry && entry.expiresAt <= now()) {
      store.delete(key);
    }
  };

  const context: ScriptContext = {
    get: (key) => {
      purge(key);
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      return typeof entry.value === "string" ? entry.value : new TextDecoder().decode(entry.value);
    },
    set: (key, value) => {
      store.set(key, { value, expiresAt: Number.POSITIVE_INFINITY });
    },
    del: (...keys) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) {
          removed += 1;
        }
        if (sets.delete(key)) {
          removed += 1;
        }
      }
      return removed;
    },
    sadd: (key, ...members) => {
      let set = sets.get(key);
      if (!set) {
        set = new Set();
        sets.set(key, set);
      }
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          added += 1;
        }
      }
      return added;
    },
    srem: (key, ...members) => {
      const set = sets.get(key);
      if (!set) {
        return 0;
      }
      let removed = 0;
      for (const member of members) {
        if (set.delete(member)) {
          removed += 1;
        }
      }
      return removed;
    },
    smembers: (key) => [...(sets.get(key) ?? [])],
    pexpire: (key, ms) => {
      const entry = store.get(key);
      if (!entry) {
        return 0;
      }
      entry.expiresAt = now() + ms;
      return 1;
    },
  };

  const client: FakeRedisClient = {
    get store() {
      return store;
    },
    get sets() {
      return sets;
    },
    get commands() {
      return commands;
    },

    keys(): string[] {
      return [...store.keys()].filter((key) => {
        purge(key);
        return store.has(key);
      });
    },

    setMembers(key: string): string[] {
      return context.smembers(key);
    },

    advanceTime(ms: number): void {
      currentTime += ms;
    },

    reset(): void {
      store.clear();
      sets.clear();
      commands = 0;
    },

    async get(key: string): Promise<string | Uint8Array | null> {
      commands += 1;
      purge(key);
      return store.get(key)?.value ?? null;
    },

    async set(
      key: string,
      value: string | Uint8Array,
      setOptions?: RedisSetArguments,
    ): Promise<unknown> {
      commands += 1;
      purge(key);
      if (setOptions?.NX && store.has(key)) {
        return null;
      }
      if (setOptions?.XX && !store.has(key)) {
        return null;
      }
      const ttl =
        setOptions?.PX ?? (setOptions?.EX === undefined ? undefined : setOptions.EX * 1000);
      store.set(key, {
        value,
        expiresAt: ttl === undefined ? Number.POSITIVE_INFINITY : now() + ttl,
      });
      return "OK";
    },

    async del(keys: string | string[]): Promise<unknown> {
      commands += 1;
      const list = Array.isArray(keys) ? keys : [keys];
      return context.del(...list);
    },

    async exists(keys: string | string[]): Promise<number> {
      commands += 1;
      const list = Array.isArray(keys) ? keys : [keys];
      let count = 0;
      for (const key of list) {
        purge(key);
        if (store.has(key)) {
          count += 1;
        }
      }
      return count;
    },

    async sadd(key: string, members: string | string[]): Promise<unknown> {
      commands += 1;
      const list = Array.isArray(members) ? members : [members];
      return context.sadd(key, ...list);
    },

    async srem(key: string, members: string | string[]): Promise<unknown> {
      commands += 1;
      const list = Array.isArray(members) ? members : [members];
      return context.srem(key, ...list);
    },

    async smembers(key: string): Promise<string[]> {
      commands += 1;
      return context.smembers(key);
    },

    async pexpire(key: string, milliseconds: number): Promise<unknown> {
      commands += 1;
      return context.pexpire(key, milliseconds);
    },
  };

  if (options.withEval !== false) {
    client.eval = async (
      script: string,
      scriptOptions: { keys: string[]; arguments: string[] },
    ): Promise<unknown> => {
      commands += 1;
      const target = REDIS_SCRIPTS.find(
        (candidate) => normalise(candidate.source) === normalise(script),
      );
      if (!target) {
        throw new Error("FakeRedisClient: unknown script (did the adapter ship a new Lua script?)");
      }
      return target.simulate(context, scriptOptions.keys, scriptOptions.arguments);
    };
  }

  if (options.withScan !== false) {
    client.scanIterator = async function* scanIterator(scanOptions?: {
      MATCH?: string;
      COUNT?: number;
    }): AsyncIterable<string> {
      const pattern = scanOptions?.MATCH ?? "*";
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      for (const key of [...store.keys()]) {
        purge(key);
        if (store.has(key) && key.startsWith(prefix)) {
          yield key;
        }
      }
    };
  }

  return client;
}

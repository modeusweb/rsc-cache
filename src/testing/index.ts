/**
 * `rsc-cache/testing` — test utilities.
 *
 * - `createTestCache()` — a cache with a fake clock, so TTL/SWR can be tested by
 *   advancing time instead of sleeping.
 * - `createMockStorage()` — a storage with counters, failure injection and an
 *   optional shared backend, so "several processes sharing one storage" can be
 *   simulated inside one test.
 * - `createFakeRedisClient()` — see `./redis-mock.ts`.
 * - assertions for entry state.
 */

import { createCache } from "../create-cache.js";
import { createFakeClock, type FakeClock } from "../clock.js";
import { getFreshness, entrySize, type Freshness } from "../entry.js";
import { memoryStorage, type MemoryStorage, type MemoryStorageOptions } from "../memory.js";
import type {
  AnyFunction,
  CacheEntry,
  CacheInstance,
  CacheStorage,
  CachedFunction,
  CreateCacheOptions,
  LockOptions,
  ObservableStorage,
  StorageClearOptions,
  StorageEvent,
  StorageSetOptions,
} from "../types.js";

export { createFakeRedisClient } from "./redis-mock.js";
export type { FakeRedisClient, FakeRedisOptions } from "./redis-mock.js";
export { createRecordingTracer } from "../opentelemetry.js";
export { createClock, createFakeClock, systemClock } from "../clock.js";
export type { FakeClock } from "../clock.js";
export { memoryStorage } from "../memory.js";
export type { MemoryStorage, MemoryStorageOptions } from "../memory.js";
export { createCacheContext, createRequestCache, withCacheContext } from "../context.js";

/** Alias for {@link memoryStorage}, spelled the way the docs mention it. */
export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  return memoryStorage(options);
}

/* -------------------------------------------------------------------------- */
/* Test cache                                                                 */
/* -------------------------------------------------------------------------- */

export interface TestCacheOptions extends Omit<CreateCacheOptions, "clock" | "storage"> {
  storage?: CacheStorage;
  memory?: MemoryStorageOptions;
  startTime?: number;
}

export interface TestCacheResult {
  cache: CacheInstance;
  clock: FakeClock;
  storage: CacheStorage;
  /** Moves the fake clock forward and lets the storage sweep expired entries. */
  advanceTime(ms: number): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Creates a cache backed by a fake clock.
 *
 * ```ts
 * const { cache, advanceTime } = createTestCache();
 * const getProduct = cache.cache(async (id: string) => db(id), { ttl: "5m" });
 * await getProduct("1");        // miss
 * await getProduct("1");        // hit
 * await advanceTime(6 * 60_000);
 * await getProduct("1");        // expired -> miss again
 * ```
 */
export function createTestCache(options: TestCacheOptions = {}): TestCacheResult {
  const clock = createFakeClock(options.startTime ?? Date.now());
  const { memory, storage: providedStorage, startTime, ...cacheOptions } = options;
  void startTime;

  const storage =
    providedStorage ??
    memoryStorage({
      clock,
      ...memory,
    });

  // Keep a mock backend on the same timeline as the cache under test.
  if (typeof (storage as Partial<MockStorage>).setClock === "function") {
    (storage as MockStorage).setClock(clock);
  }

  const cache = createCache({
    ...cacheOptions,
    clock,
    storage,
    register: options.register ?? false,
  });

  return {
    cache,
    clock,
    storage,
    async advanceTime(ms: number): Promise<void> {
      clock.advance(ms);
      // Touch the storage so its lazy sweep runs against the new time.
      await storage.has("__rsc_cache_sweep_probe__");
    },
    async dispose(): Promise<void> {
      await cache.dispose();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mock storage                                                               */
/* -------------------------------------------------------------------------- */

export interface MockStorageBackend {
  entries: Map<string, CacheEntry>;
  tags: Map<string, Set<string>>;
  locks: Map<string, { token: string; expiresAt: number }>;
}

export interface MockStorageOptions {
  name?: string;
  /** Share entries/tags/locks between several mock storages (multi-process tests). */
  backend?: MockStorageBackend;
  /** Simulated latency for every operation, in milliseconds. */
  latencyMs?: number;
  /** Throw on reads (fail-open / fail-closed tests). */
  failReads?: boolean;
  /** Throw on writes. */
  failWrites?: boolean;
  /** Provide native tags. Default `true`. */
  nativeTags?: boolean;
  /** Provide compare-and-set. Default `true`. */
  cas?: boolean;
  /** Provide locks. Default `true`. */
  locks?: boolean;
  clock?: { now(): number };
}

export interface MockStorageCounters {
  get: number;
  set: number;
  delete: number;
  tagInvalidations: number;
}

export interface MockStorage extends CacheStorage, ObservableStorage {
  readonly name: string;
  readonly counters: MockStorageCounters;
  /** Toggle failures at runtime. */
  readonly failing: { reads: boolean; writes: boolean };
  resetCounters(): void;
  entries(): Map<string, CacheEntry>;
  /**
   * Replaces the clock used for retention (expiry) decisions.
   *
   * `createTestCache()` calls this automatically so a mock backend expires
   * entries on the same timeline as the cache under test.
   */
  setClock(clock: { now(): number }): void;
}

export function createMockBackend(): MockStorageBackend {
  return { entries: new Map(), tags: new Map(), locks: new Map() };
}

/**
 * Storage double with counters and failure injection.
 *
 * Two mock storages sharing one backend behave like two processes sharing a
 * distributed cache — that is how cross-process single-flight and locking are
 * tested.
 */
export function createMockStorage(options: MockStorageOptions = {}): MockStorage {
  const backend = options.backend ?? createMockBackend();
  const name = options.name ?? "mock";
  const nativeTags = options.nativeTags !== false;
  const cas = options.cas !== false;
  const locks = options.locks !== false;
  let clock = options.clock ?? { now: () => Date.now() };
  const listeners = new Set<(event: StorageEvent) => void>();

  const counters: MockStorageCounters = { get: 0, set: 0, delete: 0, tagInvalidations: 0 };
  const failing = { reads: options.failReads === true, writes: options.failWrites === true };

  const delay = async (): Promise<void> => {
    if (options.latencyMs && options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }
  };

  const storage: MockStorage = {
    name,

    get counters(): MockStorageCounters {
      return counters;
    },

    get failing() {
      return failing;
    },

    resetCounters(): void {
      counters.get = 0;
      counters.set = 0;
      counters.delete = 0;
      counters.tagInvalidations = 0;
    },

    entries(): Map<string, CacheEntry> {
      return backend.entries;
    },

    setClock(next: { now(): number }): void {
      clock = next;
    },

    observe(listener: (event: StorageEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async get(key: string): Promise<CacheEntry | null> {
      counters.get += 1;
      await delay();
      if (failing.reads) {
        throw new Error("mock storage: read failure");
      }
      const entry = backend.entries.get(key);
      if (!entry) {
        return null;
      }
      const deadline = entry.staleUntil ?? entry.expiresAt;
      if (deadline !== Infinity && clock.now() >= deadline) {
        backend.entries.delete(key);
        for (const listener of listeners) {
          listener({ type: "expiration", key, reason: "expired" });
        }
        return null;
      }
      return entry;
    },

    async has(key: string): Promise<boolean> {
      return (await storage.get(key)) !== null;
    },

    async set(key: string, entry: CacheEntry, setOptions?: StorageSetOptions): Promise<void> {
      counters.set += 1;
      await delay();
      if (failing.writes) {
        throw new Error("mock storage: write failure");
      }
      backend.entries.set(key, entry);
      if (nativeTags && entry.tags) {
        for (const tag of entry.tags) {
          let set = backend.tags.get(tag);
          if (!set) {
            set = new Set();
            backend.tags.set(tag, set);
          }
          set.add(key);
        }
      }
      void entrySize(entry);
      void setOptions;
    },

    async delete(key: string): Promise<void> {
      counters.delete += 1;
      await delay();
      backend.entries.delete(key);
      for (const set of backend.tags.values()) {
        set.delete(key);
      }
    },

    async clear(clearOptions?: StorageClearOptions): Promise<void> {
      const prefix = clearOptions?.prefix;
      for (const key of [...backend.entries.keys()]) {
        if (prefix === undefined || key.startsWith(prefix)) {
          backend.entries.delete(key);
          for (const set of backend.tags.values()) {
            set.delete(key);
          }
        }
      }
    },
  };

  if (cas) {
    storage.compareAndSet = async (
      key: string,
      entry: CacheEntry,
      expectedRevision: number | null,
      setOptions?: StorageSetOptions,
    ): Promise<boolean> => {
      const current = await storage.get(key);
      if ((current?.revision ?? null) !== expectedRevision) {
        return false;
      }
      await storage.set(key, entry, setOptions);
      return true;
    };
  }

  if (nativeTags) {
    storage.addTags = async (key: string, tags: readonly string[]): Promise<void> => {
      for (const tag of tags) {
        let set = backend.tags.get(tag);
        if (!set) {
          set = new Set();
          backend.tags.set(tag, set);
        }
        set.add(key);
      }
    };

    storage.invalidateTag = async (tag: string): Promise<void> => {
      counters.tagInvalidations += 1;
      const set = backend.tags.get(tag);
      if (!set) {
        return;
      }
      for (const key of [...set]) {
        backend.entries.delete(key);
      }
      backend.tags.delete(tag);
    };
  }

  if (locks) {
    storage.acquireLock = async (key: string, lockOptions: LockOptions) => {
      const existing = backend.locks.get(key);
      if (existing && clock.now() < existing.expiresAt) {
        return null;
      }
      const token = lockOptions.token ?? `token-${Math.random().toString(36).slice(2)}`;
      backend.locks.set(key, { token, expiresAt: clock.now() + lockOptions.ttlMs });
      return {
        key,
        token,
        release: async (): Promise<void> => {
          const current = backend.locks.get(key);
          if (current?.token === token) {
            backend.locks.delete(key);
          }
        },
      };
    };
  }

  return storage;
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

export type ExpectedState = Freshness | "missing";

export interface EntryInfo {
  exists: boolean;
  state: ExpectedState;
  revision?: number;
  tags?: readonly string[];
  size?: number;
}

/** Reads the raw state of the entry produced by a cached function call. */
export async function getEntryInfo<F extends AnyFunction>(
  cachedFn: CachedFunction<F>,
  ...args: Parameters<F>
): Promise<EntryInfo> {
  const key = cachedFn.key(...args);
  const entry = await cachedFn.instance.storage.get(key);
  if (!entry) {
    return { exists: false, state: "missing" };
  }
  const info: EntryInfo = {
    exists: true,
    state: getFreshness(entry, cachedFn.instance.clock.now()),
    revision: entry.revision,
    size: entrySize(entry),
  };
  if (entry.tags) {
    info.tags = entry.tags;
  }
  return info;
}

/** Throws when the entry for the given call is not in the expected state. */
export async function assertCacheState<F extends AnyFunction>(
  cachedFn: CachedFunction<F>,
  args: Parameters<F>,
  expected: ExpectedState,
): Promise<void> {
  const info = await getEntryInfo(cachedFn, ...args);
  if (info.state !== expected) {
    throw new Error(
      `Expected cache state "${expected}" for ${cachedFn.name}(${args
        .map((arg) => JSON.stringify(arg))
        .join(", ")}), got "${info.state}"`,
    );
  }
}

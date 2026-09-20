/**
 * Process-local memory storage.
 *
 * - **LRU eviction** with entry-count and byte budgets.
 * - **Native TTL, tags and CAS**, so a single process gets strong guarantees
 *   without any external dependency (this is the default backend, and it is
 *   what makes `cache(fn, { ttl: "5m" })` work out of the box).
 * - **Injectable clock**, so tests can advance time instead of sleeping.
 * - **Bounded memory**: expired entries are swept lazily (default) and no
 *   timer is created unless `cleanup: "interval"` is requested — serverless
 *   runtimes must not keep the process alive.
 *
 * Not a distributed cache: each process has its own state. Use Redis/KV when
 * several processes or instances must share entries.
 */

import type {
  CacheEntry,
  CacheLock,
  CacheStorage,
  Clock,
  LockOptions,
  ObservableStorage,
  StorageClearOptions,
  StorageEvent,
  StorageSetOptions,
  StorageTagScope,
} from "./types.js";
import { entrySize } from "./entry.js";
import { systemClock } from "./clock.js";
import { randomToken } from "./random.js";
import { DEFAULT_MAX_KEYS_PER_TAG } from "./tag-index.js";

export const DEFAULT_MAX_ENTRIES = 1_000;
export const DEFAULT_MAX_SIZE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export interface MemoryStorageOptions {
  /** Backend name used in events (default `"memory"`). */
  name?: string;
  /** Maximum number of entries before LRU eviction. Default 1000. */
  maxEntries?: number;
  /** Maximum approximated payload bytes before LRU eviction. Default 32 MiB. */
  maxSizeBytes?: number;
  clock?: Clock;
  /**
   * `"lazy"` (default) sweeps expired entries on access,
   * `"interval"` also schedules a timer (keep-alive servers),
   * `"none"` disables sweeping entirely (expired entries behave as misses).
   */
  cleanup?: "lazy" | "interval" | "none";
  cleanupIntervalMs?: number;
  /** Refresh LRU position on read. Default `true`. */
  updateAgeOnGet?: boolean;
  /** Maximum number of entry keys remembered per tag. Default 5000. */
  tagIndexLimit?: number;
}

export interface MemoryStorageStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  locks: number;
}

export interface MemoryStorage extends CacheStorage, ObservableStorage {
  readonly name: string;
  /** Current number of retained entries. */
  readonly size: number;
  /** Approximated retained bytes. */
  readonly bytes: number;
  /** Keys currently retained (debug/tests only). */
  keys(): string[];
  stats(): MemoryStorageStats;
  resetStats(): void;
  /** Stops timers and drops listeners/entries. */
  close(): Promise<void>;
}

interface StoredRecord {
  entry: CacheEntry;
  size: number;
  tags: string[];
}

interface StoredLock {
  token: string;
  expiresAt: number;
}

export function memoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const name = options.name ?? "memory";
  const clock = options.clock ?? systemClock;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const cleanup = options.cleanup ?? "lazy";
  const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  const updateAgeOnGet = options.updateAgeOnGet ?? true;
  const tagIndexLimit = options.tagIndexLimit ?? DEFAULT_MAX_KEYS_PER_TAG;

  const records = new Map<string, StoredRecord>();
  const tagIndex = new Map<string, Set<string>>();
  const locks = new Map<string, StoredLock>();
  const listeners = new Set<(event: StorageEvent) => void>();

  const counters = { hits: 0, misses: 0, evictions: 0, expirations: 0 };

  let bytes = 0;
  let lastSweep = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const emit = (event: StorageEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must never surface inside a cache operation.
      }
    }
  };

  const retentionDeadline = (entry: CacheEntry): number =>
    entry.staleUntil === undefined ? entry.expiresAt : Math.max(entry.expiresAt, entry.staleUntil);

  const unregisterTags = (key: string, tags: readonly string[]): void => {
    for (const tag of tags) {
      const set = tagIndex.get(tag);
      if (!set) {
        continue;
      }
      set.delete(key);
      if (set.size === 0) {
        tagIndex.delete(tag);
      }
    }
  };

  const remove = (key: string, reason: "evicted" | "expired" | "deleted" | "invalidated"): void => {
    const record = records.get(key);
    if (!record) {
      return;
    }
    records.delete(key);
    bytes -= record.size;
    unregisterTags(key, record.tags);
    if (reason === "evicted") {
      counters.evictions += 1;
      emit({ type: "eviction", key, reason: "capacity" });
    } else if (reason === "expired") {
      counters.expirations += 1;
      emit({ type: "expiration", key, reason: "expired" });
    }
  };

  /** Reads a retained record, removing it when its retention window is over. */
  const read = (key: string): StoredRecord | null => {
    const record = records.get(key);
    if (!record) {
      return null;
    }
    if (clock.now() >= retentionDeadline(record.entry)) {
      remove(key, "expired");
      return null;
    }
    return record;
  };

  const sweep = (): void => {
    const now = clock.now();
    lastSweep = now;
    for (const key of [...records.keys()]) {
      const record = records.get(key);
      if (record && now >= retentionDeadline(record.entry)) {
        remove(key, "expired");
      }
    }
    for (const [key, lock] of [...locks.entries()]) {
      if (now >= lock.expiresAt) {
        locks.delete(key);
      }
    }
  };

  const maybeSweep = (): void => {
    if (cleanup === "none") {
      return;
    }
    const now = clock.now();
    if (now - lastSweep >= cleanupIntervalMs) {
      sweep();
    }
  };

  const enforceBudgets = (): void => {
    if (records.size <= maxEntries && bytes <= maxSizeBytes) {
      return;
    }
    // Map iteration order is insertion order: the oldest/LRU entry comes first.
    for (const key of [...records.keys()]) {
      if (records.size <= maxEntries && bytes <= maxSizeBytes) {
        break;
      }
      remove(key, "evicted");
    }
  };

  const write = (key: string, entry: CacheEntry): void => {
    const existing = records.get(key);
    if (existing) {
      bytes -= existing.size;
      records.delete(key);
      unregisterTags(key, existing.tags);
    }
    const size = entrySize(entry);
    records.set(key, { entry, size, tags: entry.tags ? [...entry.tags] : [] });
    bytes += size;

    if (entry.tags) {
      for (const tag of entry.tags) {
        let set = tagIndex.get(tag);
        if (!set) {
          set = new Set();
          tagIndex.set(tag, set);
        }
        set.add(key);
        while (set.size > tagIndexLimit) {
          const oldest = set.values().next().value;
          if (oldest === undefined) {
            break;
          }
          set.delete(oldest);
        }
      }
    }

    enforceBudgets();
  };

  if (cleanup === "interval") {
    timer = setInterval(() => sweep(), cleanupIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  const storage: MemoryStorage = {
    name,

    get size(): number {
      return records.size;
    },

    get bytes(): number {
      return bytes;
    },

    keys(): string[] {
      return [...records.keys()];
    },

    stats(): MemoryStorageStats {
      return { ...counters, entries: records.size, bytes, locks: locks.size };
    },

    resetStats(): void {
      counters.hits = 0;
      counters.misses = 0;
      counters.evictions = 0;
      counters.expirations = 0;
    },

    observe(listener: (event: StorageEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async get(key: string): Promise<CacheEntry | null> {
      maybeSweep();
      const record = read(key);
      if (!record) {
        counters.misses += 1;
        return null;
      }
      counters.hits += 1;
      if (updateAgeOnGet) {
        // Refresh LRU position (Map preserves insertion order).
        records.delete(key);
        records.set(key, record);
      }
      return record.entry;
    },

    async has(key: string): Promise<boolean> {
      return read(key) !== null;
    },

    async set(key: string, entry: CacheEntry, setOptions?: StorageSetOptions): Promise<void> {
      maybeSweep();
      if (setOptions?.onlyIfNewer) {
        const existing = read(key);
        if (existing && existing.entry.revision >= entry.revision) {
          return;
        }
      }
      write(key, entry);
    },

    async compareAndSet(
      key: string,
      entry: CacheEntry,
      expectedRevision: number | null,
      setOptions?: StorageSetOptions,
    ): Promise<boolean> {
      maybeSweep();
      void setOptions;
      const existing = read(key);
      const currentRevision = existing?.entry.revision ?? null;
      if (currentRevision !== expectedRevision) {
        return false;
      }
      write(key, entry);
      return true;
    },

    async delete(key: string): Promise<void> {
      remove(key, "deleted");
    },

    async deleteMany(keys: readonly string[]): Promise<void> {
      for (const key of keys) {
        remove(key, "deleted");
      }
    },

    async clear(clearOptions?: StorageClearOptions): Promise<void> {
      const prefix = clearOptions?.prefix;
      let count = 0;
      for (const key of [...records.keys()]) {
        if (prefix === undefined || key.startsWith(prefix)) {
          remove(key, "deleted");
          count += 1;
        }
      }
      if (prefix === undefined) {
        tagIndex.clear();
        locks.clear();
      }
      emit({ type: "clear", count });
    },

    async addTags(key: string, tags: readonly string[], _scope?: StorageTagScope): Promise<void> {
      const record = records.get(key);
      if (!record) {
        return;
      }
      for (const tag of tags) {
        let set = tagIndex.get(tag);
        if (!set) {
          set = new Set();
          tagIndex.set(tag, set);
        }
        set.add(key);
      }
      record.tags = [...new Set([...record.tags, ...tags])];
    },

    async invalidateTag(tag: string): Promise<void> {
      const set = tagIndex.get(tag);
      if (!set) {
        return;
      }
      for (const key of [...set]) {
        remove(key, "invalidated");
      }
      tagIndex.delete(tag);
    },

    async acquireLock(key: string, lockOptions: LockOptions): Promise<CacheLock | null> {
      const now = clock.now();
      const existing = locks.get(key);
      if (existing && now < existing.expiresAt) {
        return null;
      }
      const token = lockOptions.token ?? randomToken();
      locks.set(key, { token, expiresAt: now + lockOptions.ttlMs });

      return {
        key,
        token,
        release: async (): Promise<void> => {
          const current = locks.get(key);
          if (current?.token === token) {
            locks.delete(key);
          }
        },
        extend: async (ttlMs: number): Promise<boolean> => {
          const current = locks.get(key);
          if (current?.token !== token) {
            return false;
          }
          current.expiresAt = clock.now() + ttlMs;
          return true;
        },
      };
    },

    async close(): Promise<void> {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      listeners.clear();
      records.clear();
      tagIndex.clear();
      locks.clear();
      bytes = 0;
    },
  };

  return storage;
}

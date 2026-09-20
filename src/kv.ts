/**
 * `rsc-cache/kv` — generic key/value storage.
 *
 * Fits Cloudflare Workers KV, Deno KV, Upstash KV (REST), DynamoDB, an
 * S3-like store, a database table, a filesystem directory — anything that can
 * store one string under one key.
 *
 * Because such backends typically have neither tags nor atomic
 * compare-and-set, the core falls back to:
 * - its own tag index entries (see `src/tag-index.ts`),
 * - read-compare-write for stale-overwrite protection,
 * - best-effort locks.
 *
 * Those trade-offs are documented in SECURITY.md and README.
 */

import {
  decodeEntry,
  encodeEntry,
  entryFromString,
  entryToString,
  isEntryString,
} from "./codec.js";
import { hashValue } from "./hash.js";
import { randomToken } from "./random.js";
import type {
  CacheEntry,
  CacheLock,
  CacheStorage,
  LockOptions,
  StorageClearOptions,
  StorageSetOptions,
} from "./types.js";

export interface KvSetOptions {
  /** Relative TTL in seconds (Workers KV, Upstash KV). */
  expirationTtl?: number;
  /** Relative TTL in milliseconds (Deno KV style). */
  ttlMs?: number;
}

export interface KvListPage<T = string> {
  keys: T[];
  cursor?: string;
  list_complete?: boolean;
  listComplete?: boolean;
}

/** Minimal KV contract. */
export interface KvClientLike {
  get(key: string): Promise<string | Uint8Array | null | undefined>;
  set(key: string, value: string | Uint8Array, options?: KvSetOptions): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list?(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<KvListPage<string | { name: string }>>;
}

export interface KvStorageOptions {
  client: KvClientLike;
  name?: string;
  /** Prefix for adapter-internal keys. Default `"rsc-cache"`. */
  prefix?: string;
  valueEncoding?: "base64" | "binary";
  batchSize?: number;
}

export interface KvStorage extends CacheStorage {
  /** Number of keys deleted by the last `clear()`. */
  readonly lastClearCount: number;
}

function tryParseLock(value: string): { token: string; expiresAt: number } | null {
  try {
    const parsed = JSON.parse(value) as { token?: unknown; expiresAt?: unknown };
    if (typeof parsed.token === "string" && typeof parsed.expiresAt === "number") {
      return { token: parsed.token, expiresAt: parsed.expiresAt };
    }
  } catch {
    // Not a lock value.
  }
  return null;
}

export function createKvStorage(options: KvStorageOptions): KvStorage {
  const client = options.client;
  const name = options.name ?? "kv";
  const prefix = options.prefix ?? "rsc-cache";
  const valueEncoding = options.valueEncoding ?? "base64";
  const batchSize = options.batchSize ?? 500;
  const lockPrefix = `${prefix}:~lock~:`;

  let lastClearCount = 0;

  async function encode(entry: CacheEntry): Promise<string | Uint8Array> {
    return valueEncoding === "binary" ? encodeEntry(entry) : entryToString(entry);
  }

  async function decode(raw: string | Uint8Array | null | undefined): Promise<CacheEntry | null> {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (raw instanceof Uint8Array) {
      return decodeEntry(raw);
    }
    return isEntryString(raw) ? entryFromString(raw) : null;
  }

  async function listKeys(keyPrefix: string): Promise<string[]> {
    if (typeof client.list !== "function") {
      throw new Error(
        "This KV client cannot list keys (`list()` is missing), so `clear()` cannot be implemented.",
      );
    }
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await client.list({
        prefix: keyPrefix,
        limit: batchSize,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.keys) {
        keys.push(typeof item === "string" ? item : item.name);
      }
      const complete = page.list_complete ?? page.listComplete ?? false;
      if (complete || !page.cursor) {
        break;
      }
      cursor = page.cursor;
    }
    return keys;
  }

  const storage: KvStorage = {
    name,

    get lastClearCount(): number {
      return lastClearCount;
    },

    async get(key: string): Promise<CacheEntry | null> {
      return decode(await client.get(key));
    },

    async has(key: string): Promise<boolean> {
      const value = await client.get(key);
      return value !== null && value !== undefined;
    },

    async set(key: string, entry: CacheEntry, setOptions?: StorageSetOptions): Promise<void> {
      const payload = await encode(entry);
      const ttlMs = setOptions?.ttlMs;
      if (ttlMs !== undefined && Number.isFinite(ttlMs)) {
        await client.set(key, payload, {
          expirationTtl: Math.max(1, Math.ceil(ttlMs / 1000)),
          ttlMs: Math.max(1, Math.round(ttlMs)),
        });
      } else {
        await client.set(key, payload);
      }
    },

    async compareAndSet(
      key: string,
      entry: CacheEntry,
      expectedRevision: number | null,
      setOptions?: StorageSetOptions,
    ): Promise<boolean> {
      const current = await storage.get(key);
      if ((current?.revision ?? null) !== expectedRevision) {
        return false;
      }
      await storage.set(key, entry, setOptions);
      return true;
    },

    async delete(key: string): Promise<void> {
      await client.delete(key);
    },

    async deleteMany(keys: readonly string[]): Promise<void> {
      for (const key of keys) {
        await client.delete(key);
      }
    },

    async clear(clearOptions?: StorageClearOptions): Promise<void> {
      const target = clearOptions?.prefix ?? `${prefix}:`;
      const keys = await listKeys(target);
      for (const key of keys) {
        await client.delete(key);
      }
      lastClearCount = keys.length;
    },

    async acquireLock(key: string, lockOptions: LockOptions): Promise<CacheLock | null> {
      // KV backends rarely offer atomic set-if-absent: this is best effort, and
      // it is documented as such. Worst case, duplicated work is still coalesced
      // inside a process by the local single-flight.
      const lockKey = `${lockPrefix}${hashValue(key, 24)}`;
      const existing = await client.get(lockKey);
      if (existing) {
        const parsed = typeof existing === "string" ? tryParseLock(existing) : null;
        if (parsed && Date.now() < parsed.expiresAt) {
          return null;
        }
      }
      const token = lockOptions.token ?? randomToken();
      await client.set(lockKey, JSON.stringify({ token, expiresAt: Date.now() + lockOptions.ttlMs }), {
        expirationTtl: Math.max(1, Math.ceil(lockOptions.ttlMs / 1000)),
        ttlMs: Math.max(1, Math.round(lockOptions.ttlMs)),
      });

      return {
        key,
        token,
        release: async (): Promise<void> => {
          const current = await client.get(lockKey);
          const parsed = typeof current === "string" ? tryParseLock(current) : null;
          if (parsed?.token === token) {
            await client.delete(lockKey);
          }
        },
      };
    },
  };

  return storage;
}

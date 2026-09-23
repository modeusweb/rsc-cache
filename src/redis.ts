/**
 * `rsc-cache/redis` — Redis / Valkey / Redis-compatible storage.
 *
 * The adapter talks to any client through a *structural* interface
 * (`get/set/del/sadd/smembers/...`), so the core package never depends on
 * `@redis/client`, `ioredis` or `@upstash/redis`:
 *
 * ```ts
 * import { createClient } from "@redis/client";
 * import { createRedisStorage } from "rsc-cache/redis";
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * await client.connect();
 *
 * const storage = createRedisStorage({ client });
 * ```
 *
 * What it provides:
 * - native TTL via `PX` (entries expire inside Redis, no cleanup job needed),
 * - native tags (`SADD`/`SMEMBERS`), invalidation in a single Lua round trip,
 * - compare-and-set writes so a slow revalidation cannot overwrite a newer
 *   value (Lua when the client supports `eval`, read-compare-write otherwise),
 * - distributed locks (`SET NX PX`) used by the runtime for cross-process
 *   single-flight,
 * - graceful degradation: any client error propagates to the runtime, which
 *   applies the configured failure mode (fail-open by default).
 *
 * Cluster note: Lua scripts touch several keys, which requires them to live in
 * the same hash slot. In Redis Cluster either use `atomic: false` (pipelined
 * writes, no CAS) or a hash-tag based prefix.
 */

import {
  INVALIDATE_TAG_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  SET_ENTRY_SCRIPT,
} from "./redis-scripts.js";
import { entryFromString, entryToString, isEntryString, decodeEntry, encodeEntry } from "./codec.js";
import { hashValue } from "./hash.js";
import { randomToken } from "./random.js";
import type {
  CacheEntry,
  CacheLock,
  CacheStorage,
  LockOptions,
  StorageClearOptions,
  StorageSetOptions,
  StorageTagScope,
} from "./types.js";

export interface RedisSetArguments {
  PX?: number;
  EX?: number;
  NX?: boolean;
  XX?: boolean;
}

/** Minimal Redis contract. Works with `@redis/client`, `ioredis` and Upstash. */
export interface RedisClientLike {
  get(key: string): Promise<string | Uint8Array | null>;
  set(
    key: string,
    value: string | Uint8Array,
    options?: RedisSetArguments,
  ): Promise<unknown>;
  del(keys: string | string[]): Promise<unknown>;
  exists(keys: string | string[]): Promise<number>;
  sadd(key: string, members: string | string[]): Promise<unknown>;
  srem(key: string, members: string | string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  pexpire?(key: string, milliseconds: number): Promise<unknown>;
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  scanIterator?(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string>;
  scan?(cursor: string, options?: { MATCH?: string; COUNT?: number }): Promise<unknown>;
}

export interface RedisStorageOptions {
  client: RedisClientLike;
  /** Backend name used in events. Default `"redis"`. */
  name?: string;
  /** Prefix for adapter-internal keys (tag indexes, key index). Default `"rsc-cache"`. */
  prefix?: string;
  /**
   * Value encoding: `"base64"` (default) stores a single string envelope that
   * every client can write; `"binary"` stores raw bytes (fewer bytes, requires a
   * client that returns buffers, e.g. node-redis `commandOptions({ returnBuffers: true })`).
   */
  valueEncoding?: "base64" | "binary";
  /**
   * Use Lua for atomic writes/tag invalidation when the client supports `eval`.
   * Default `true`.
   */
  atomic?: boolean;
  /**
   * Maintain a Redis set with every written key so `clear()` works without
   * `SCAN`. Default: enabled only when the client has no `scanIterator`/`scan`.
   */
  keyIndex?: boolean;
  /** Batch size for `SCAN`/`DEL` during `clear`. Default 500. */
  batchSize?: number;
  /** Namespace used for adapter-internal keys. Defaults to the value passed at call time. */
  namespace?: string;
}

export interface RedisStorageCounters {
  get: number;
  set: number;
  del: number;
  exists: number;
  sadd: number;
  srem: number;
  smembers: number;
  eval: number;
  scan: number;
}

export interface RedisStorage extends CacheStorage {
  readonly name: string;
  readonly counters: RedisStorageCounters;
  readonly usesLua: boolean;
  /** Deletes every key under a raw prefix using SCAN (bypasses the cache API). */
  flushPrefix(prefix: string): Promise<number>;
}

function toKeyList(keys: string | string[]): string[] {
  return Array.isArray(keys) ? keys : [keys];
}

/** Export kept for adapters/tests that need to normalise single vs. list arguments. */
export { toKeyList };

const DEFAULT_TTL_INDEX_TTL_MS = 30 * 24 * 3_600_000;

/**
 * Creates a Redis backed storage.
 *
 * The cache instance and the storage must use the same `prefix` (default
 * `"rsc-cache"`) so that `clear()` can find everything it wrote.
 */
export function createRedisStorage(options: RedisStorageOptions): RedisStorage {
  const client = options.client;
  const name = options.name ?? "redis";
  const prefix = options.prefix ?? "rsc-cache";
  const valueEncoding = options.valueEncoding ?? "base64";
  const atomic = options.atomic !== false;
  const batchSize = options.batchSize ?? 500;

  const hasEval = atomic && typeof client.eval === "function";
  const scanIterator = client.scanIterator?.bind(client);
  const hasScan = typeof scanIterator === "function" || typeof client.scan === "function";
  const useKeyIndex = options.keyIndex ?? !hasScan;

  const counters: RedisStorageCounters = {
    get: 0,
    set: 0,
    del: 0,
    exists: 0,
    sadd: 0,
    srem: 0,
    smembers: 0,
    eval: 0,
    scan: 0,
  };

  const indexKey = (): string => `${prefix}:~keys~`;
  const tagIndexKey = (tag: string, scope?: StorageTagScope): string =>
    `${prefix}:~tag~:${hashValue(scope?.namespace ?? options.namespace ?? "", 8)}:${hashValue(tag, 24)}`;
  const tagsOfKey = (entryKey: string): string => `${entryKey}:~t~`;

  async function encode(entry: CacheEntry): Promise<string | Uint8Array> {
    if (valueEncoding === "binary") {
      return encodeEntry(entry);
    }
    return entryToString(entry);
  }

  async function decode(raw: string | Uint8Array | null): Promise<CacheEntry | null> {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (raw instanceof Uint8Array) {
      return decodeEntry(raw);
    }
    if (!isEntryString(raw)) {
      // Foreign value under our prefix: treat as a miss instead of crashing.
      return null;
    }
    return entryFromString(raw);
  }

  const runScript = async (
    script: { source: string },
    keys: string[],
    args: string[],
  ): Promise<number> => {
    if (!client.eval) {
      throw new Error("client does not support EVAL");
    }
    counters.eval += 1;
    const result = await client.eval(script.source, { keys, arguments: args });
    return typeof result === "number" ? result : Number(result ?? 0);
  };

  async function writeEntry(
    key: string,
    entry: CacheEntry,
    setOptions: StorageSetOptions | undefined,
    expectedRevision: number | null | "-",
  ): Promise<boolean> {
    const payload = await encode(entry);
    const tags = entry.tags ?? [];
    const ttlMs = setOptions?.ttlMs;
    const expected =
      expectedRevision === "-" ? "-" : expectedRevision === null ? "" : String(expectedRevision);

    if (hasEval) {
      const keys = [key, useKeyIndex ? indexKey() : "", tagsOfKey(key)];
      for (const tag of tags) {
        keys.push(tagIndexKey(tag, { ...(options.namespace ? { namespace: options.namespace } : {}) }));
      }
      const result = await runScript(
        SET_ENTRY_SCRIPT,
        keys,
        [expected, String(entry.revision), String(payload), String(ttlMs ?? 0), String(tags.length)],
      );
      return result === 1;
    }

    // Non atomic path: read, compare, write. Used when the client cannot EVAL.
    const currentRaw = await client.get(key);
    counters.get += 1;
    const current = await decode(currentRaw);
    const currentRevision = current?.revision ?? null;
    if (expectedRevision !== "-" && currentRevision !== expectedRevision) {
      return false;
    }
    counters.set += 1;
    if (ttlMs !== undefined && Number.isFinite(ttlMs)) {
      await client.set(key, payload, { PX: Math.max(1, Math.round(ttlMs)) });
    } else {
      await client.set(key, payload);
    }
    // Reconcile tag bookkeeping on every write (mirrors SET_ENTRY_SCRIPT):
    // leave every tag index recorded for this key, then register the new set.
    // This must also run when the new entry carries no tags — otherwise a
    // rewrite would leave a stale membership behind and `invalidateTag` would
    // keep deleting an entry that no longer has the tag.
    const previous = await readTagRefs(key);
    for (const tagKey of previous) {
      counters.srem += 1;
      await client.srem(tagKey, key);
    }
    if (previous.length > 0) {
      counters.srem += 1;
      await client.srem(tagsOfKey(key), previous);
    }
    const refs: string[] = [];
    for (const tag of tags) {
      const tagKey = tagIndexKey(tag, {
        ...(options.namespace ? { namespace: options.namespace } : {}),
      });
      counters.sadd += 1;
      await client.sadd(tagKey, key);
      refs.push(tagKey);
    }
    if (refs.length > 0) {
      counters.sadd += 1;
      await client.sadd(tagsOfKey(key), refs);
      if (ttlMs !== undefined && client.pexpire) {
        await client.pexpire(tagsOfKey(key), Math.max(1, Math.round(ttlMs)));
      }
    }
    if (useKeyIndex) {
      counters.sadd += 1;
      await client.sadd(indexKey(), key);
    }
    return true;
  }

  async function readTagRefs(key: string): Promise<string[]> {
    counters.smembers += 1;
    return client.smembers(tagsOfKey(key));
  }

  /** Deletes keys in batches, preferring `SCAN` over the maintained key index. */
  async function deleteByPrefix(prefixToDelete: string): Promise<number> {
    let deleted = 0;

    if (scanIterator) {
      const buffer: string[] = [];
      for await (const scanned of scanIterator({
        MATCH: `${prefixToDelete}*`,
        COUNT: batchSize,
      })) {
        const keys = Array.isArray(scanned) ? scanned : [scanned];
        for (const key of keys) {
          if (typeof key === "string") {
            buffer.push(key);
          }
        }
        if (buffer.length >= batchSize) {
          const batch = buffer.splice(0, buffer.length);
          counters.del += 1;
          await client.del(batch);
          deleted += batch.length;
        }
      }
      if (buffer.length > 0) {
        counters.del += 1;
        await client.del(buffer);
        deleted += buffer.length;
      }
      counters.scan += 1;
      return deleted;
    }

    if (!useKeyIndex) {
      throw new Error(
        "Redis `clear()` needs `scanIterator`/`scan` on the client, or `keyIndex: true`. " +
          "Neither is available.",
      );
    }

    counters.smembers += 1;
    const indexed = await client.smembers(indexKey());
    const matched = indexed.filter((key) => key.startsWith(prefixToDelete));
    for (let i = 0; i < matched.length; i += batchSize) {
      counters.del += 1;
      await client.del(matched.slice(i, i + batchSize));
    }
    if (matched.length > 0) {
      counters.srem += 1;
      await client.srem(indexKey(), matched);
    }
    return matched.length;
  }

  const storage: RedisStorage = {
    name,

    get counters(): RedisStorageCounters {
      return counters;
    },

    get usesLua(): boolean {
      return hasEval;
    },

    async get(key: string): Promise<CacheEntry | null> {
      counters.get += 1;
      return decode(await client.get(key));
    },

    async has(key: string): Promise<boolean> {
      counters.exists += 1;
      const result = await client.exists(key);
      return Number(result) > 0;
    },

    async set(key: string, entry: CacheEntry, setOptions?: StorageSetOptions): Promise<void> {
      await writeEntry(key, entry, setOptions, "-");
    },

    async compareAndSet(
      key: string,
      entry: CacheEntry,
      expectedRevision: number | null,
      setOptions?: StorageSetOptions,
    ): Promise<boolean> {
      return writeEntry(key, entry, setOptions, expectedRevision);
    },

    async delete(key: string): Promise<void> {
      counters.del += 1;
      await client.del([key, tagsOfKey(key)]);
      if (useKeyIndex) {
        counters.srem += 1;
        await client.srem(indexKey(), key);
      }
    },

    async deleteMany(keys: readonly string[]): Promise<void> {
      if (keys.length === 0) {
        return;
      }
      for (let i = 0; i < keys.length; i += batchSize) {
        counters.del += 1;
        await client.del(keys.slice(i, i + batchSize));
      }
      if (useKeyIndex) {
        for (let i = 0; i < keys.length; i += batchSize) {
          counters.srem += 1;
          await client.srem(indexKey(), keys.slice(i, i + batchSize));
        }
      }
    },

    async clear(clearOptions?: StorageClearOptions): Promise<void> {
      await deleteByPrefix(clearOptions?.prefix ?? `${prefix}:`);
    },

    flushPrefix(prefixToFlush: string): Promise<number> {
      return deleteByPrefix(prefixToFlush);
    },

    async addTags(key: string, tags: readonly string[], scope?: StorageTagScope): Promise<void> {
      if (tags.length === 0) {
        return;
      }
      const refs: string[] = [];
      for (const tag of tags) {
        const tagKey = tagIndexKey(tag, scope);
        counters.sadd += 1;
        await client.sadd(tagKey, key);
        refs.push(tagKey);
      }
      counters.sadd += 1;
      await client.sadd(tagsOfKey(key), refs);
      if (client.pexpire) {
        await client.pexpire(tagsOfKey(key), DEFAULT_TTL_INDEX_TTL_MS);
      }
    },

    async invalidateTag(tag: string, scope?: StorageTagScope): Promise<void> {
      const tagKey = tagIndexKey(tag, scope);
      if (hasEval) {
        await runScript(INVALIDATE_TAG_SCRIPT, [tagKey], []);
        return;
      }
      counters.smembers += 1;
      const members = await client.smembers(tagKey);
      for (let i = 0; i < members.length; i += batchSize) {
        counters.del += 1;
        await client.del(members.slice(i, i + batchSize));
      }
      counters.del += 1;
      await client.del(tagKey);
    },

    async acquireLock(key: string, lockOptions: LockOptions): Promise<CacheLock | null> {
      const token = lockOptions.token ?? randomToken();
      counters.set += 1;
      const result = await client.set(key, token, {
        NX: true,
        PX: Math.max(1, Math.round(lockOptions.ttlMs)),
      });

      if (result === null || result === undefined || result === false) {
        return null;
      }

      return {
        key,
        token,
        release: async (): Promise<void> => {
          if (hasEval) {
            await runScript(RELEASE_LOCK_SCRIPT, [key], [token]);
            return;
          }
          // Non atomic fallback: compare then delete. A peer that took over the
          // lock in the meantime keeps it, because the token no longer matches.
          counters.get += 1;
          const current = await client.get(key);
          if (typeof current === "string" && current === token) {
            counters.del += 1;
            await client.del(key);
          }
        },
        extend: async (ttlMs: number): Promise<boolean> => {
          if (!client.pexpire) {
            return false;
          }
          counters.get += 1;
          const current = await client.get(key);
          if (typeof current !== "string" || current !== token) {
            return false;
          }
          await client.pexpire(key, Math.max(1, Math.round(ttlMs)));
          return true;
        },
      };
    },
  };

  return storage;
}

export { REDIS_SCRIPTS } from "./redis-scripts.js";
export type { RedisScript } from "./redis-scripts.js";

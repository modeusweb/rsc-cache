/**
 * Tag index fallback and invalidation tombstones.
 *
 * Backends with native tag support (memory, Redis) implement `addTags` and
 * `invalidateTag` themselves and skip this module. For every other backend
 * (Postgres, DynamoDB, KV, filesystem, ...) the library maintains an index
 * entry per tag:
 *
 * ```text
 * rsc-cache:v1:products:<v>:~tags~:<hash(tag)> -> ["entry-key-1", "entry-key-2", ...]
 * ```
 *
 * Tag membership is best effort for storages without compare-and-set: two
 * processes writing the same tag concurrently can lose one membership, which
 * results in an extra cache miss at worst — never in stale data being kept
 * after an invalidation (entries are deleted by key, and CAS-protected writes
 * prevent resurrection).
 *
 * Tombstones close the remaining window (`invalidate` racing an in-flight
 * write) when `strictInvalidation: true` is enabled.
 */

import { decodeUtf8, encodeUtf8 } from "./bytes.js";
import { CacheError } from "./errors.js";
import type { KeyContext } from "./keys.js";
import { buildTagIndexKey, buildTagTombstoneKey } from "./keys.js";
import { deleteKeys } from "./storage.js";
import type { CacheEntry, CacheStorage, StorageSetOptions } from "./types.js";

export const DEFAULT_MAX_KEYS_PER_TAG = 5_000;
export const MIN_INDEX_TTL_MS = 7 * 24 * 3_600_000;
export const DEFAULT_TOMBSTONE_TTL_MS = 24 * 3_600_000;
const CAS_RETRIES = 4;
const DELETE_CHUNK = 500;

export interface TagIndexOptions {
  storage: CacheStorage;
  context: KeyContext;
  maxKeysPerTag?: number;
  onError?: (error: Error) => void;
}

function indexEntry(keys: readonly string[], revision: number, expiresAt: number): CacheEntry {
  return {
    value: encodeUtf8(JSON.stringify(keys)),
    createdAt: Date.now(),
    expiresAt,
    revision,
    state: "value",
    tags: [],
  };
}

function decodeIndex(entry: CacheEntry | null): string[] {
  if (!entry) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(entry.value));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export class TagIndex {
  private readonly storage: CacheStorage;
  private readonly context: KeyContext;
  private readonly maxKeysPerTag: number;
  private readonly onError: (error: Error) => void;

  constructor(options: TagIndexOptions) {
    this.storage = options.storage;
    this.context = options.context;
    this.maxKeysPerTag = options.maxKeysPerTag ?? DEFAULT_MAX_KEYS_PER_TAG;
    this.onError =
      options.onError ??
      ((): void => {
        /* the caller surfaces errors through the cache event bus */
      });
  }

  /** Registers tag memberships for an entry key. */
  async add(
    key: string,
    tags: readonly string[],
    options: { ttlMs?: number; staleTtlMs?: number } = {},
  ): Promise<void> {
    const lifetime = (options.ttlMs ?? 0) + (options.staleTtlMs ?? 0);
    const expiresAt = Date.now() + Math.max(lifetime, MIN_INDEX_TTL_MS);

    for (const tag of tags) {
      const indexKey = buildTagIndexKey(this.context, tag);
      let stored = false;

      for (let attempt = 0; attempt < CAS_RETRIES && !stored; attempt += 1) {
        const existing = await this.storage.get(indexKey);
        const keys = decodeIndex(existing);
        if (keys.includes(key)) {
          stored = true;
          break;
        }
        keys.push(key);
        if (keys.length > this.maxKeysPerTag) {
          keys.splice(0, keys.length - this.maxKeysPerTag);
        }
        const entry = indexEntry(keys, (existing?.revision ?? 0) + 1, expiresAt);
        const setOptions: StorageSetOptions = {
          expiresAt,
          ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        };

        if (typeof this.storage.compareAndSet === "function") {
          stored = await this.storage.compareAndSet(
            indexKey,
            entry,
            existing?.revision ?? null,
            setOptions,
          );
        } else {
          await this.storage.set(indexKey, entry, setOptions);
          stored = true;
        }
      }

      if (!stored) {
        this.onError(
          new CacheError(
            `Failed to update the tag index for "${tag}" after ${CAS_RETRIES} attempts`,
            { code: "ERR_CACHE_TAG_INDEX" },
          ),
        );
      }
    }
  }

  /** Entry keys registered under a tag. */
  async keys(tag: string): Promise<string[]> {
    const indexKey = buildTagIndexKey(this.context, tag);
    return decodeIndex(await this.storage.get(indexKey));
  }

  /** Deletes every entry registered under a tag. Returns the number of keys targeted. */
  async invalidate(tag: string): Promise<number> {
    const indexKey = buildTagIndexKey(this.context, tag);
    const keys = await this.keys(tag);

    for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
      await deleteKeys(this.storage, keys.slice(i, i + DELETE_CHUNK));
    }
    await this.storage.delete(indexKey);
    return keys.length;
  }
}

/** Writes an invalidation tombstone for a tag (strict invalidation mode). */
export async function writeTagTombstone(
  storage: CacheStorage,
  context: KeyContext,
  tag: string,
  now: number,
  ttlMs = DEFAULT_TOMBSTONE_TTL_MS,
): Promise<void> {
  const key = buildTagTombstoneKey(context, tag);
  const entry: CacheEntry = {
    value: encodeUtf8(JSON.stringify({ invalidatedAt: now })),
    createdAt: now,
    expiresAt: now + ttlMs,
    revision: 1,
  };
  await storage.set(key, entry, { ttlMs, expiresAt: now + ttlMs });
}

/** Reads the invalidation timestamp of each tag (absent tags are omitted). */
export async function readTagTombstones(
  storage: CacheStorage,
  context: KeyContext,
  tags: readonly string[],
  now: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    tags.map(async (tag) => {
      const key = buildTagTombstoneKey(context, tag);
      const entry = await storage.get(key);
      if (!entry || now >= entry.expiresAt) {
        return;
      }
      try {
        const parsed = JSON.parse(decodeUtf8(entry.value)) as { invalidatedAt?: number };
        out.set(tag, typeof parsed.invalidatedAt === "number" ? parsed.invalidatedAt : 0);
      } catch {
        // A corrupted tombstone must not break writes; treat it as "no tombstone".
      }
    }),
  );
  return out;
}

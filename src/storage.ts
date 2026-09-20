/**
 * Storage helpers: capability detection, validation and small utilities that
 * every backend needs.
 */

import { CacheConfigurationError, CacheStorageError, toError } from "./errors.js";
import type { CacheEntry, CacheStorage, ObservableStorage, StorageEvent } from "./types.js";

const REQUIRED: Array<keyof CacheStorage> = ["get", "set", "delete", "has"];

/**
 * Validates a (possibly) custom storage object.
 *
 * ```ts
 * const storage = defineStorage({
 *   async get(key) { ... },
 *   async set(key, entry) { ... },
 *   async delete(key) { ... },
 *   async has(key) { ... },
 * });
 * ```
 */
export function defineStorage(storage: CacheStorage): CacheStorage {
  if (!storage || typeof storage !== "object") {
    throw new CacheConfigurationError("storage must be an object");
  }
  for (const method of REQUIRED) {
    if (typeof storage[method] !== "function") {
      throw new CacheConfigurationError(`storage is missing the required \`${String(method)}\` method`);
    }
  }
  if (storage.name !== undefined && typeof storage.name !== "string") {
    throw new CacheConfigurationError("storage.name must be a string");
  }
  return storage;
}

export interface StorageCapabilities {
  /** Compare-and-set writes (prevents stale overwrite atomically). */
  cas: boolean;
  /** Native tag index. */
  nativeTags: boolean;
  /** Distributed lock support. */
  locks: boolean;
  /** Batched deletes. */
  batchDelete: boolean;
  /** Can report internal eviction/expiration events. */
  observable: boolean;
}

export function inspectStorage(storage: CacheStorage): StorageCapabilities {
  return {
    cas: typeof storage.compareAndSet === "function",
    nativeTags:
      typeof storage.addTags === "function" && typeof storage.invalidateTag === "function",
    locks: typeof storage.acquireLock === "function",
    batchDelete: typeof storage.deleteMany === "function",
    observable: typeof (storage as Partial<ObservableStorage>).observe === "function",
  };
}

export function isObservableStorage(storage: CacheStorage): storage is CacheStorage & ObservableStorage {
  return typeof (storage as Partial<ObservableStorage>).observe === "function";
}

/** Subscribes to storage events; returns a no-op unsubscribe when unsupported. */
export function observeStorage(
  storage: CacheStorage,
  listener: (event: StorageEvent) => void,
): () => void {
  if (!isObservableStorage(storage)) {
    return () => undefined;
  }
  return storage.observe(listener);
}

/**
 * Deletes many keys, preferring the storage's bulk operation.
 *
 * A failing bulk delete falls back to individual deletes so one unsupported
 * primitive cannot break invalidation.
 */
export async function deleteKeys(storage: CacheStorage, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) {
    return 0;
  }
  if (typeof storage.deleteMany === "function") {
    try {
      await storage.deleteMany(keys);
      return keys.length;
    } catch (error) {
      if (keys.length === 1) {
        throw error;
      }
      // fall through to individual deletes
    }
  }
  let deleted = 0;
  for (const key of keys) {
    await storage.delete(key);
    deleted += 1;
  }
  return deleted;
}

/** Reads several keys, preserving order. Individual failures become `null`. */
export async function getMany(
  storage: CacheStorage,
  keys: readonly string[],
): Promise<Array<CacheEntry | null>> {
  return Promise.all(keys.map((key) => storage.get(key)));
}

/** Extracts the namespace segment of a generated key (used by `clear`). */
export function namespacePrefix(rootPrefix: string, formatVersion: string, namespace: string): string {
  return `${rootPrefix}:${formatVersion}:${namespace}:`;
}

/** Wraps an arbitrary storage failure into {@link CacheStorageError}. */
export function wrapStorageError(error: unknown, operation: string, backend?: string): CacheStorageError {
  if (error instanceof CacheStorageError) {
    return error;
  }
  const cause = toError(error);
  return new CacheStorageError(
    `Cache storage ${operation} failed${backend ? ` (backend: ${backend})` : ""}: ${cause.message}`,
    { cause, details: { operation, backend } },
  );
}

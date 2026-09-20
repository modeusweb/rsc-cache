/**
 * Invalidation helpers.
 *
 * The standalone functions fan out over every registered cache instance, so
 * `revalidateTag("product:123")` keeps all caches of the process consistent.
 * Pass `{ cache }` to target one instance (or one namespace) explicitly.
 *
 * Errors are collected and the first one is thrown after every target was
 * attempted: a mutation that silently invalidated nothing would keep serving
 * stale data, which is worse than a visible error.
 */

import { CacheConfigurationError } from "./errors.js";
import { registeredCaches } from "./global.js";
import type {
  CacheInstance,
  CacheStorage,
  InvalidateOptions,
  InvalidateResult,
} from "./types.js";

export interface InvalidationOptions {
  /** Target a specific instance, or the instance registered under this namespace. */
  cache?: CacheInstance | string;
  /** Namespace to invalidate (defaults to the instance namespace). */
  namespace?: string;
}

function resolveInstances(options?: InvalidationOptions): CacheInstance[] {
  const all = registeredCaches();
  if (options?.cache !== undefined) {
    if (typeof options.cache === "string") {
      const matching = all.filter((instance) => instance.namespace === options.cache);
      if (matching.length === 0) {
        throw new CacheConfigurationError(
          `No registered cache instance has the namespace "${options.cache}"`,
        );
      }
      return matching;
    }
    return [options.cache];
  }
  if (options?.namespace !== undefined) {
    return all.filter((instance) => instance.namespace === options.namespace);
  }
  return all;
}

/** Removes duplicates: two instances may share a storage and a namespace. */
function dedupe(instances: CacheInstance[]): CacheInstance[] {
  const byStorage = new Map<CacheStorage, Set<string>>();
  const out: CacheInstance[] = [];
  for (const instance of instances) {
    let namespaces = byStorage.get(instance.storage);
    if (!namespaces) {
      namespaces = new Set();
      byStorage.set(instance.storage, namespaces);
    }
    if (namespaces.has(instance.namespace)) {
      continue;
    }
    namespaces.add(instance.namespace);
    out.push(instance);
  }
  return out;
}

async function fanOut(
  options: InvalidationOptions | undefined,
  run: (instance: CacheInstance) => Promise<void>,
): Promise<void> {
  const instances = dedupe(resolveInstances(options));
  let firstError: Error | undefined;
  for (const instance of instances) {
    try {
      await run(instance);
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (firstError) {
    throw firstError;
  }
}

/** Invalidates every entry carrying `tag` in every registered cache. */
export function revalidateTag(tag: string, options?: InvalidationOptions): Promise<void> {
  return fanOut(options, (instance) => instance.revalidateTag(tag));
}

/** Invalidates one key (a logical key or a full key returned by `cachedFn.key()`). */
export function revalidateKey(key: string, options?: InvalidationOptions): Promise<void> {
  return fanOut(options, (instance) => instance.revalidateKey(key));
}

/** Invalidates a whole namespace. */
export function revalidateNamespace(
  namespace?: string,
  options?: InvalidationOptions,
): Promise<void> {
  return fanOut(options, (instance) => instance.revalidateNamespace(namespace));
}

/** Clears the given namespace of every registered cache (or a specific one). */
export function clearCache(options?: InvalidationOptions): Promise<void> {
  return fanOut(options, (instance) =>
    instance.clear(options?.namespace !== undefined ? { namespace: options.namespace } : {}),
  );
}

/**
 * Invalidates a combination of tags, keys and namespaces.
 *
 * ```ts
 * await invalidate({ tags: ["products"], keys: ["homepage"] });
 * ```
 */
export async function invalidate(options: InvalidateOptions): Promise<InvalidateResult> {
  const instances = dedupe(resolveInstances({ cache: options.cache }));
  const total: InvalidateResult = { tags: 0, keys: 0, namespaces: 0, entries: 0 };
  let firstError: Error | undefined;

  for (const instance of instances) {
    try {
      const result = await instance.invalidate(options);
      total.tags += result.tags;
      total.keys += result.keys;
      total.namespaces += result.namespaces;
      total.entries += result.entries;
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  if (firstError) {
    throw firstError;
  }
  return total;
}

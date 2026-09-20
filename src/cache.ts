/**
 * The main entry point of the library.
 *
 * ```ts
 * import { cache } from "rsc-cache";
 *
 * export const getProduct = cache(
 *   async (id: string) => db.product.findUnique({ where: { id } }),
 *   { ttl: "5m", tags: (id) => [`product:${id}`] },
 * );
 * ```
 *
 * `cache()` uses the default cache instance (see `configureCache()`).
 * It performs request-scoped deduplication *and* persistent caching:
 *
 * ```text
 * component → rsc-cache.cache() → request memo (per request)
 *                              → storage (across requests)
 * ```
 */

import { getCache } from "./global.js";
import { registerCache, registeredCaches, resetCache } from "./global.js";
import type { AnyFunction, CacheOptions, CacheInstance, CachedFunction } from "./types.js";

/** Wraps a function with request deduplication + persistent caching. */
export function cache<F extends AnyFunction>(
  fn: F,
  options?: CacheOptions<Parameters<F>>,
): CachedFunction<F> {
  return getCache().cache(fn, options);
}

/** Wraps a function with a specific cache instance (dependency injection). */
export function cacheWith<F extends AnyFunction>(
  instance: CacheInstance,
  fn: F,
  options?: CacheOptions<Parameters<F>>,
): CachedFunction<F> {
  return instance.cache(fn, options);
}

export { getCache, registerCache, registeredCaches, resetCache };

/**
 * Global registry and default cache.
 *
 * `cache(fn)` (no configuration) works out of the box against a process-local
 * memory storage. Production setups call `configureCache()` once at startup, or
 * `createCache()` for dependency injection.
 */

import { createCache, DEFAULT_NAMESPACE } from "./create-cache.js";
import type { CacheInstance, CreateCacheOptions } from "./types.js";

const registry = new Set<CacheInstance>();
let defaultInstance: CacheInstance | undefined;

/** Registers an instance so the standalone helpers can find it. */
export function registerCache(instance: CacheInstance): void {
  registry.add(instance);
}

export function unregisterCache(instance: CacheInstance): void {
  registry.delete(instance);
  if (defaultInstance === instance) {
    defaultInstance = undefined;
  }
}

/** Every registered instance (used by `revalidateTag`, `clearCache`, ...). */
export function registeredCaches(): CacheInstance[] {
  return [...registry];
}

export function setDefaultCache(instance: CacheInstance): void {
  defaultInstance = instance;
}

export function getDefaultCache(): CacheInstance | undefined {
  return defaultInstance;
}

/**
 * Returns the default cache, creating an unconfigured one on first use.
 *
 * A default instance uses process-local memory storage: correct and fast, but
 * not shared between processes. Configure it for production.
 */
export function getCache(): CacheInstance {
  defaultInstance ??= createCache({ namespace: DEFAULT_NAMESPACE });
  return defaultInstance;
}

/**
 * Configures the default cache (storage, namespace, defaults, hooks).
 *
 * ```ts
 * configureCache({ storage: redisStorage, namespace: "app", defaults: { ttl: "5m" } });
 * ```
 */
export function configureCache(options: CreateCacheOptions = {}): CacheInstance {
  defaultInstance = createCache({
    namespace: options.namespace ?? DEFAULT_NAMESPACE,
    ...options,
  });
  return defaultInstance;
}

/**
 * Disposes every registered instance and resets the default.
 *
 * Intended for tests and graceful shutdown; not needed in application code.
 */
export async function resetCache(): Promise<void> {
  const instances = [...registry];
  registry.clear();
  defaultInstance = undefined;
  for (const instance of instances) {
    try {
      await instance.dispose();
    } catch {
      // Shutdown must not fail because one backend refused to close.
    }
  }
}

/** Alias kept for symmetry with `resetCache`. */
export const resetGlobalCache = resetCache;

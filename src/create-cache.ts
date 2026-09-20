/**
 * `createCache()` — dependency injection for caches.
 *
 * One instance owns one namespace, one storage binding, one serializer,
 * one clock and one set of statistics. Instances sharing a storage stay
 * isolated thanks to the namespace segment in every key.
 */

import {
  createCachedFunction,
  resolveDescriptor,
  type DescriptorContext,
} from "./cache-function.js";
import { systemClock } from "./clock.js";
import { CacheConfigurationError } from "./errors.js";
import { EventBus } from "./events.js";
import { registerCache, unregisterCache } from "./global.js";
import { attachInternals } from "./internal.js";
import { DEFAULT_KEY_PREFIX, validateNamespace, validatePrefix } from "./keys.js";
import { createLogger } from "./logger.js";
import { memoryStorage } from "./memory.js";
import { CacheRuntime, resolveLockOptions, resolveTimeouts } from "./runtime.js";
import { defaultSerializer } from "./serializer.js";
import { CacheStats } from "./stats.js";
import type {
  AnyFunction,
  CacheDiagnostics,
  CacheInstance,
  CacheOptions,
  CacheStatsSnapshot,
  CacheStorage,
  CachedFunction,
  CreateCacheOptions,
  DefaultCacheOptions,
  FailureMode,
  InvalidateOptions,
  InvalidateResult,
} from "./types.js";

export const DEFAULT_NAMESPACE = "default";

/**
 * Creates an isolated cache instance.
 *
 * ```ts
 * const products = createCache({ storage: redisStorage, namespace: "products" });
 * const getProduct = products.cache(async (id: string) => db.product.find(id), { ttl: "5m" });
 * ```
 */
export function createCache(options: CreateCacheOptions = {}): CacheInstance {
  const namespace = validateNamespace(options.namespace ?? DEFAULT_NAMESPACE);
  const prefix = validatePrefix(options.prefix ?? DEFAULT_KEY_PREFIX);
  const clock = options.clock ?? systemClock;
  const ownsStorage = options.storage === undefined;
  const storage: CacheStorage = options.storage ?? memoryStorage({ clock });
  const serializer = options.serializer ?? defaultSerializer;
  const logger = createLogger({
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    prefix: `[rsc-cache:${namespace}]`,
  });
  const stats = new CacheStats();
  const eventBus = new EventBus({
    cache: namespace,
    backend: storage.name ?? "custom",
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.exposeKeys !== undefined ? { exposeKeys: options.exposeKeys } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    logger,
  });
  const defaults: DefaultCacheOptions<unknown[]> = options.defaults ?? {};
  const lock = resolveLockOptions(options.distributedLock);

  const readFailureMode: FailureMode =
    options.readFailureMode ?? options.failureMode ?? "fail-open";
  const writeFailureMode: FailureMode =
    options.writeFailureMode ?? options.failureMode ?? "fail-open";

  const runtime = new CacheRuntime({
    namespace,
    prefix,
    storage,
    serializer,
    ...(options.compression !== undefined ? { compression: options.compression } : {}),
    clock,
    ...(options.version !== undefined ? { version: options.version } : {}),
    defaults,
    timeouts: resolveTimeouts(options.timeouts),
    readFailureMode,
    writeFailureMode,
    distributedLock: lock,
    ...(options.backgroundTasks !== undefined ? { backgroundTasks: options.backgroundTasks } : {}),
    ...(options.instrumentation !== undefined ? { instrumentation: options.instrumentation } : {}),
    eventBus,
    stats,
    logger,
    debug: options.debug === true,
  });

  const instance: CacheInstance = {
    namespace,
    prefix,
    storage,
    clock,

    cache<F extends AnyFunction>(
      fn: F,
      fnOptions?: CacheOptions<Parameters<F>>,
    ): CachedFunction<F> {
      const descriptor = resolveDescriptor(
        descriptorContext,
        fn,
        (fnOptions ?? {}) as CacheOptions<unknown[]>,
      );
      return createCachedFunction<F>(runtime, instance, descriptor);
    },

    get: (key, getOptions) => runtime.rawGet(key, getOptions ?? {}),
    set: (key, value, setOptions) => runtime.rawSet(key, value, setOptions ?? {}),
    delete: (key, deleteOptions) => runtime.rawDelete(key, deleteOptions ?? {}),
    has: (key, hasOptions) => runtime.rawHas(key, hasOptions ?? {}),

    async revalidateTag(tag: string): Promise<void> {
      await runtime.invalidateTags([tag], namespace);
    },

    async revalidateKey(key: string, keyOptions?: { namespace?: string }): Promise<void> {
      if (keyOptions?.namespace !== undefined && keyOptions.namespace !== namespace) {
        throw new CacheConfigurationError(
          `revalidateKey was called with namespace "${keyOptions.namespace}" on an instance bound to "${namespace}"`,
        );
      }
      await runtime.invalidateKeys([key], namespace);
    },

    async revalidateNamespace(target?: string): Promise<void> {
      await runtime.invalidateNamespace(target ?? namespace);
    },

    async invalidate(invalidateOptions: InvalidateOptions): Promise<InvalidateResult> {
      const result: InvalidateResult = { tags: 0, keys: 0, namespaces: 0, entries: 0 };
      if (invalidateOptions.cache !== undefined && invalidateOptions.cache !== namespace) {
        throw new CacheConfigurationError(
          `invalidate() targeted cache "${invalidateOptions.cache}" on an instance bound to "${namespace}"`,
        );
      }
      if (invalidateOptions.tags && invalidateOptions.tags.length > 0) {
        result.entries += await runtime.invalidateTags(invalidateOptions.tags, namespace);
        result.tags = invalidateOptions.tags.length;
      }
      if (invalidateOptions.keys && invalidateOptions.keys.length > 0) {
        result.keys = await runtime.invalidateKeys(invalidateOptions.keys, namespace);
      }
      for (const target of invalidateOptions.namespaces ?? []) {
        await runtime.invalidateNamespace(target);
        result.namespaces += 1;
      }
      return result;
    },

    async clear(clearOptions?: { namespace?: string }): Promise<void> {
      await runtime.invalidateNamespace(clearOptions?.namespace ?? namespace);
    },

    stats(): CacheStatsSnapshot {
      return stats.snapshot();
    },

    resetStats(): void {
      stats.reset();
    },

    diagnostics(): CacheDiagnostics {
      return runtime.diagnostics();
    },

    flushBackgroundTasks(): Promise<void> {
      return runtime.settle();
    },

    async dispose(): Promise<void> {
      runtime.dispose();
      unregisterCache(instance);
      if (ownsStorage && typeof storage.close === "function") {
        await storage.close();
      }
    },
  };

  const descriptorContext: DescriptorContext = {
    runtime,
    instance,
    namespace,
    ...(options.version !== undefined ? { version: options.version } : {}),
    defaults,
    serializer,
    ...(options.compression !== undefined ? { compression: options.compression } : {}),
    lock,
  };

  attachInternals(instance, { runtime, descriptorContext });

  if (options.register !== false) {
    registerCache(instance);
  }

  return instance;
}

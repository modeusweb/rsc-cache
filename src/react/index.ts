/**
 * `rsc-cache/react` — React integration.
 *
 * The layering is deliberate and must not be conflated:
 *
 * ```text
 * component ──► React cache()      request/render lifetime, argument-identity memo
 *                   └──► rsc-cache  persistent cache (storage, tags, TTL, SWR)
 * ```
 *
 * - React's `cache()` is used *on top* for request-level deduplication. It never
 *   replaces the persistent cache, and the persistent cache never replaces it.
 * - `cacheSignal()` (React 19.3+) is read during rendering and passed to the
 *   source function when `passSignal: true`, so a cancelled render can cancel
 *   in-flight work — while a computation shared by several consumers is only
 *   cancelled when *all* of them are gone (see `SingleFlight`).
 * - This module is the only place that imports `react`; the core stays
 *   framework agnostic.
 */

import * as React from "react";
import { createCachedFunction, resolveDescriptor } from "../cache-function.js";
import { withCacheContext } from "../context.js";
import { getCache } from "../global.js";
import { getInternals } from "../internal.js";
import type {
  AnyFunction,
  CacheInstance,
  CacheOptions,
  CachedFunction,
  CachedFunctionExtras,
} from "../types.js";

type ReactCache = <F extends AnyFunction>(fn: F) => F;
type ReactCacheSignal = () => AbortSignal | null;

const reactCache = (React as { cache?: ReactCache }).cache;
const reactCacheSignal = (React as { cacheSignal?: ReactCacheSignal }).cacheSignal;

export interface ReactCacheOptions<Args extends unknown[]> extends CacheOptions<Args> {
  /**
   * Wrap the cached function with React's `cache()` for request-level
   * deduplication. Default `true` when React provides `cache()`.
   */
  useReactCache?: boolean;
  /**
   * Read `cacheSignal()` during rendering and use it as the call signal
   * (combined with `passSignal: true` to forward it to your data source).
   * Default `true`.
   */
  useCacheSignal?: boolean;
}

/** `true` when the running React version exposes the RSC `cache()` API. */
export function isReactCacheAvailable(): boolean {
  return typeof reactCache === "function";
}

/** `true` when the running React version exposes `cacheSignal()` (React 19.3+). */
export function isCacheSignalAvailable(): boolean {
  return typeof reactCacheSignal === "function";
}

/**
 * The `AbortSignal` of the current render, or `null` outside of rendering.
 *
 * Safe to call anywhere: returns `null` on the client, outside rendering and on
 * React versions without `cacheSignal()`.
 */
export function getCacheSignal(): AbortSignal | null {
  if (typeof reactCacheSignal !== "function") {
    return null;
  }
  try {
    return reactCacheSignal();
  } catch {
    return null;
  }
}

const EXTRA_PROPERTIES: Array<keyof CachedFunctionExtras<AnyFunction>> = [
  "name",
  "namespace",
  "version",
  "instance",
  "key",
  "tags",
  "prefetch",
  "revalidate",
  "invalidate",
  "stats",
  "diagnostics",
];

function copyExtras<F extends AnyFunction>(
  from: CachedFunction<F>,
  to: CachedFunction<F>,
): CachedFunction<F> {
  for (const property of EXTRA_PROPERTIES) {
    const value = (from as unknown as Record<string, unknown>)[property];
    if (value !== undefined) {
      Object.defineProperty(to, property, {
        value,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
  }
  return to;
}

/**
 * Cached function for RSC rendering: React `cache()` on top of `rsc-cache`.
 *
 * ```ts
 * import { cache } from "rsc-cache/react";
 *
 * const getProduct = cache(
 *   async (id: string) => db.product.find(id),
 *   { ttl: "5m", tags: (id) => [`product:${id}`] },
 * );
 * ```
 */
export function cache<F extends AnyFunction>(
  fn: F,
  options: ReactCacheOptions<Parameters<F>> = {},
): CachedFunction<F> {
  return cacheIn(getCache(), fn, options);
}

/** Same as {@link cache} but bound to an explicit cache instance. */
export function cacheIn<F extends AnyFunction>(
  instance: CacheInstance,
  fn: F,
  options: ReactCacheOptions<Parameters<F>> = {},
): CachedFunction<F> {
  const { runtime, descriptorContext } = getInternals(instance);
  const descriptor = resolveDescriptor(
    descriptorContext,
    fn,
    options as CacheOptions<unknown[]>,
  );

  if (options.useCacheSignal !== false && typeof reactCacheSignal === "function") {
    descriptor.signalProvider = getCacheSignal;
  }

  const cached = createCachedFunction<F>(runtime, instance, descriptor);

  if (options.useReactCache !== false && typeof reactCache === "function") {
    const requestScoped = reactCache(cached) as CachedFunction<F>;
    return copyExtras(cached, requestScoped);
  }

  return cached;
}

/**
 * Runs `fn` with a request context derived from React's render lifetime.
 *
 * `cacheSignal()` is only meaningful while React renders, so the signal is
 * attached to the context: every cached function called inside `fn` then
 * observes it, without threading a signal through every call site.
 */
export function withReactCacheContext<T>(
  init: {
    requestId?: string;
    userId?: string;
    tenantId?: string;
    locale?: string;
    metadata?: Record<string, unknown>;
  },
  fn: () => T,
): T {
  const signal = getCacheSignal();
  return withCacheContext(signal ? { ...init, signal } : init, fn);
}

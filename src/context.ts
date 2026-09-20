/**
 * Request context and request-scoped memoization.
 *
 * Two different lifetimes must never be confused:
 *
 * - **request scope** (this file): deduplicates work inside one render/request,
 *   exactly like React's `cache()`. Nothing survives the request.
 * - **persistent cache** (`createCache`): survives across requests.
 *
 * Async propagation uses `AsyncLocalStorage` when the runtime provides it
 * (Node, Bun, Deno, Workers with `nodejs_compat`). When it does not, the
 * context is only available during the synchronous part of `withCacheContext`
 * and the library warns once — a silent, wrong context would risk leaking data
 * between users, so it is never faked.
 */

import type { CacheContext, CacheContextInit, RequestCache } from "./types.js";
import { CacheConfigurationError } from "./errors.js";
import { createLogger } from "./logger.js";

const logger = createLogger();

export const EMPTY_CONTEXT: CacheContext = Object.freeze({}) as CacheContext;

/* -------------------------------------------------------------------------- */
/* Request cache                                                              */
/* -------------------------------------------------------------------------- */

interface MemoEntry {
  promise: Promise<unknown>;
  tags: readonly string[];
}

/**
 * Request-scoped memo store: identical semantics to React's `cache()` but
 * usable outside of React (non-React RSC runtimes, route handlers, tests).
 *
 * Failed promises are dropped so a later call can retry within the same
 * request, while a *pending* promise is always shared.
 */
export function createRequestCache(): RequestCache {
  const entries = new Map<string, MemoEntry>();

  return {
    get size(): number {
      return entries.size;
    },
    run<T>(key: string, tags: readonly string[], factory: () => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing) {
        return existing.promise as Promise<T>;
      }
      const promise = factory();
      entries.set(key, { promise, tags: [...tags] });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) {
          entries.delete(key);
        }
      });
      return promise;
    },
    peek<T>(key: string): Promise<T> | undefined {
      return entries.get(key)?.promise as Promise<T> | undefined;
    },
    evict(keys: readonly string[]): void {
      for (const key of keys) {
        entries.delete(key);
      }
    },
    evictByTags(tags: readonly string[]): void {
      if (tags.length === 0) {
        return;
      }
      const wanted = new Set(tags);
      for (const [key, entry] of entries) {
        if (entry.tags.some((tag) => wanted.has(tag))) {
          entries.delete(key);
        }
      }
    },
    clear(): void {
      entries.clear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Async context propagation                                                  */
/* -------------------------------------------------------------------------- */

interface AsyncStoreLike {
  getStore(): unknown;
  run<T>(store: unknown, fn: () => T): T;
}

let asyncStore: AsyncStoreLike | null = null;
let loadPromise: Promise<boolean> | null = null;
let warnedAboutFallback = false;

/**
 * Enables async context propagation.
 *
 * Called automatically on first import; awaiting it lets tests and startup code
 * guarantee that `withCacheContext` propagates across `await` boundaries.
 */
export function warmUpContextStore(): Promise<boolean> {
  if (asyncStore) {
    return Promise.resolve(true);
  }
  loadPromise ??= (async () => {
    try {
      // Built dynamically so bundlers for edge runtimes do not hard-fail on a
      // Node builtin that the runtime may not ship.
      const specifier = `node:${"async_hooks"}`;
      const module = (await import(/* @vite-ignore */ specifier)) as {
        AsyncLocalStorage?: new () => AsyncStoreLike;
      };
      if (typeof module.AsyncLocalStorage === "function") {
        asyncStore = new module.AsyncLocalStorage();
        return true;
      }
    } catch {
      // Runtime without `node:async_hooks` — the synchronous fallback is used.
    }
    return false;
  })();
  return loadPromise;
}

/** `true` when contexts propagate across `await` (AsyncLocalStorage available). */
export function isAsyncContextEnabled(): boolean {
  return asyncStore !== null;
}

const syncStack: CacheContext[] = [];

/** Returns the context of the current request/render (frozen empty object when none). */
export function getCacheContext(): CacheContext {
  if (asyncStore) {
    const store = asyncStore.getStore();
    if (store) {
      return store as CacheContext;
    }
  }
  return syncStack.length > 0 ? (syncStack[syncStack.length - 1] as CacheContext) : EMPTY_CONTEXT;
}

/** Request-scoped memo store of the current context, if any. */
export function getRequestCache(): RequestCache | undefined {
  return getCacheContext().requestCache;
}

// Detect `AsyncLocalStorage` as soon as this module loads: context propagation
// must be available to the first request, not after the second one.
void warmUpContextStore();

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new CacheConfigurationError(`context.${name} must be a string when provided`);
  }
}

/** Normalizes and validates a context object, attaching a request cache. */
export function createCacheContext(init: CacheContextInit = {}): CacheContext {
  assertOptionalString(init.requestId, "requestId");
  assertOptionalString(init.userId, "userId");
  assertOptionalString(init.tenantId, "tenantId");
  assertOptionalString(init.locale, "locale");

  const context: CacheContext = {};
  if (init.requestId !== undefined) context.requestId = init.requestId;
  if (init.userId !== undefined) context.userId = init.userId;
  if (init.tenantId !== undefined) context.tenantId = init.tenantId;
  if (init.locale !== undefined) context.locale = init.locale;
  if (init.visibility !== undefined) context.visibility = init.visibility;
  if (init.signal !== undefined) context.signal = init.signal;
  if (init.metadata !== undefined) context.metadata = init.metadata;
  context.requestCache = init.requestCache ?? createRequestCache();
  return context;
}

function isRequestCache(value: unknown): value is RequestCache {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RequestCache).run === "function" &&
    "size" in (value as object)
  );
}

function mergeContext(outer: CacheContext, inner: CacheContext): CacheContext {
  if (outer === EMPTY_CONTEXT || Object.keys(outer).length === 0) {
    return inner;
  }
  return {
    ...outer,
    ...inner,
    requestCache: inner.requestCache ?? outer.requestCache,
    signal: inner.signal ?? outer.signal,
    metadata: inner.metadata ?? outer.metadata,
  };
}

export type ContextInit = CacheContextInit | RequestCache;

/**
 * Runs `fn` with the given context.
 *
 * ```ts
 * await withCacheContext({ userId, tenantId }, () => renderRequest());
 * ```
 *
 * Nested calls merge: inner values win, and the request cache is inherited
 * unless a new one is supplied.
 */
export function withCacheContext<T>(init: ContextInit | undefined, fn: () => T): T {
  const normalized = isRequestCache(init)
    ? createCacheContext({ requestCache: init })
    : createCacheContext(init ?? {});
  const merged = mergeContext(getCacheContext(), normalized);

  syncStack.push(merged);
  try {
    if (asyncStore) {
      return asyncStore.run(merged, fn);
    }
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      void warmUpContextStore().then((enabled) => {
        if (!enabled) {
          logger.warn(
            "this runtime has no AsyncLocalStorage: `withCacheContext` only propagates synchronously. " +
              "Derive `scope`/`key` from arguments, or enable the node:async_hooks compatibility layer.",
          );
        }
      });
    }
    return fn();
  } finally {
    syncStack.pop();
  }
}

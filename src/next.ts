/**
 * `rsc-cache/next` — optional Next.js bridge.
 *
 * This module **never imports `next/*`**. Everything Next-specific is injected by
 * the caller, which keeps the package free of framework coupling and immune to
 * Next's internal API churn:
 *
 * ```ts
 * // app/actions.ts
 * "use server";
 * import { revalidateTag as nextRevalidateTag } from "next/cache";
 * import { createNextBridge } from "rsc-cache/next";
 *
 * const { revalidateTag } = createNextBridge({ revalidateTag: nextRevalidateTag });
 *
 * export async function updateProduct(id: string, data: ProductInput) {
 *   await db.product.update({ where: { id }, data });
 *   await revalidateTag(`product:${id}`); // invalidates rsc-cache *and* Next
 * }
 * ```
 *
 * `createNextCacheHandler()` implements a Next.js `CacheHandler` on top of a
 * `rsc-cache` instance, so `use cache` (Cache Components) can use any storage
 * supported here (Redis, KV, ...). Next's handler interface is intentionally
 * typed loosely: it changed between versions, and this module must not break
 * when it changes again — verify against the Next version you deploy.
 */

import { getCache } from "./global.js";
import { invalidate, revalidateKey, revalidateTag } from "./invalidation.js";
import type { CacheInstance, InvalidateOptions, InvalidateResult } from "./types.js";

export interface NextBridgeOptions {
  /** `revalidateTag` imported from `next/cache` (optional: skipped when omitted). */
  revalidateTag?: (tag: string) => unknown;
  /** `revalidatePath` imported from `next/cache` (optional). */
  revalidatePath?: (path: string) => unknown;
  /**
   * Forward invalidations to Next as well. Default `true` — keeping both caches
   * coherent is almost always what you want while migrating.
   */
  propagateToNext?: boolean;
}

export interface NextBridge {
  revalidateTag(tag: string): Promise<void>;
  revalidateKey(key: string): Promise<void>;
  revalidatePath(path: string): Promise<void>;
  invalidate(options: InvalidateOptions): Promise<InvalidateResult>;
  /** Invalidates a tag in rsc-cache only (never calls into Next). */
  revalidateCacheTag(tag: string): Promise<void>;
}

/** Creates a bridge so one call invalidates both `rsc-cache` and Next's cache. */
export function createNextBridge(options: NextBridgeOptions = {}): NextBridge {
  const propagate = options.propagateToNext !== false;

  return {
    async revalidateTag(tag: string): Promise<void> {
      await revalidateTag(tag);
      if (propagate && options.revalidateTag) {
        await options.revalidateTag(tag);
      }
    },

    async revalidateKey(key: string): Promise<void> {
      await revalidateKey(key);
    },

    async revalidatePath(path: string): Promise<void> {
      // Paths are a Next concept. rsc-cache only knows tags and keys, so this
      // only forwards to Next (call it after invalidating the tags you own).
      if (options.revalidatePath) {
        await options.revalidatePath(path);
      }
    },

    invalidate(invalidateOptions: InvalidateOptions): Promise<InvalidateResult> {
      return invalidate(invalidateOptions);
    },

    revalidateCacheTag(tag: string): Promise<void> {
      return revalidateTag(tag);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Next cache handler                                                         */
/* -------------------------------------------------------------------------- */

export interface NextCacheHandlerContext {
  kind?: string;
  tags?: string[];
  softTags?: string[];
  revalidate?: number | false;
}

export interface NextCacheHandlerLike {
  get(cacheKey: string, ctx?: NextCacheHandlerContext): Promise<unknown>;
  set(cacheKey: string, data: unknown, ctx: NextCacheHandlerContext): Promise<void>;
  revalidateTag(tags: string | string[]): Promise<void>;
  resetRequestCache?(): void;
}

export interface NextCacheHandlerOptions {
  /** Cache instance backing the handler. Defaults to the default cache. */
  cache?: CacheInstance;
  /** Namespace inside the instance. Default `"next"`. */
  namespace?: string;
  /** Tags applied to every entry (for example `["next"]`). */
  defaultTags?: string[];
}

/**
 * Bridges a `rsc-cache` instance into Next.js as a `CacheHandler`.
 *
 * ```js
 * // next.config.mjs
 * import { createCache } from "rsc-cache";
 * import { createRedisStorage } from "rsc-cache/redis";
 * import { createNextCacheHandler } from "rsc-cache/next";
 *
 * const cache = createCache({ namespace: "next", storage: createRedisStorage({ client }) });
 *
 * export default {
 *   cacheComponents: true,
 *   cacheHandlers: { default: createNextCacheHandler({ cache }) },
 * };
 * ```
 */
export function createNextCacheHandler(
  options: NextCacheHandlerOptions = {},
): NextCacheHandlerLike {
  const cache = options.cache ?? getCache();
  const namespace = options.namespace ?? "next";
  const defaultTags = options.defaultTags ?? [];

  return {
    async get(cacheKey: string, ctx?: NextCacheHandlerContext): Promise<unknown> {
      const value = await cache.get(cacheKey, {
        namespace,
        ...(ctx?.kind === "FETCH" ? { allowStale: true } : {}),
      });
      return value === undefined ? null : value;
    },

    async set(cacheKey: string, data: unknown, ctx: NextCacheHandlerContext): Promise<void> {
      await cache.set(cacheKey, data, {
        namespace,
        ...(typeof ctx.revalidate === "number" ? { ttl: ctx.revalidate * 1000 } : {}),
        tags: [...new Set([...defaultTags, ...(ctx.tags ?? [])])],
      });
    },

    async revalidateTag(tags: string | string[]): Promise<void> {
      const list = Array.isArray(tags) ? tags : [tags];
      await Promise.all(list.map((tag) => cache.revalidateTag(tag)));
    },

    resetRequestCache(): void {
      // Next calls this between requests. Request-scoped memoization lives in
      // the request context (see `withCacheContext`), so there is nothing to
      // reset here.
    },
  };
}

/**
 * Warming helpers.
 *
 * ```ts
 * await prefetch(getProduct, "123");
 * await warmup([() => getProduct("1"), () => getProduct("2")], { concurrency: 4 });
 * ```
 */

import type {
  AnyFunction,
  CachedFunction,
  PrefetchResult,
  WarmupOptions,
  WarmupResult,
} from "./types.js";

/**
 * Populates the cache for a cached function without losing type safety.
 *
 * Equivalent to calling the function, but expresses intent (warming, prefetching
 * during build or in a cron job) and works with any cached function.
 */
export async function prefetch<F extends AnyFunction>(
  cachedFn: CachedFunction<F>,
  ...args: Parameters<F>
): Promise<Awaited<ReturnType<F>>> {
  const handle = cachedFn as Partial<CachedFunction<F>>;
  if (typeof handle.prefetch === "function") {
    return handle.prefetch(...args);
  }
  return (await cachedFn(...args)) as Awaited<ReturnType<F>>;
}

/**
 * Like {@link prefetch} but reports where the value came from.
 *
 * Reads the entry through the cache instance first, so a warm entry causes no
 * source call at all (useful to build warmup dashboards).
 */
export async function prefetchDetailed<F extends AnyFunction>(
  cachedFn: CachedFunction<F>,
  ...args: Parameters<F>
): Promise<PrefetchResult<Awaited<ReturnType<F>>>> {
  const handle = cachedFn as CachedFunction<F>;
  const existing = await handle.instance.get<Awaited<ReturnType<F>>>(handle.key(...args), {
    allowStale: true,
  });
  if (existing !== undefined) {
    return { value: existing, hit: true, source: "cache" };
  }
  const value = await prefetch(cachedFn, ...args);
  return { value, hit: false, source: "source" };
}

/**
 * Runs several cache-warming tasks with bounded concurrency.
 *
 * Failures are collected instead of aborting the whole warmup (a single broken
 * key should not stop a build step or a cron job).
 */
export async function warmup(
  tasks: ReadonlyArray<() => Promise<unknown>>,
  options: WarmupOptions = {},
): Promise<WarmupResult> {
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const continueOnError = options.continueOnError ?? true;
  const startedAt = Date.now();

  const errors: Array<{ index: number; error: Error }> = [];
  let succeeded = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (!task) {
        return;
      }
      try {
        await task();
        succeeded += 1;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        errors.push({ index, error: normalized });
        if (!continueOnError) {
          throw normalized;
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  const results = await Promise.allSettled(workers);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected && rejected.status === "rejected") {
    throw rejected.reason as Error;
  }

  return {
    total: tasks.length,
    succeeded,
    failed: errors.length,
    duration: Date.now() - startedAt,
    errors,
  };
}

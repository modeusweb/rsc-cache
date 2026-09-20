import { describe, expect, it, vi } from "vitest";
import { withCacheContext } from "../src/context.js";
import { createTestCache, getEntryInfo } from "../src/testing/index.js";
import type { CacheEvent } from "../src/types.js";

describe("stale-while-revalidate", () => {
  it("serves the stale value immediately and refreshes in the background", async () => {
    const { cache, advanceTime } = createTestCache();
    let version = 1;
    const get = cache.cache(async (id: string) => `${id}@v${version}`, {
      ttl: "1m",
      staleTtl: "10m",
    });

    expect(await get("1")).toBe("1@v1");
    version = 2;
    await advanceTime(2 * 60_000);

    const started = Date.now();
    expect(await get("1")).toBe("1@v1");
    // Not blocked by the refresh.
    expect(Date.now() - started).toBeLessThan(20);

    await cache.flushBackgroundTasks();
    expect(await get("1")).toBe("1@v2");
    expect(cache.stats().backgroundRevalidations).toBe(1);
    await cache.dispose();
  });

  it("runs one background revalidation for many concurrent stale readers", async () => {
    const { cache, advanceTime } = createTestCache();
    const source = vi.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return `${id}-fresh`;
    });
    const get = cache.cache(source, { ttl: "1m", staleTtl: "10m" });

    await get("1");
    await advanceTime(2 * 60_000);
    expect(source).toHaveBeenCalledTimes(1);

    const results = await Promise.all(Array.from({ length: 25 }, () => get("1")));
    expect(results.every((value) => value === "1-fresh")).toBe(true);

    await cache.flushBackgroundTasks();
    // One initial call + one revalidation, however many readers there were.
    expect(source).toHaveBeenCalledTimes(2);
    expect(cache.stats().backgroundRevalidations).toBe(1);
    await cache.dispose();
  });

  it("keeps serving the stale value when a background refresh fails", async () => {
    const events: CacheEvent[] = [];
    const { cache, advanceTime } = createTestCache({ onEvent: (event) => events.push(event) });
    let failing = false;
    const get = cache.cache(
      async (id: string) => {
        if (failing) {
          throw new Error("refresh failed");
        }
        return `${id}-value`;
      },
      { ttl: "1m", staleTtl: "10m" },
    );

    await get("1");
    failing = true;
    await advanceTime(2 * 60_000);

    expect(await get("1")).toBe("1-value");
    await cache.flushBackgroundTasks();

    const error = events.find(
      (event) => event.type === "error" && event.outcome === "background-revalidation-failed",
    );
    expect(error?.error?.message).toBe("refresh failed");

    failing = false;
    expect(await get("1")).toBe("1-value");
    await cache.dispose();
  });

  it("blocks on revalidation when revalidate is 'blocking'", async () => {
    const { cache, advanceTime } = createTestCache();
    let version = 1;
    const get = cache.cache(async (id: string) => `${id}@v${version}`, {
      ttl: "1m",
      staleTtl: "10m",
      revalidate: "blocking",
    });

    await get("1");
    version = 2;
    await advanceTime(2 * 60_000);

    expect(await get("1")).toBe("1@v2");
    expect(cache.stats().backgroundRevalidations).toBe(0);
    expect(cache.stats().staleHits).toBe(1);
    await cache.dispose();
  });

  it("serves stale data when a blocking revalidation fails (default)", async () => {
    const { cache, advanceTime } = createTestCache();
    let failing = false;
    const get = cache.cache(
      async (id: string) => {
        if (failing) {
          throw new Error("nope");
        }
        return `${id}-ok`;
      },
      { ttl: "1m", staleTtl: "10m", revalidate: "blocking" },
    );

    await get("1");
    failing = true;
    await advanceTime(2 * 60_000);
    expect(await get("1")).toBe("1-ok");
    await cache.dispose();
  });

  it("propagates blocking revalidation failures when configured", async () => {
    const { cache, advanceTime } = createTestCache();
    let failing = false;
    const get = cache.cache(
      async (id: string) => {
        if (failing) {
          throw new Error("strict failure");
        }
        return `${id}-ok`;
      },
      { ttl: "1m", staleTtl: "10m", revalidate: "blocking", onRevalidationError: "throw" },
    );

    await get("1");
    failing = true;
    await advanceTime(2 * 60_000);
    await expect(get("1")).rejects.toThrow("strict failure");
    await cache.dispose();
  });

  it("keeps a background refresh alive when the request that started it is cancelled", async () => {
    const { cache, advanceTime } = createTestCache();
    let version = 1;
    const get = cache.cache(
      async (id: string) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return `${id}@v${version}`;
      },
      { ttl: "1m", staleTtl: "10m" },
    );

    await get("1");
    version = 2;
    await advanceTime(2 * 60_000);

    const controller = new AbortController();
    const stale = await withCacheContext({ signal: controller.signal }, () => get("1"));
    expect(stale).toBe("1@v1");
    controller.abort();

    await cache.flushBackgroundTasks();
    expect(await get("1")).toBe("1@v2");
    await cache.dispose();
  });

  it("hands background tasks to the runtime through waitUntil", async () => {
    const tasks: Array<Promise<void>> = [];
    const { cache, advanceTime } = createTestCache({
      backgroundTasks: { waitUntil: (task) => tasks.push(task) },
    });
    const get = cache.cache(async (id: string) => `${id}-v`, { ttl: "1m", staleTtl: "10m" });

    await get("1");
    await advanceTime(2 * 60_000);
    await get("1");

    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    await cache.dispose();
  });

  it("stops treating an expired entry as reusable", async () => {
    const { cache, advanceTime } = createTestCache();
    const source = vi.fn(async (id: string) => `${id}-v`);
    const get = cache.cache(source, { ttl: "1m", staleTtl: "10m" });

    await get("1");
    await advanceTime(20 * 60_000);
    expect((await getEntryInfo(get, "1")).state).toBe("missing");
    await get("1");
    await cache.flushBackgroundTasks();
    expect(source).toHaveBeenCalledTimes(2);
    expect(cache.stats().backgroundRevalidations).toBe(0);
    await cache.dispose();
  });
});

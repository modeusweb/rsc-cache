import { describe, expect, it } from "vitest";
import { createCache } from "../src/create-cache.js";
import { memoryStorage } from "../src/memory.js";
import {
  createMockBackend,
  createMockStorage,
  createTestCache,
  getEntryInfo,
} from "../src/testing/index.js";
import { waitFor } from "./helpers.js";
import type { CacheEntry } from "../src/types.js";

describe("race conditions", () => {
  it("does not resurrect an invalidated entry from an in-flight write", async () => {
    const { cache } = createTestCache({ defaults: { strictInvalidation: true } });
    const pending: Array<(value: string) => void> = [];
    const get = cache.cache(
      async () => new Promise<string>((resolve) => pending.push(resolve)),
      { ttl: "1m", tags: ["products"] },
    );

    const computing = get();
    await waitFor(() => pending.length === 1);
    // The mutation lands while the source function is still running.
    await cache.revalidateTag("products");
    pending[0]?.("stale-value");

    expect(await computing).toBe("stale-value");
    expect((await getEntryInfo(get)).exists).toBe(false);
    expect(cache.stats().conflicts).toBeGreaterThan(0);
    await cache.dispose();
  });

  it("does not let a background revalidation overwrite an invalidation", async () => {
    const { cache, advanceTime } = createTestCache();
    const pending: Array<(value: string) => void> = [];
    const get = cache.cache(
      async () => new Promise<string>((resolve) => pending.push(resolve)),
      { ttl: "1m", staleTtl: "10m", tags: ["products"] },
    );

    const first = get();
    await waitFor(() => pending.length === 1);
    pending[0]?.("v1");
    expect(await first).toBe("v1");

    await advanceTime(2 * 60_000);
    // A stale read triggers a background refresh which is still running...
    expect(await get()).toBe("v1");
    await waitFor(() => pending.length === 2);
    await cache.revalidateTag("products");
    pending[1]?.("v2");
    await cache.flushBackgroundTasks();

    // ...and its result must not bring the invalidated entry back.
    expect((await getEntryInfo(get)).exists).toBe(false);
    await cache.dispose();
  });

  it("removes the entry when the invalidation happens after the write", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (id: string) => id, { ttl: "1m", tags: (id) => [`item:${id}`] });

    await get("1");
    await cache.revalidateTag("item:1");
    expect((await getEntryInfo(get, "1")).exists).toBe(false);
    await cache.dispose();
  });

  it("rejects the older of two concurrent revalidations (compare-and-set)", async () => {
    const backend = createMockBackend();
    const storageA = createMockStorage({ backend, name: "process-a" });
    const storageB = createMockStorage({ backend, name: "process-b" });
    const cacheA = createCache({ storage: storageA, namespace: "race", register: false });
    const cacheB = createCache({ storage: storageB, namespace: "race", register: false });

    const getA = cacheA.cache(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return "slow-value";
      },
      { ttl: "1m", name: "raceFn" },
    );
    const getB = cacheB.cache(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "fast-value";
      },
      { ttl: "1m", name: "raceFn" },
    );

    const [slow, fast] = await Promise.all([getA(), getB()]);
    expect(slow).toBe("slow-value");
    expect(fast).toBe("fast-value");

    // The fast writer won; the slow one was rejected instead of overwriting it.
    expect(await getB()).toBe("fast-value");
    expect(cacheA.stats().conflicts).toBeGreaterThan(0);

    await cacheA.dispose();
    await cacheB.dispose();
  });

  it("allows exactly one writer per revision", async () => {
    const storage = memoryStorage();
    const makeEntry = (revision: number): CacheEntry => ({
      value: new Uint8Array([revision]),
      createdAt: Date.now(),
      expiresAt: Infinity,
      revision,
    });

    const first = await storage.compareAndSet!("k", makeEntry(1), null);
    const second = await storage.compareAndSet!("k", makeEntry(1), null);
    expect(first).toBe(true);
    expect(second).toBe(false);

    const wrongRevision = await storage.compareAndSet!("k", makeEntry(5), 3);
    expect(wrongRevision).toBe(false);

    const rightRevision = await storage.compareAndSet!("k", makeEntry(2), 1);
    expect(rightRevision).toBe(true);
    await storage.close?.();
  });

  it("bumps the revision on every write", async () => {
    const { cache } = createTestCache();
    let version = 1;
    const get = cache.cache(async () => `v${version}`, { ttl: "1m" });

    await get();
    const first = await getEntryInfo(get);
    version = 2;
    await get.revalidate();
    const second = await getEntryInfo(get);
    version = 3;
    await get.revalidate();
    const third = await getEntryInfo(get);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(third.revision).toBe(3);
    expect(await get()).toBe("v3");
    await cache.dispose();
  });

  it("forces a recomputation through revalidate()", async () => {
    const { cache } = createTestCache();
    let calls = 0;
    const get = cache.cache(async () => {
      calls += 1;
      return calls;
    }, { ttl: "10m" });

    expect(await get()).toBe(1);
    expect(await get.revalidate()).toBe(2);
    expect(await get()).toBe(2);
    expect(calls).toBe(2);
    await cache.dispose();
  });
});

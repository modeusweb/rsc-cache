import { describe, expect, it, vi } from "vitest";
import { createCache } from "../src/create-cache.js";
import { warmUpContextStore, withCacheContext } from "../src/context.js";
import { CacheLockError } from "../src/errors.js";
import { createMockBackend, createMockStorage, createTestCache } from "../src/testing/index.js";

describe("single-flight", () => {
  it("coalesces 100 concurrent calls into one source call", async () => {
    const { cache } = createTestCache();
    const source = vi.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id };
    });
    const get = cache.cache(source, { ttl: "1m" });

    const results = await Promise.all(Array.from({ length: 100 }, () => get("42")));

    expect(results).toHaveLength(100);
    expect(results.every((value) => value.id === "42")).toBe(true);
    expect(source).toHaveBeenCalledTimes(1);
    expect(cache.diagnostics().inflight).toBe(0);

    await cache.dispose();
  });

  it("coalesces concurrent calls per key across many keys", async () => {
    const { cache } = createTestCache();
    const source = vi.fn(async (id: string) => id);
    const get = cache.cache(source, { ttl: "1m" });

    const keys = Array.from({ length: 10 }, (_, index) => `key-${index}`);
    const calls = keys.flatMap((key) => Array.from({ length: 10 }, () => get(key)));
    const results = await Promise.all(calls);

    expect(new Set(results).size).toBe(10);
    expect(source).toHaveBeenCalledTimes(10);
    await cache.dispose();
  });

  it("does not cancel shared work when one consumer leaves", async () => {
    await warmUpContextStore();
    const { cache } = createTestCache();
    const aborted: boolean[] = [];
    let started = 0;

    const get = cache.cache(
      async (id: string, signal?: AbortSignal) => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        aborted.push(signal?.aborted === true);
        return `${id}-done`;
      },
      { ttl: "1m", passSignal: true },
    );

    const first = new AbortController();
    const second = new AbortController();

    const leaving = withCacheContext({ signal: first.signal }, async () => {
      try {
        return await get("1");
      } catch {
        return "aborted";
      }
    });
    const staying = withCacheContext({ signal: second.signal }, () => get("1"));

    await new Promise((resolve) => setTimeout(resolve, 5));
    first.abort();

    await expect(leaving).resolves.toBe("aborted");
    await expect(staying).resolves.toBe("1-done");
    // The shared computation finished normally for the remaining consumer.
    expect(aborted).toEqual([false]);
    expect(started).toBe(1);

    await cache.dispose();
  });

  it("shares a pending computation with late callers", async () => {
    const { cache } = createTestCache();
    const source = vi.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return id;
    });
    const get = cache.cache(source, { ttl: "1m" });

    const first = get("1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = get("1");
    expect(cache.diagnostics().inflight).toBe(1);
    expect(await Promise.all([first, second])).toEqual(["1", "1"]);
    expect(source).toHaveBeenCalledTimes(1);

    await cache.dispose();
  });
});

describe("distributed single-flight", () => {
  it("lets a second process reuse the value of the first one", async () => {
    const backend = createMockBackend();
    const processA = createMockStorage({ backend, name: "mock-a" });
    const processB = createMockStorage({ backend, name: "mock-b" });

    const lock = { ttl: "5s" as const, wait: "2s" as const, pollInterval: "5ms" as const };
    const cacheA = createCache({
      storage: processA,
      namespace: "shared",
      register: false,
      distributedLock: lock,
    });
    const cacheB = createCache({
      storage: processB,
      namespace: "shared",
      register: false,
      distributedLock: lock,
    });

    const sourceA = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "from-a";
    });
    const sourceB = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "from-b";
    });

    // Identical name + source-less identity would differ, so the key is pinned.
    const getA = cacheA.cache(sourceA, { ttl: "1m", name: "sharedFn" });
    const getB = cacheB.cache(sourceB, { ttl: "1m", name: "sharedFn" });

    const [a, b] = await Promise.all([getA(), getB()]);

    expect(a).toBe("from-a");
    // The second process waited for the lock, then read the populated entry.
    expect(b).toBe("from-a");
    expect(sourceB).not.toHaveBeenCalled();
    expect(cacheB.stats().hits).toBe(1);

    await cacheA.dispose();
    await cacheB.dispose();
  });

  it("computes locally when the lock cannot be acquired (fail-open)", async () => {
    const backend = createMockBackend();
    const storage = createMockStorage({ backend });
    // A stale lock held by a crashed process.
    backend.locks.set("held", { token: "other", expiresAt: Date.now() + 60_000 });

    const cache = createCache({
      storage,
      namespace: "locked",
      register: false,
      distributedLock: { ttl: "1s", wait: "20ms", pollInterval: "5ms" },
    });
    const get = cache.cache(async () => "computed", { ttl: "1m" });

    expect(await get()).toBe("computed");
    await cache.dispose();
  });

  it("throws a CacheLockError when configured to fail closed", async () => {
    const storage = createMockStorage();
    const cache = createCache({
      storage,
      namespace: "locked-strict",
      register: false,
      distributedLock: { ttl: "5s", wait: "10ms", pollInterval: "2ms", failure: "throw" },
    });

    // Simulate a lock held by another process.
    let holding = true;
    const original = storage.acquireLock!.bind(storage);
    storage.acquireLock = async (key, options) => (holding ? null : original(key, options));

    const get = cache.cache(async () => "never", { ttl: "1m" });
    await expect(get()).rejects.toThrowError(CacheLockError);

    holding = false;
    expect(await get()).toBe("never");
    await cache.dispose();
  });

  it("does not use locks when the storage cannot lock", async () => {
    const storage = createMockStorage({ locks: false });
    const cache = createCache({
      storage,
      namespace: "nolock",
      register: false,
      distributedLock: true,
    });
    const get = cache.cache(async () => "ok", { ttl: "1m" });

    expect(await get()).toBe("ok");
    expect(cache.stats().locks).toBe(0);
    await cache.dispose();
  });
});

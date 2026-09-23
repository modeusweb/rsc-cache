import { describe, expect, it } from "vitest";
import { CacheLockError } from "../src/errors.js";
import { createRedisStorage } from "../src/redis.js";
import { createFakeRedisClient, createTestCache } from "../src/testing/index.js";
import type { CacheEntry } from "../src/types.js";

const makeEntry = (value: string, extra: Partial<CacheEntry> = {}): CacheEntry => ({
  value: new TextEncoder().encode(JSON.stringify(value)),
  createdAt: 0,
  expiresAt: Number.POSITIVE_INFINITY,
  revision: 1,
  ...extra,
});

describe("redis storage", () => {
  it("round-trips entries and respects TTL", async () => {
    const client = createFakeRedisClient();
    const storage = createRedisStorage({ client });

    await storage.set("entry:1", makeEntry("a"), { ttlMs: 60_000 });
    expect(await storage.get("entry:1")).not.toBeNull();
    expect(await storage.has("entry:1")).toBe(true);

    client.advanceTime(61_000);
    expect(await storage.get("entry:1")).toBeNull();
  });

  it("invalidates tags through the Lua script path", async () => {
    const client = createFakeRedisClient();
    const storage = createRedisStorage({ client });

    await storage.set("k1", makeEntry("a"));
    await storage.set("k2", makeEntry("b"));
    await storage.set("k3", makeEntry("c"));
    await storage.addTags!("k1", ["products"]);
    await storage.addTags!("k2", ["products", "featured"]);

    await storage.invalidateTag!("products");

    expect(await storage.get("k1")).toBeNull();
    expect(await storage.get("k2")).toBeNull();
    expect(await storage.get("k3")).not.toBeNull();
  });

  it("drops stale tag memberships when an entry is rewritten without tags", async () => {
    for (const atomic of [true, false]) {
      const client = createFakeRedisClient({ withEval: atomic });
      const storage = createRedisStorage({ client, atomic });

      await storage.set("k", makeEntry("a"));
      await storage.addTags!("k", ["old-tag"]);
      // Rewrite without tags: the entry must leave the old tag index...
      await storage.set("k", makeEntry("b", { revision: 2 }));
      // ...so invalidating the old tag must not delete the entry anymore.
      await storage.invalidateTag!("old-tag");
      expect(await storage.get("k"), `atomic=${atomic}`).not.toBeNull();
    }
  });

  it("supports the non-atomic (no eval) path", async () => {
    const client = createFakeRedisClient({ withEval: false });
    const storage = createRedisStorage({ client, atomic: false });
    expect(storage.usesLua).toBe(false);

    await storage.set("k1", makeEntry("a"));
    expect((await storage.get("k1"))?.value).toEqual(makeEntry("a").value);
  });

  it("acquires and releases distributed locks with exclusivity", async () => {
    const client = createFakeRedisClient();
    const storage = createRedisStorage({ client });

    const lock = await storage.acquireLock!("lock:1", { ttlMs: 5_000 });
    expect(lock).not.toBeNull();

    const blocked = await storage.acquireLock!("lock:1", { ttlMs: 5_000 });
    expect(blocked).toBeNull();

    await lock!.release();
    const again = await storage.acquireLock!("lock:1", { ttlMs: 5_000 });
    expect(again).not.toBeNull();
    await again!.release();
  });

  it("expired locks can be re-acquired", async () => {
    const client = createFakeRedisClient();
    const storage = createRedisStorage({ client });

    const lock = await storage.acquireLock!("lock:2", { ttlMs: 100 });
    expect(lock).not.toBeNull();
    client.advanceTime(150);

    const next = await storage.acquireLock!("lock:2", { ttlMs: 5_000 });
    expect(next).not.toBeNull();
  });

  it("clears the namespace", async () => {
    const client = createFakeRedisClient();
    const storage = createRedisStorage({ client, namespace: "ns" });

    const entryKey = "rsc-cache:v1:ns:e1";
    await storage.set(entryKey, makeEntry("1"));
    await storage.set("rsc-cache:v1:ns:e2", makeEntry("2"));
    await storage.clear({ namespace: "ns" });

    expect(await storage.get(entryKey)).toBeNull();
    expect(await storage.get("rsc-cache:v1:ns:e2")).toBeNull();
  });

  it("deletes entries", async () => {
    const client = createFakeRedisClient();
    const storage = createRedisStorage({ client });

    await storage.set("k", makeEntry("v"));
    await storage.delete("k");
    expect(await storage.has("k")).toBe(false);
  });
});

describe("cache on redis storage", () => {
  it("behaves as a persistent cache with tag invalidation", async () => {
    const client = createFakeRedisClient();
    const { cache, clock, dispose } = createTestCache({ storage: createRedisStorage({ client }) });

    let calls = 0;
    const getProduct = cache.cache(async (id: string) => {
      calls += 1;
      return { id, calls };
    }, { ttl: "5m", tags: (id) => [`product:${id}`] });

    await getProduct("123");
    clock.advance(60_000);
    await getProduct("123");
    expect(calls).toBe(1);

    const { revalidateTag } = await import("../src/invalidation.js");
    await revalidateTag("product:123", { cache });
    await getProduct("123");
    expect(calls).toBe(2);

    await dispose();
  });

  it("survives fail-open when redis is unavailable", async () => {
    const client = createFakeRedisClient();
    const failing = createRedisStorage({ client });
    failing.get = async () => {
      throw new Error("redis is down");
    };

    const { cache, dispose } = createTestCache({ storage: failing });
    let calls = 0;
    const get = cache.cache(async () => {
      calls += 1;
      return "source";
    }, { ttl: "1m" });

    expect(await get()).toBe("source");
    expect(calls).toBe(1);
    await dispose();
  });

  it("can be configured fail-closed for lock timeouts", async () => {
    const client = createFakeRedisClient();
    const storage = createRedisStorage({ client });
    const { cache, dispose } = createTestCache({
      storage,
      distributedLock: { ttl: "1s", wait: "5ms", pollInterval: "1ms", failure: "throw" },
    });

    const get = cache.cache(async () => "never", { ttl: "1m" });

    // First pass: capture the exact lock key the runtime uses, then roll back.
    const original = storage.acquireLock!.bind(storage);
    let runtimeLockKey: string | undefined;
    storage.acquireLock = async (key, options) => {
      runtimeLockKey ??= key;
      return original(key, options);
    };
    expect(await get()).toBe("never");
    storage.acquireLock = original;
    await storage.delete(get.key());

    // Hold the distributed lock on that key, like another process would.
    await original(runtimeLockKey!, { ttlMs: 60_000 });

    await expect(get()).rejects.toThrowError(CacheLockError);
    await dispose();
  });
});

import { describe, expect, it } from "vitest";
import {
  createCacheContext,
  createRequestCache,
  getCacheContext,
  warmUpContextStore,
  withCacheContext,
} from "../src/context.js";
import { CacheKeyError } from "../src/errors.js";
import { createMockStorage, createTestCache } from "../src/testing/index.js";
import type { CacheEvent } from "../src/types.js";

describe("request context", () => {
  it("memoizes inside one request and starts fresh in the next one", async () => {
    await warmUpContextStore();
    const storage = createMockStorage();
    const { cache } = createTestCache({ storage });
    const get = cache.cache(async (id: string) => `value-${id}`, { ttl: "10m" });

    await withCacheContext({ requestId: "r1" }, async () => {
      expect(await get("1")).toBe("value-1");
      const readsAfterFirstCall = storage.counters.get;
      expect(await get("1")).toBe("value-1");
      // The second call was answered from the request memo: no extra reads.
      expect(storage.counters.get).toBe(readsAfterFirstCall);
    });

    await withCacheContext({ requestId: "r2" }, async () => {
      expect(await get("1")).toBe("value-1");
    });

    await cache.dispose();
  });

  it("can be told not to use the request memo", async () => {
    await warmUpContextStore();
    const storage = createMockStorage();
    const { cache } = createTestCache({ storage });
    const get = cache.cache(async (id: string) => `value-${id}`, {
      ttl: "10m",
      requestMemo: false,
    });

    await withCacheContext({ requestId: "r1" }, async () => {
      await get("1");
      const readsAfterFirstCall = storage.counters.get;
      await get("1");
      // Without the request memo the second call reads storage again.
      expect(storage.counters.get).toBeGreaterThan(readsAfterFirstCall);
    });

    await cache.dispose();
  });

  it("merges nested contexts", async () => {
    await warmUpContextStore();
    const seen: Array<{ userId?: string; locale?: string; requestId?: string }> = [];
    await withCacheContext({ requestId: "req", userId: "u1" }, async () => {
      await withCacheContext({ locale: "de" }, async () => {
        const context = getCacheContext();
        seen.push({
          requestId: context.requestId,
          userId: context.userId,
          locale: context.locale,
        });
      });
      const outer = getCacheContext();
      seen.push({ requestId: outer.requestId, userId: outer.userId, locale: outer.locale });
    });

    expect(seen[0]).toEqual({ requestId: "req", userId: "u1", locale: "de" });
    expect(seen[1]?.userId).toBe("u1");
    expect(getCacheContext().userId).toBeUndefined();
  });

  it("keeps concurrent request contexts apart", async () => {
    await warmUpContextStore();
    const { cache } = createTestCache();
    const get = cache.cache(async () => "dashboard", {
      ttl: "1m",
      scope: ({ context }) => context.userId,
      requestMemo: false,
    });

    const render = async (userId: string): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, userId === "slow" ? 15 : 1));
      return withCacheContext({ userId }, () => get());
    };

    const [slow, fast] = await Promise.all([render("slow"), render("fast")]);
    expect(slow).toBe("dashboard");
    expect(fast).toBe("dashboard");

    // Two distinct scopes -> two distinct entries.
    expect(cache.stats().misses).toBe(2);
    await cache.dispose();
  });

  it("exposes a request cache helper", () => {
    const requestCache = createRequestCache();
    const first = requestCache.run("k", ["tag"], () => Promise.resolve(1));
    const second = requestCache.run("k", ["tag"], () => Promise.resolve(2));
    expect(first).toBe(second);
    expect(requestCache.size).toBe(1);

    requestCache.evictByTags(["tag"]);
    expect(requestCache.size).toBe(0);

    const context = createCacheContext({ userId: "u" });
    expect(context.userId).toBe("u");
    expect(context.requestCache?.size).toBe(0);
  });
});

describe("scoping", () => {
  it("isolates entries per user", async () => {
    await warmUpContextStore();
    const { cache } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async () => {
        calls += 1;
        return `dashboard-${calls}`;
      },
      { ttl: "1m", scope: ({ context }) => context.userId, requestMemo: false },
    );

    const forUser = (userId: string): Promise<string> => withCacheContext({ userId }, () => get());

    expect(await forUser("u1")).toBe("dashboard-1");
    expect(await forUser("u2")).toBe("dashboard-2");
    expect(await forUser("u1")).toBe("dashboard-1");
    expect(calls).toBe(2);
    await cache.dispose();
  });

  it("isolates entries per tenant with an array scope", async () => {
    await warmUpContextStore();
    const { cache } = createTestCache();
    const get = cache.cache(async () => "report", {
      ttl: "1m",
      scope: ({ context }) => [context.tenantId, context.userId],
      requestMemo: false,
    });

    await withCacheContext({ tenantId: "t1", userId: "u1" }, () => get());
    await withCacheContext({ tenantId: "t1", userId: "u2" }, () => get());
    await withCacheContext({ tenantId: "t1", userId: "u1" }, () => get());

    expect(cache.stats().misses).toBe(2);
    expect(cache.stats().hits).toBe(1);
    await cache.dispose();
  });

  it("refuses to cache private data without a scope", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async () => "secret", { ttl: "1m", visibility: "private" });
    await expect(get()).rejects.toThrowError(CacheKeyError);
    await cache.dispose();
  });

  it("treats an empty scope resolution for private data as an error", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async () => "secret", { ttl: "1m", scope: () => undefined });
    await expect(get()).rejects.toThrowError(CacheKeyError);
    await cache.dispose();
  });

  it("isolates by namespace inside one instance", async () => {
    const { cache } = createTestCache();
    const a = cache.cache(async () => "a", { ttl: "1m", namespace: "ns-a" });
    const b = cache.cache(async () => "b", { ttl: "1m", namespace: "ns-b" });

    expect(await a()).toBe("a");
    expect(await b()).toBe("b");
    expect(a.key()).toContain(":ns-a:");
    expect(b.key()).toContain(":ns-b:");
    await cache.dispose();
  });

  it("reports the request id in events", async () => {
    await warmUpContextStore();
    const events: CacheEvent[] = [];
    const { cache } = createTestCache({ onEvent: (event) => events.push(event) });
    const get = cache.cache(async (id: string) => id, { ttl: "1m" });

    await withCacheContext({ requestId: "trace-1" }, async () => {
      await get("1");
    });

    expect(events.some((event) => event.requestId === "trace-1")).toBe(true);
    await cache.dispose();
  });

  it("accepts a request cache or a context object as the first argument", async () => {
    await warmUpContextStore();
    const context = createCacheContext({ tenantId: "t1" });
    const requestCache = createRequestCache();

    await withCacheContext(context, async () => {
      expect(getCacheContext().tenantId).toBe("t1");
    });
    await withCacheContext(requestCache, async () => {
      expect(getCacheContext().requestCache).toBe(requestCache);
    });
  });

  it("keeps scoped entries invalidatable by tag", async () => {
    await warmUpContextStore();
    const { cache } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async () => {
        calls += 1;
        return "scoped";
      },
      {
        ttl: "1m",
        scope: ({ context }) => context.userId,
        tags: () => ["user-dashboard"],
        requestMemo: false,
      },
    );

    await withCacheContext({ userId: "u1" }, () => get());
    expect(calls).toBe(1);
    const invalidated = await cache.invalidate({ tags: ["user-dashboard"] });
    expect(invalidated.tags).toBe(1);
    await withCacheContext({ userId: "u1" }, () => get());
    expect(calls).toBe(2);
    await cache.dispose();
  });
});

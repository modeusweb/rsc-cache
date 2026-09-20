import { describe, expect, it, vi } from "vitest";
import { warmUpContextStore, withCacheContext } from "../src/context.js";
import { CacheError, CacheSerializationError } from "../src/errors.js";
import { createTestCache, getEntryInfo } from "../src/testing/index.js";
import type { CacheEvent } from "../src/types.js";

describe("basic caching", () => {
  it("enables async context propagation for the suite", async () => {
    await expect(warmUpContextStore()).resolves.toBe(true);
  });

  it("runs the source on a miss and serves the value from the cache on a hit", async () => {
    const { cache } = createTestCache();
    const calls: string[] = [];
    const getProduct = cache.cache(
      async (id: string) => {
        calls.push(id);
        return { id, name: `Product ${id}` };
      },
      { ttl: "5m" },
    );

    const first = await getProduct("1");
    const second = await getProduct("1");

    expect(calls).toEqual(["1"]);
    expect(second).toEqual(first);
    // Values are serialized: consumers always get their own copy.
    expect(second).not.toBe(first);

    const stats = cache.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.revalidations).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5);
    expect(stats.lookups).toBe(2);

    await cache.dispose();
  });

  it("keeps arguments apart (different keys, no cross talk)", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (id: string, locale: string) => `${id}:${locale}`, {
      ttl: "1m",
    });

    expect(await get("1", "en")).toBe("1:en");
    expect(await get("1", "de")).toBe("1:de");
    expect(await get("1", "en")).toBe("1:en");
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(2);

    await cache.dispose();
  });

  it("expires entries after the ttl", async () => {
    const { cache, advanceTime } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return `${id}#${calls}`;
      },
      { ttl: "5m" },
    );

    expect(await get("1")).toBe("1#1");
    expect(await get("1")).toBe("1#1");
    await advanceTime(5 * 60_000);
    expect(await get("1")).toBe("1#2");
    expect(calls).toBe(2);

    await cache.dispose();
  });

  it("caches forever when no ttl is configured", async () => {
    const { cache, advanceTime } = createTestCache();
    let calls = 0;
    const get = cache.cache(async () => {
      calls += 1;
      return calls;
    });

    await get();
    await advanceTime(365 * 24 * 3_600_000);
    expect(await get()).toBe(1);
    expect(calls).toBe(1);

    await cache.dispose();
  });

  it("deletes an entry on demand", async () => {
    const { cache } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return `${id}#${calls}`;
      },
      { ttl: "1m" },
    );

    await get("1");
    expect((await getEntryInfo(get, "1")).exists).toBe(true);
    await get.invalidate("1");
    expect((await getEntryInfo(get, "1")).exists).toBe(false);
    expect(await get("1")).toBe("1#2");
    expect(cache.stats().deletes).toBe(1);

    await cache.dispose();
  });

  it("does not cache null/undefined unless asked to", async () => {
    const { cache } = createTestCache();
    let calls = 0;
    const missing = cache.cache(
      async (id: string) => {
        calls += 1;
        return id === "missing" ? null : { id };
      },
      { ttl: "1m" },
    );

    expect(await missing("missing")).toBeNull();
    expect(await missing("missing")).toBeNull();
    expect(calls).toBe(2);
    expect(cache.stats().skipped).toBe(0);

    const negative = cache.cache(
      async (id: string) => {
        calls += 1;
        return id === "missing" ? null : { id };
      },
      { ttl: "1m", cacheNull: true },
    );

    expect(await negative("missing")).toBeNull();
    expect(await negative("missing")).toBeNull();
    expect(calls).toBe(3);
    const info = await getEntryInfo(negative, "missing");
    expect(info.state).toBe("fresh");

    await cache.dispose();
  });

  it("caches errors only when cacheErrors is enabled", async () => {
    const { cache } = createTestCache();
    let calls = 0;
    const failing = cache.cache(
      async () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
      { ttl: "1m" },
    );

    await expect(failing()).rejects.toThrow("boom 1");
    await expect(failing()).rejects.toThrow("boom 2");
    expect(calls).toBe(2);

    const cached = cache.cache(
      async () => {
        calls += 1;
        throw new Error(`cached boom ${calls}`);
      },
      { ttl: "1m", cacheErrors: true, errorTtl: "10s" },
    );

    await expect(cached()).rejects.toThrow("cached boom 3");
    await expect(cached()).rejects.toThrow("cached boom 3");
    expect(calls).toBe(3);
    // Served from the cache: counted as a hit with the error state.
    expect(cache.stats().hits).toBe(1);

    await cache.dispose();
  });

  it("rethrows cached errors as Error instances", async () => {
    const { cache } = createTestCache();
    const failing = cache.cache(
      async () => {
        throw new TypeError("nope");
      },
      { ttl: "1m", cacheErrors: true },
    );

    await expect(failing()).rejects.toThrowError(TypeError);
    const second = await failing().catch((error: unknown) => error);
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).name).toBe("TypeError");
    expect((second as Error).message).toBe("nope");

    await cache.dispose();
  });

  it("bypasses the cache when disabled at runtime", async () => {
    const { cache } = createTestCache();
    let enabled = false;
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return `${id}#${calls}`;
      },
      { ttl: "1m", enabled: () => enabled },
    );

    expect(await get("1")).toBe("1#1");
    expect(await get("1")).toBe("1#2");
    expect(cache.stats().bypasses).toBe(2);

    enabled = true;
    expect(await get("1")).toBe("1#3");
    expect(await get("1")).toBe("1#3");
    expect(calls).toBe(3);

    await cache.dispose();
  });

  it("skips values larger than maxValueSize and still returns them", async () => {
    const { cache } = createTestCache();
    const big = cache.cache(async () => "x".repeat(2048), { ttl: "1m", maxValueSize: 512 });

    expect((await big()).length).toBe(2048);
    expect((await getEntryInfo(big)).exists).toBe(false);
    expect(cache.stats().skipped).toBe(1);
    expect(cache.stats().errors).toBe(1);

    await cache.dispose();
  });

  it("forwards a shared abort signal to the source when passSignal is enabled", async () => {
    const { cache } = createTestCache();
    const seen: Array<AbortSignal | undefined> = [];
    const get = cache.cache(
      async (id: string, signal?: AbortSignal) => {
        seen.push(signal);
        return id;
      },
      { ttl: "1m", passSignal: true, name: "withSignal" },
    );

    await get("1");
    // A shared signal is forwarded (never the request signal itself, so one
    // consumer leaving cannot cancel work that others still await).
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(false);

    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const slow = cache.cache(
      async (id: string, signal?: AbortSignal) => {
        observed = signal;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return id;
      },
      { ttl: "1m", passSignal: true, name: "slow" },
    );

    const pending = withCacheContext({ signal: controller.signal }, async () => {
      try {
        return await slow("2");
      } catch {
        return "aborted";
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(observed?.aborted).toBe(true);
    await expect(pending).resolves.toBe("aborted");

    await cache.dispose();
  });

  it("emits structured events for misses, hits, sets and revalidations", async () => {
    const events: CacheEvent[] = [];
    const { cache } = createTestCache({ onEvent: (event) => events.push(event) });
    const get = cache.cache(async (id: string) => ({ id }), { ttl: "1m", name: "getThing" });

    await get("1");
    await get("1");

    const types = events.map((event) => event.type);
    expect(types).toContain("miss");
    expect(types).toContain("set");
    expect(types).toContain("revalidate");
    expect(types).toContain("hit");

    const hit = events.find((event) => event.type === "hit");
    expect(hit?.name).toBe("getThing");
    expect(hit?.cache).toBe("default");
    expect(hit?.keyHash).toMatch(/^[0-9a-f]{12}$/);
    // By default the full key is never exposed in events.
    expect(hit?.key).toBe(hit?.keyHash);
    expect(hit?.backend).toBe("memory");

    await cache.dispose();
  });

  it("exposes the full key in events only when exposeKeys is enabled", async () => {
    const events: CacheEvent[] = [];
    const { cache } = createTestCache({
      exposeKeys: true,
      onEvent: (event) => events.push(event),
    });
    const get = cache.cache(async (id: string) => ({ id }), { ttl: "1m" });
    await get("1");

    const setEvent = events.find((event) => event.type === "set");
    expect(setEvent?.key).toContain("rsc-cache:v1:default:");
    await cache.dispose();
  });

  it("isolates instances sharing one storage by namespace", async () => {
    const { createCache } = await import("../src/create-cache.js");
    const { createMockStorage } = await import("../src/testing/index.js");
    const storage = createMockStorage();
    const products = createCache({ namespace: "products", storage, register: false });
    const users = createCache({ namespace: "users", storage, register: false });

    const getProduct = products.cache(async () => "product", { ttl: "1m" });
    const getUser = users.cache(async () => "user", { ttl: "1m" });

    expect(await getProduct()).toBe("product");
    expect(await getUser()).toBe("user");
    expect(await getProduct()).toBe("product");
    expect(await getUser()).toBe("user");
    expect(products.stats().hits).toBe(1);
    expect(users.stats().hits).toBe(1);

    await products.dispose();
    await users.dispose();
  });

  it("counts a stale hit and a revalidation", async () => {
    const { cache, advanceTime } = createTestCache();
    const get = cache.cache(async (id: string) => `${id}:${Date.now()}`, {
      ttl: "1m",
      staleTtl: "10m",
      revalidate: "blocking",
    });

    await get("1");
    await advanceTime(90_000);
    await get("1");
    await cache.flushBackgroundTasks();

    const stats = cache.stats();
    expect(stats.staleHits).toBe(1);
    expect(stats.revalidations).toBe(2);
    await cache.dispose();
  });

  it("reports errors of the storage as fail-open by default", async () => {
    const { createMockStorage } = await import("../src/testing/index.js");
    const storage = createMockStorage();
    const { cache } = createTestCache({ storage });
    const get = cache.cache(async (id: string) => ({ id }), { ttl: "1m" });

    await get("1");
    storage.failing.reads = true;
    // A failing read must not break rendering: the source runs again.
    expect(await get("1")).toEqual({ id: "1" });
    expect(cache.stats().errors).toBeGreaterThan(0);

    await cache.dispose();
  });

  it("propagates storage failures when fail-closed is requested", async () => {
    const { createMockStorage } = await import("../src/testing/index.js");
    const storage = createMockStorage({ failReads: true });
    const { cache } = createTestCache({ storage, failureMode: "fail-closed" });
    const get = cache.cache(async (id: string) => ({ id }), { ttl: "1m" });

    await expect(get("1")).rejects.toThrowError(/Cache read failed/);
    await cache.dispose();
  });

  it("never executes the source twice for one call even if the entry is missing", async () => {
    const { cache } = createTestCache();
    const source = vi.fn(async () => 42);
    const get = cache.cache(source, { ttl: "1m" });

    const [a, b, c] = await Promise.all([get(), get(), get()]);
    expect([a, b, c]).toEqual([42, 42, 42]);
    // One database call for three concurrent misses (single-flight).
    expect(source).toHaveBeenCalledTimes(1);
    expect(cache.stats().misses).toBe(3);
    expect(cache.stats().revalidations).toBe(1);

    await cache.dispose();
  });

  it("exposes the error hierarchy", () => {
    const error = new CacheError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CacheError");
    expect(new CacheSerializationError("y").code).toBe("ERR_CACHE_SERIALIZATION");
  });
});

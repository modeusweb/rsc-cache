import { afterEach, describe, expect, it } from "vitest";
import { createCache } from "../src/create-cache.js";
import { clearCache, invalidate, revalidateNamespace, revalidateTag } from "../src/invalidation.js";
import { resetCache } from "../src/global.js";
import { createMockBackend, createMockStorage, createTestCache, getEntryInfo } from "../src/testing/index.js";

afterEach(async () => {
  await resetCache();
});

describe("tags", () => {
  it("derives tags from arguments and invalidates them", async () => {
    const { cache } = createTestCache();
    const getProduct = cache.cache(
      async (id: string) => ({ id, name: `Product ${id}` }),
      { ttl: "1m", tags: (id) => ["products", `product:${id}`] },
    );

    await getProduct("1");
    await getProduct("2");
    expect(getProduct.tags("1")).toEqual(["products", "product:1"]);
    expect((await getEntryInfo(getProduct, "1")).tags).toEqual(["products", "product:1"]);

    await cache.revalidateTag("product:1");

    expect((await getEntryInfo(getProduct, "1")).exists).toBe(false);
    expect((await getEntryInfo(getProduct, "2")).exists).toBe(true);
    await cache.dispose();
  });

  it("invalidates every entry sharing a broad tag", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (id: string) => id, {
      ttl: "1m",
      tags: () => ["products", "products:featured"],
    });

    await get("1");
    await get("2");
    await get("3");
    await cache.revalidateTag("products");

    expect((await getEntryInfo(get, "1")).exists).toBe(false);
    expect((await getEntryInfo(get, "2")).exists).toBe(false);
    expect((await getEntryInfo(get, "3")).exists).toBe(false);
    await cache.dispose();
  });

  it("accepts static tags", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async () => "value", { ttl: "1m", tags: ["static"] });
    await get();
    expect((await getEntryInfo(get)).tags).toEqual(["static"]);
    await cache.dispose();
  });

  it("works without native tag support by maintaining an index", async () => {
    const storage = createMockStorage({ nativeTags: false });
    const { cache } = createTestCache({ storage });
    const get = cache.cache(async (id: string) => `v-${id}`, {
      ttl: "1m",
      tags: (id) => [`product:${id}`],
    });

    await get("1");
    await get("2");

    const indexKeys = [...storage.entries().keys()].filter((key) => key.includes("~tags~"));
    expect(indexKeys.length).toBeGreaterThan(0);

    await cache.revalidateTag("product:1");
    expect(await get("1")).toBe("v-1"); // recomputed
    expect((await getEntryInfo(get, "1")).exists).toBe(true);
    expect((await getEntryInfo(get, "2")).exists).toBe(true);
    await cache.dispose();
  });

  it("rejects invalid tags early", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async () => "x", { ttl: "1m", tags: () => ["bad\u0000tag"] });
    await expect(get()).rejects.toThrowError(/control characters/);
    await cache.dispose();
  });

  it("writes an invalidation tombstone for strict mode", async () => {
    const storage = createMockStorage();
    const { cache } = createTestCache({ storage });
    const get = cache.cache(async () => "x", { ttl: "1m", tags: ["tomb"] });
    await get();
    await cache.revalidateTag("tomb");

    const tombstones = [...storage.entries().keys()].filter((key) => key.includes("~tomb~"));
    expect(tombstones).toHaveLength(1);
    await cache.dispose();
  });
});

describe("invalidation helpers", () => {
  it("fans out revalidateTag over registered instances", async () => {
    const storage = createMockStorage();
    const products = createCache({ namespace: "products", storage });
    const users = createCache({ namespace: "users", storage });

    const getProduct = products.cache(async (id: string) => `p-${id}`, {
      ttl: "1m",
      tags: (id) => [`product:${id}`],
    });
    const getUser = users.cache(async (id: string) => `u-${id}`, {
      ttl: "1m",
      tags: (id) => [`user:${id}`],
    });

    await getProduct("1");
    await getUser("1");

    await revalidateTag("product:1");
    expect((await getEntryInfo(getProduct, "1")).exists).toBe(false);
    expect((await getEntryInfo(getUser, "1")).exists).toBe(true);

    await revalidateTag("user:1", { cache: "users" });
    expect((await getEntryInfo(getUser, "1")).exists).toBe(false);

    await products.dispose();
    await users.dispose();
  });

  it("revalidates a single logical key", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (id: string) => id, { ttl: "1m" });
    await get("1");
    await cache.revalidateKey(get.key("1"));
    expect((await getEntryInfo(get, "1")).exists).toBe(false);

    await get("1");
    await cache.revalidateKey("manual");
    expect((await getEntryInfo(get, "1")).exists).toBe(true);
    await cache.dispose();
  });

  it("revalidates a whole namespace and clears caches", async () => {
    const { cache } = createTestCache({ namespace: "ns" });
    const get = cache.cache(async (id: string) => id, { ttl: "1m" });
    await get("1");
    await get("2");

    await cache.revalidateNamespace();
    expect((await getEntryInfo(get, "1")).exists).toBe(false);
    expect((await getEntryInfo(get, "2")).exists).toBe(false);

    await get("1");
    await cache.clear();
    expect((await getEntryInfo(get, "1")).exists).toBe(false);
    await cache.dispose();
  });

  it("combines keys, tags and namespaces through invalidate()", async () => {
    const storage = createMockBackend();
    const cache = createCache({ namespace: "combo", storage: createMockStorage({ backend: storage }) });
    const get = cache.cache(async (id: string) => id, {
      ttl: "1m",
      tags: (id) => [`item:${id}`],
    });

    await get("1");
    await get("2");
    const result = await cache.invalidate({ tags: ["item:1"] });
    expect(result.tags).toBe(1);
    expect((await getEntryInfo(get, "1")).exists).toBe(false);
    expect((await getEntryInfo(get, "2")).exists).toBe(true);

    const combined = await invalidate({ tags: ["item:2"], keys: ["whatever"] });
    expect(combined.tags).toBe(1);
    await cache.dispose();
  });

  it("reports the error but keeps invalidating other targets", async () => {
    const good = createMockStorage();
    const bad = createMockStorage();
    const goodCache = createCache({ namespace: "good", storage: good });
    const badCache = createCache({ namespace: "bad", storage: bad });

    const getGood = goodCache.cache(async () => "g", { ttl: "1m", tags: ["shared"] });
    const getBad = badCache.cache(async () => "b", { ttl: "1m", tags: ["shared"] });
    await getGood();
    await getBad();

    bad.invalidateTag = async () => {
      throw new Error("backend down");
    };

    await expect(revalidateTag("shared")).rejects.toThrow("backend down");
    expect((await getEntryInfo(getGood)).exists).toBe(false);

    await goodCache.dispose();
    await badCache.dispose();
  });

  it("throws when a specific cache namespace does not exist", async () => {
    const cache = createCache({ namespace: "only-one" });
    await expect(revalidateTag("x", { cache: "missing" })).rejects.toThrowError(
      /No registered cache instance/,
    );
    await cache.dispose();
  });

  it("clears a namespace through clearCache()", async () => {
    const storage = createMockStorage();
    const cache = createCache({ namespace: "clear-me", storage });
    const get = cache.cache(async (id: string) => id, { ttl: "1m" });
    await get("1");

    await clearCache({ cache });
    expect((await getEntryInfo(get, "1")).exists).toBe(false);

    await get("1");
    await revalidateNamespace("clear-me");
    expect((await getEntryInfo(get, "1")).exists).toBe(false);
    await cache.dispose();
  });
});

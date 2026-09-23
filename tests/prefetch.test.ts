import { describe, expect, it } from "vitest";
import { prefetchDetailed, warmup } from "../src/prefetch.js";
import { createTestCache } from "../src/testing/index.js";

describe("prefetch", () => {
  it("reports a warm entry as a cache hit without calling the source", async () => {
    const { cache } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return { id };
      },
      { ttl: "5m" },
    );

    await get("1");
    const result = await prefetchDetailed(get, "1");

    expect(result.hit).toBe(true);
    expect(result.source).toBe("cache");
    expect(result.value).toEqual({ id: "1" });
    expect(calls).toBe(1);
    await cache.dispose();
  });

  it("treats a cached undefined (cacheNull) as a hit, not a source call", async () => {
    const { cache } = createTestCache();
    let calls = 0;
    const lookup = cache.cache(
      async () => {
        calls += 1;
        return undefined;
      },
      { ttl: "5m", cacheNull: true },
    );

    expect(await lookup()).toBeUndefined();
    const result = await prefetchDetailed(lookup);

    expect(result.hit).toBe(true);
    expect(result.source).toBe("cache");
    expect(calls).toBe(1);
    await cache.dispose();
  });

  it("falls back to the source on a cold key", async () => {
    const { cache } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return id;
      },
      { ttl: "5m" },
    );

    const result = await prefetchDetailed(get, "1");

    expect(result.hit).toBe(false);
    expect(result.source).toBe("source");
    expect(result.value).toBe("1");
    expect(calls).toBe(1);
    await cache.dispose();
  });

  it("collects warmup failures without aborting the whole batch", async () => {
    const result = await warmup([
      async () => undefined,
      async () => {
        throw new Error("boom");
      },
      async () => undefined,
    ]);

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.error.message).toBe("boom");
  });
});

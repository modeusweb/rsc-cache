import { describe, expect, it } from "vitest";
import {
  cache as reactCache,
  cacheIn,
  getCacheSignal,
  isCacheSignalAvailable,
  isReactCacheAvailable,
  withReactCacheContext,
} from "../src/react/index.js";
import { createTestCache } from "../src/testing/index.js";

describe("react integration", () => {
  it("is cache-signal aware but returns null outside of rendering", () => {
    expect(getCacheSignal()).toBeNull();
    expect(typeof isCacheSignalAvailable()).toBe("boolean");
    expect(typeof isReactCacheAvailable()).toBe("boolean");
  });

  it("wraps functions with React cache() when available and preserves the signature", async () => {
    const { cache, dispose } = createTestCache();
    let calls = 0;

    const getUser = cacheIn(cache, async (id: string) => {
      calls += 1;
      return { id, name: `user-${id}` };
    }, { ttl: "5m" });

    const first = await getUser("1");
    const second = await getUser("1");

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(getUser.name).toBeTypeOf("string");
    await dispose();
  });

  it("can opt out of React cache() wrapping", async () => {
    const { cache, dispose } = createTestCache();
    let calls = 0;

    const get = cacheIn(cache, async () => {
      calls += 1;
      return calls;
    }, { useReactCache: false, ttl: "1m" });

    await get();
    await get();
    expect(calls).toBe(1);
    await dispose();
  });

  it("the top-level cache() uses the global instance and persists between calls", async () => {
    let calls = 0;
    const get = reactCache(async (id: string) => {
      calls += 1;
      return { id };
    }, { ttl: "1m" });

    await get("42");
    await get("42");
    expect(calls).toBe(1);
  });

  it("withReactCacheContext propagates scope into key generation", async () => {
    const { cache, dispose } = createTestCache();
    const get = cacheIn(cache, async () => "dash", {
      ttl: "1m",
      scope: ({ context }) => context.userId ?? "anon",
    });

    const result = withReactCacheContext({ userId: "u1" }, () => get());
    expect(await result).toBe("dash");
    await dispose();
  });
});

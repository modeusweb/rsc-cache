import { describe, expect, it } from "vitest";
import { createCache } from "../src/create-cache.js";
import {
  CacheConfigurationError,
  CacheError,
  CacheTimeoutError,
} from "../src/errors.js";
import { jsonSerializer } from "../src/serializer.js";
import { createMockStorage, createTestCache, getEntryInfo } from "../src/testing/index.js";
import { decodeUtf8, encodeUtf8 } from "../src/bytes.js";
import type { CacheEntry, CacheEvent, Serializer } from "../src/types.js";

describe("timeouts", () => {
  it("fails open when a read exceeds readTimeout", async () => {
    const events: CacheEvent[] = [];
    const storage = createMockStorage({ latencyMs: 30 });
    const { cache } = createTestCache({
      storage,
      timeouts: { read: "5ms" },
      onEvent: (event) => events.push(event),
    });
    const get = cache.cache(async (id: string) => `value-${id}`, { ttl: "1m" });

    expect(await get("1")).toBe("value-1");
    // The read timed out, but the request still succeeded (fail-open).
    const timeout = events.find((event) => event.error?.name === "CacheTimeoutError");
    expect(timeout?.outcome).toBe("fail-open");
    await cache.dispose();
  });

  it("fails closed when configured to", async () => {
    const storage = createMockStorage({ latencyMs: 30 });
    const { cache } = createTestCache({
      storage,
      timeouts: { default: "5ms" },
      failureMode: "fail-closed",
    });
    const get = cache.cache(async (id: string) => `value-${id}`, { ttl: "1m" });

    await expect(get("1")).rejects.toThrowError(/Cache read failed/);
    await cache.dispose();
  });

  it("applies the read timeout to raw instance reads", async () => {
    const storage = createMockStorage({ latencyMs: 30 });
    const { cache } = createTestCache({ storage, timeouts: { read: "5ms" } });

    await expect(cache.get("missing")).rejects.toThrowError(CacheTimeoutError);
    await expect(cache.has("missing")).rejects.toThrowError(CacheTimeoutError);
    await cache.dispose();
  });

  it("returns the computed value even when the write times out", async () => {
    const events: CacheEvent[] = [];
    const storage = createMockStorage();
    const { cache } = createTestCache({
      storage,
      timeouts: { write: "1ms" },
      onEvent: (event) => events.push(event),
    });
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return `value-${id}`;
      },
      { ttl: "1m" },
    );

    const originalSet = storage.set.bind(storage);
    storage.set = async (key, entry, options) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalSet(key, entry, options);
    };

    expect(await get("1")).toBe("value-1");
    expect(events.some((event) => event.outcome === "write-failed")).toBe(true);
    expect(calls).toBe(1);
    await cache.dispose();
  });
});

describe("serialization failures", () => {
  it("returns the value when it cannot be serialized", async () => {
    const events: CacheEvent[] = [];
    const { cache } = createTestCache({ onEvent: (event) => events.push(event) });
    const get = cache.cache(async () => ({ notSerializable: () => 1 }), { ttl: "1m" });

    const value = await get();
    expect(typeof value.notSerializable).toBe("function");
    expect(events.some((event) => event.outcome === "serialization-failed")).toBe(true);
    expect((await getEntryInfo(get)).exists).toBe(false);
    await cache.dispose();
  });

  it("treats entries written by another serializer as a miss", async () => {
    const events: CacheEvent[] = [];
    const altSerializer: Serializer = {
      name: "alt",
      serialize: (value) => encodeUtf8(JSON.stringify(value)),
      deserialize: (bytes) => JSON.parse(decodeUtf8(bytes)),
    };

    const { cache } = createTestCache({ onEvent: (event) => events.push(event) });
    let calls = 0;
    const withAlt = cache.cache(async (id: string) => ({ id, calls: (calls += 1) }), {
      ttl: "1m",
      key: (id) => id,
      serialize: altSerializer,
    });
    const withDefault = cache.cache(async (id: string) => ({ id, calls: (calls += 1) }), {
      ttl: "1m",
      key: (id) => id,
    });

    await withAlt("1");
    expect((await withDefault("1")).calls).toBe(2);
    expect(events.some((event) => event.outcome === "serializer-mismatch")).toBe(true);
    // The foreign entry was dropped, so the rewrite must land and the next call
    // is a hit — not an endless recompute stuck on a stale compare-and-set.
    expect((await withDefault("1")).calls).toBe(2);
    expect(cache.stats().hits).toBeGreaterThanOrEqual(1);
    await cache.dispose();
  });

  it("drops a corrupt entry instead of serving garbage", async () => {
    const events: CacheEvent[] = [];
    const storage = createMockStorage();
    const { cache } = createTestCache({ storage, onEvent: (event) => events.push(event) });
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return `value-${id}-${calls}`;
      },
      { ttl: "1m" },
    );

    await get("1");
    const key = get.key("1");
    const entry = (await storage.get(key)) as CacheEntry;
    await storage.set(key, { ...entry, value: encodeUtf8("{not json") });

    expect(await get("1")).toBe("value-1-2");
    expect(events.some((event) => event.outcome === "corrupt-payload")).toBe(true);
    await cache.dispose();
  });

  it("ignores entries that are not cache entries at all", async () => {
    const events: CacheEvent[] = [];
    const malicious = {
      name: "malicious",
      get: async () => ({ value: "not-bytes" }) as unknown as CacheEntry,
      set: async () => undefined,
      delete: async () => undefined,
      has: async () => true,
      clear: async () => undefined,
    };
    const cache = createCache({
      storage: malicious,
      namespace: "guarded",
      register: false,
      onEvent: (event) => events.push(event),
    });
    const get = cache.cache(async () => "safe", { ttl: "1m" });

    expect(await get()).toBe("safe");
    expect(events.some((event) => event.outcome === "invalid-entry")).toBe(true);
    await cache.dispose();
  });

  it("treats an entry compressed with an unknown provider as a miss", async () => {
    const { gzipCompression } = await import("../src/compression.js");
    const storage = createMockStorage();
    const { cache } = createTestCache({ storage });
    const compressing = createCache({ storage, namespace: "default", register: false });

    const write = compressing.cache(async (id: string) => `value-${id}`, {
      ttl: "1m",
      key: (id) => id,
      compression: gzipCompression(),
    });
    const read = cache.cache(async (id: string) => `value2-${id}`, {
      ttl: "1m",
      key: (id) => id,
    });

    expect(await write("1")).toBe("value-1");
    expect(await read("1")).toBe("value2-1");
    await cache.dispose();
    await compressing.dispose();
  });
});

describe("configuration errors", () => {
  it("rejects invalid namespaces and prefixes", () => {
    expect(() => createCache({ namespace: "bad:namespace" })).toThrowError(CacheConfigurationError);
    expect(() => createCache({ namespace: "" })).toThrowError(CacheConfigurationError);
    expect(() => createCache({ prefix: "bad prefix" })).toThrowError(CacheConfigurationError);
  });

  it("rejects invalid limits and durations", () => {
    const { cache } = createTestCache();
    expect(() => cache.cache(async () => 1, { ttl: "5 minutes" })).toThrowError(
      CacheConfigurationError,
    );
    expect(() => cache.cache(async () => 1, { maxValueSize: 0 })).toThrowError(
      CacheConfigurationError,
    );
    expect(() => cache.cache(async () => 1, { maxKeyLength: 5 })).toThrowError(
      CacheConfigurationError,
    );
  });

  it("requires real functions", () => {
    const { cache } = createTestCache();
    expect(() => cache.cache(undefined as never)).toThrowError(/expects a function/);
  });

  it("reports storage failures with a storage error type", async () => {
    const storage = createMockStorage({ failReads: true });
    const { cache } = createTestCache({ storage, failureMode: "fail-closed" });
    const get = cache.cache(async () => "x", { ttl: "1m" });

    const error = await get().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CacheError);
    expect((error as CacheError).code).toBe("ERR_CACHE_STORAGE");
    await cache.dispose();
  });

  it("keeps the configured serializer identity on entries", async () => {
    const serializer = jsonSerializer({ name: "custom-json", pretty: true });
    const cache = createCache({ serializer, namespace: "custom-ser", register: false });
    const get = cache.cache(async () => ({ a: 1 }), { ttl: "1m" });

    await get();
    const entry = await cache.storage.get(get.key());
    expect(entry?.serializer).toBe("custom-json");
    await cache.dispose();
  });

  it("never caches without a function", async () => {
    const cache = createCache({ namespace: "no-store", register: false, storage: createMockStorage() });
    const get = cache.cache(async () => "x", { ttl: "1m" });
    await get();
    const entry = await cache.storage.get(get.key());
    expect(entry?.value).toBeInstanceOf(Uint8Array);
    await cache.dispose();
  });
});

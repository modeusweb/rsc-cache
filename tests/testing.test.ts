import { describe, expect, it } from "vitest";
import {
  createFakeRedisClient,
  createMockBackend,
  createMockStorage,
  createTestCache,
  getEntryInfo,
} from "../src/testing/index.js";
import type { CacheEntry } from "../src/types.js";

const entry = (value: string): CacheEntry => ({
  value: new TextEncoder().encode(value),
  createdAt: 0,
  expiresAt: Number.POSITIVE_INFINITY,
  revision: 1,
});

describe("createTestCache", () => {
  it("expires entries on the fake clock without sleeping", async () => {
    const { cache, advanceTime, dispose } = createTestCache();
    let calls = 0;
    const get = cache.cache(async (id: string) => {
      calls += 1;
      return id;
    }, { ttl: "5m" });

    await get("1");
    await get("1");
    expect(calls).toBe(1);

    await advanceTime(6 * 60_000);
    await get("1");
    expect(calls).toBe(2);
    await dispose();
  });

  it("exposes entry assertions", async () => {
    const { cache, dispose } = createTestCache();
    const get = cache.cache(async () => "v", { ttl: "1m", tags: () => ["t"] });

    expect((await getEntryInfo(get)).state).toBe("missing");
    await get();
    const info = await getEntryInfo(get);
    expect(info.state).toBe("fresh");
    expect(info.tags).toEqual(["t"]);
    await dispose();
  });
});

describe("createMockStorage", () => {
  it("counts operations", async () => {
    const storage = createMockStorage();
    await storage.get("missing");
    await storage.set("k", entry(""));
    await storage.delete("k");

    expect(storage.counters.get).toBe(1);
    expect(storage.counters.set).toBe(1);
    expect(storage.counters.delete).toBe(1);
  });

  it("injects read/write failures", async () => {
    const storage = createMockStorage({ failReads: true });
    await expect(storage.get("k")).rejects.toThrow("read failure");

    storage.failing.reads = false;
    expect(await storage.get("k")).toBeNull();
  });

  it("shares one backend between two storages (multi-process simulation)", async () => {
    const backend = createMockBackend();
    const a = createMockStorage({ name: "proc-a", backend });
    const b = createMockStorage({ name: "proc-b", backend });

    await b.set("shared", entry("x"));

    expect(await a.get("shared")).not.toBeNull();
    await a.delete("shared");
    expect(await b.get("shared")).toBeNull();
  });

  it("supports cross-process locking through a shared backend", async () => {
    const backend = createMockBackend();
    const a = createMockStorage({ backend });
    const b = createMockStorage({ backend });

    const lock = await a.acquireLock!("k", { ttlMs: 5_000 });
    expect(await b.acquireLock!("k", { ttlMs: 5_000 })).toBeNull();
    await lock!.release();
    expect(await b.acquireLock!("k", { ttlMs: 5_000 })).not.toBeNull();
  });
});

describe("createFakeRedisClient", () => {
  it("implements the structural redis contract", async () => {
    const client = createFakeRedisClient();
    await client.set("k", "v", { PX: 1_000 });
    expect(await client.get("k")).toBe("v");

    client.advanceTime(1_500);
    expect(await client.get("k")).toBeNull();
  });

  it("supports sets and eval scripts", async () => {
    const client = createFakeRedisClient();
    await client.sadd("tag:products", ["k1", "k1", "k2"]);
    expect(client.setMembers("tag:products").sort()).toEqual(["k1", "k2"]);
    expect(typeof client.eval).toBe("function");
    expect(client.commands).toBeGreaterThan(0);
  });
});

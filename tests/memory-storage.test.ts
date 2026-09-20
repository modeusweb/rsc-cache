import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/memory.js";
import type { CacheEntry } from "../src/types.js";

const makeEntry = (value: string, revision = 1, expiresAt = Infinity): CacheEntry => ({
  value: new TextEncoder().encode(value),
  createdAt: Date.now(),
  expiresAt,
  revision,
});

describe("memory storage", () => {
  it("stores, reads and deletes entries", async () => {
    const storage = memoryStorage();
    await storage.set("a", makeEntry("1"));
    expect(await storage.has("a")).toBe(true);
    expect((await storage.get("a"))?.revision).toBe(1);
    await storage.delete("a");
    expect(await storage.get("a")).toBeNull();
    expect(storage.size).toBe(0);
    await storage.close();
  });

  it("evicts the least recently used entry when maxEntries is exceeded", async () => {
    const events: string[] = [];
    const storage = memoryStorage({ maxEntries: 2 });
    storage.observe((event) => events.push(`${event.type}:${event.key}`));

    await storage.set("a", makeEntry("a"));
    await storage.set("b", makeEntry("b"));
    // Reading "a" makes it the most recently used.
    await storage.get("a");
    await storage.set("c", makeEntry("c"));

    expect(await storage.get("b")).toBeNull();
    expect(await storage.get("a")).not.toBeNull();
    expect(await storage.get("c")).not.toBeNull();
    expect(storage.stats().evictions).toBe(1);
    expect(events.some((event) => event.startsWith("eviction:b"))).toBe(true);
    await storage.close();
  });

  it("can keep entries in insertion order when LRU refresh is disabled", async () => {
    const storage = memoryStorage({ maxEntries: 2, updateAgeOnGet: false });
    await storage.set("a", makeEntry("a"));
    await storage.set("b", makeEntry("b"));
    await storage.get("a");
    await storage.set("c", makeEntry("c"));

    expect(await storage.get("a")).toBeNull();
    expect(await storage.get("b")).not.toBeNull();
    await storage.close();
  });

  it("respects the byte budget", async () => {
    const storage = memoryStorage({ maxSizeBytes: 400 });
    await storage.set("a", makeEntry("x".repeat(200)));
    await storage.set("b", makeEntry("y".repeat(200)));
    expect(storage.bytes).toBeLessThanOrEqual(400);
    expect(storage.size).toBeLessThanOrEqual(1);
    await storage.close();
  });

  it("keeps entries until the end of the stale window", async () => {
    const clock = { current: 0, now: () => clock.current };
    const events: string[] = [];
    const storage = memoryStorage({ clock, cleanup: "none" });
    storage.observe((event) => events.push(event.type));

    await storage.set("a", { ...makeEntry("a", 1, 1000), staleUntil: 2000 });

    clock.current = 1500;
    expect(await storage.get("a")).not.toBeNull();

    clock.current = 2500;
    expect(await storage.get("a")).toBeNull();
    expect(events).toContain("expiration");
    expect(storage.stats().expirations).toBe(1);
    await storage.close();
  });

  it("sweeps expired entries on an interval when asked to", async () => {
    const storage = memoryStorage({ cleanup: "interval", cleanupIntervalMs: 5 });
    await storage.set("a", makeEntry("a", 1, Date.now() - 1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(storage.size).toBe(0);
    await storage.close();
  });

  it("clears only the requested prefix", async () => {
    const storage = memoryStorage();
    await storage.set("rsc-cache:v1:a:fn:1", makeEntry("a"));
    await storage.set("rsc-cache:v1:b:fn:1", makeEntry("b"));

    await storage.clear({ prefix: "rsc-cache:v1:a:" });
    expect(await storage.get("rsc-cache:v1:a:fn:1")).toBeNull();
    expect(await storage.get("rsc-cache:v1:b:fn:1")).not.toBeNull();
    await storage.close();
  });

  it("supports native tags", async () => {
    const storage = memoryStorage();
    await storage.set("k1", { ...makeEntry("a"), tags: ["products"] });
    await storage.set("k2", { ...makeEntry("b"), tags: ["products"] });
    await storage.set("k3", { ...makeEntry("c"), tags: ["users"] });

    await storage.addTags!("k1", ["products"]);
    await storage.invalidateTag!("products");

    expect(await storage.get("k1")).toBeNull();
    expect(await storage.get("k2")).toBeNull();
    expect(await storage.get("k3")).not.toBeNull();
    await storage.close();
  });
});

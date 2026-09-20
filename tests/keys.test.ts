import { describe, expect, it } from "vitest";
import { canonicalize, canonicalizeArgs } from "../src/stable-stringify.js";
import { sha256Hex } from "../src/sha256.js";
import { CacheKeyError } from "../src/errors.js";
import { createTestCache } from "../src/testing/index.js";

describe("sha256", () => {
  it("matches the NIST test vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex("x".repeat(1000))).toBe(
      sha256Hex(new TextEncoder().encode("x".repeat(1000))),
    );
  });
});

describe("canonicalize", () => {
  it("is stable across property order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ nested: { x: [1, 2], y: "z" } })).toBe(
      canonicalize({ nested: { y: "z", x: [1, 2] } }),
    );
  });

  it("does not confuse concatenations", () => {
    expect(canonicalizeArgs(["ab", "c"])).not.toBe(canonicalizeArgs(["a", "bc"]));
    expect(canonicalizeArgs([1, 23])).not.toBe(canonicalizeArgs([12, 3]));
  });

  it("distinguishes values JSON would collapse", () => {
    expect(canonicalize(undefined)).not.toBe(canonicalize(null));
    expect(canonicalize(0)).not.toBe(canonicalize(-0));
    expect(canonicalize(1)).not.toBe(canonicalize("1"));
    expect(canonicalize(Number.NaN)).not.toBe(canonicalize(0));
    expect(canonicalize(10n)).not.toBe(canonicalize(10));
    expect(canonicalize(new Date(0))).not.toBe(canonicalize("1970-01-01T00:00:00.000Z"));
    expect(canonicalize(new URL("https://a.test/x"))).toBe(canonicalize(new URL("https://a.test/x")));
    expect(canonicalize(new Set([1, 2]))).toBe(canonicalize(new Set([2, 1])));
    expect(canonicalize(new Map([[1, "a"]]))).toBe(canonicalize(new Map([[1, "a"]])));
    expect(canonicalize(new Uint8Array([1, 2, 3]))).toBe(canonicalize(new Uint8Array([1, 2, 3])));
  });

  it("encodes circular references instead of blowing up", () => {
    interface Node {
      id: number;
      self?: Node;
    }
    const node: Node = { id: 1 };
    node.self = node;
    expect(canonicalize(node)).toBe(canonicalize(node));
  });

  it("rejects values that cannot be keyed deterministically", () => {
    expect(() => canonicalize(() => undefined)).toThrowError(CacheKeyError);
    expect(() => canonicalize(Symbol("x"))).toThrowError(CacheKeyError);
    expect(() => canonicalize(new (class Foo {})())).toThrowError(CacheKeyError);
  });
});

describe("key generation", () => {
  it("builds namespaced, hashed keys", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (id: string, _user: { email: string }) => id, { ttl: "1m" });

    const key = get.key("1", { email: "john@example.com" });
    expect(key.startsWith("rsc-cache:v1:default:")).toBe(true);
    expect(key).toMatch(/:[0-9a-f]{32}$/);
    // Secrets never land in the storage key.
    expect(key).not.toContain("john@example.com");
    await cache.dispose();
  });

  it("respects custom namespaces and versions", async () => {
    const { cache } = createTestCache();
    const v1 = cache.cache(async (id: string) => id, { ttl: "1m", namespace: "products" });
    const v2 = cache.cache(async (id: string) => id, { ttl: "1m", namespace: "products", version: "v2" });

    expect(v1.key("1")).toContain(":products:");
    expect(v1.key("1")).not.toBe(v2.key("1"));
    await cache.dispose();
  });

  it("supports custom keys and hashes them when they are too long", async () => {
    const { cache } = createTestCache();
    const short = cache.cache(async (id: string) => id, {
      ttl: "1m",
      key: (id) => `product-${id}`,
    });
    expect(short.key("42")).toContain("product-42");

    const long = cache.cache(async (id: string) => id, {
      ttl: "1m",
      key: (id) => `${id}${"y".repeat(500)}`,
      maxKeyLength: 120,
    });
    const key = long.key("x");
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).not.toContain("yyy");
    await cache.dispose();
  });

  it("keeps identical keys for structurally equal arguments", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (filter: { a: number; b: number[] }) => filter, { ttl: "1m" });

    expect(get.key({ a: 1, b: [1, 2] })).toBe(get.key({ b: [1, 2], a: 1 }));
    expect(get.key({ a: 1, b: [1, 2] })).not.toBe(get.key({ a: 1, b: [2, 1] }));
    await cache.dispose();
  });

  it("propagates key errors instead of caching under a wrong key", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (value: unknown) => value, { ttl: "1m" });
    await expect(get(() => 1)).rejects.toThrowError(CacheKeyError);
    await cache.dispose();
  });

  it("requires an explicit key resolver for non-deterministic arguments", async () => {
    const { cache } = createTestCache();
    const get = cache.cache(async (value: { id: string }) => value, {
      ttl: "1m",
      key: (value) => value.id,
    });
    expect(await get({ id: "a" })).toEqual({ id: "a" });
    expect(await get({ id: "a" })).toEqual({ id: "a" });
    expect(cache.stats().hits).toBe(1);
    await cache.dispose();
  });
});

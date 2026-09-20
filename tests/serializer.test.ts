import { describe, expect, it } from "vitest";
import {
  decodeEntry,
  encodeEntry,
  entryFromString,
  entryToString,
  isEntryString,
} from "../src/codec.js";
import { gzipCompression, isCompressionSupported, noCompression } from "../src/compression.js";
import { CacheSerializationError } from "../src/errors.js";
import { jsonSerializer, strictJsonSerializer } from "../src/serializer.js";
import { bytesEqual, decodeUtf8, encodeUtf8 } from "../src/bytes.js";
import { createTestCache, getEntryInfo } from "../src/testing/index.js";
import type { CacheEntry } from "../src/types.js";

describe("typed json serializer", () => {
  const serializer = jsonSerializer();

  it("round trips the values JSON would destroy", async () => {
    const value = {
      string: "text",
      number: 42,
      negativeZero: -0,
      float: 1.5,
      bool: true,
      nil: null,
      nothing: undefined,
      notANumber: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      big: 12345678901234567890n,
      date: new Date("2024-01-02T03:04:05.000Z"),
      invalidDate: new Date(Number.NaN),
      url: new URL("https://example.test/path?x=1"),
      regexp: /ab+c/gi,
      bytes: new Uint8Array([1, 2, 3]),
      buffer: new Uint8Array([9, 8]).buffer,
      map: new Map<string, unknown>([["a", 1], ["b", { nested: true }]]),
      set: new Set([1, 2, 3]),
      list: [1, "two", [3, { four: 4 }]],
      nested: { deep: { deeper: { value: "x" } } },
    };

    const restored = (await serializer.deserialize(
      await serializer.serialize(value),
    )) as typeof value;

    expect(restored.string).toBe("text");
    expect(restored.number).toBe(42);
    expect(Object.is(restored.negativeZero, -0)).toBe(true);
    expect(restored.nothing).toBeUndefined();
    expect(Number.isNaN(restored.notANumber)).toBe(true);
    expect(restored.infinity).toBe(Number.POSITIVE_INFINITY);
    expect(restored.negativeInfinity).toBe(Number.NEGATIVE_INFINITY);
    expect(restored.big).toBe(12345678901234567890n);
    expect(restored.date.toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(Number.isNaN(restored.invalidDate.getTime())).toBe(true);
    expect(restored.url.href).toBe("https://example.test/path?x=1");
    expect(restored.regexp.source).toBe("ab+c");
    expect(restored.regexp.flags).toBe("gi");
    expect([...restored.bytes]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(restored.buffer)]).toEqual([9, 8]);
    expect(restored.map.get("b")).toEqual({ nested: true });
    expect([...restored.set]).toEqual([1, 2, 3]);
    expect(restored.nested.deep.deeper.value).toBe("x");
  });

  it("produces identical bytes regardless of property order", async () => {
    const valueA = { b: 1, a: [{ y: 2, x: 1 }] };
    const valueB = { a: [{ x: 1, y: 2 }], b: 1 };
    expect(bytesEqual(await serializer.serialize(valueA), await serializer.serialize(valueB))).toBe(
      true,
    );
  });

  it("rejects values that are not data", async () => {
    await expect(async () => serializer.serialize(() => 1)).rejects.toThrowError(
      CacheSerializationError,
    );
    await expect(async () => serializer.serialize(Symbol("s"))).rejects.toThrowError(
      CacheSerializationError,
    );
    await expect(async () => serializer.serialize(new (class Thing {})())).rejects.toThrowError(
      CacheSerializationError,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(async () => serializer.serialize(circular)).rejects.toThrowError(
      CacheSerializationError,
    );
  });

  it("round trips errors", async () => {
    const restored = (await serializer.deserialize(
      await serializer.serialize(new TypeError("boom")),
    )) as Error;
    expect(restored).toBeInstanceOf(Error);
    expect(restored.name).toBe("TypeError");
    expect(restored.message).toBe("boom");
  });

  it("does not allow prototype pollution from a cache backend", async () => {
    const payload = encodeUtf8(JSON.stringify({ __proto__: { polluted: true }, safe: 1 }));
    const restored = (await serializer.deserialize(payload)) as Record<string, unknown>;
    expect(restored.safe).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  });

  it("fails loudly on corrupted payloads", async () => {
    await expect(async () => serializer.deserialize(encodeUtf8("{not json"))).rejects.toThrowError(
      CacheSerializationError,
    );
    await expect(async () =>
      serializer.deserialize(encodeUtf8(JSON.stringify({ "~rsc": "unknown-tag" }))),
    ).rejects.toThrowError(CacheSerializationError);
  });

  it("offers a strict JSON serializer for JSON-only data", async () => {
    const strict = strictJsonSerializer();
    expect(await strict.deserialize(await strict.serialize({ a: 1 }))).toEqual({ a: 1 });
    await expect(async () => strict.serialize(undefined)).rejects.toThrowError(
      CacheSerializationError,
    );
  });

  it("reports the serializer name for diagnostics", () => {
    expect(jsonSerializer().name).toBe("json");
    expect(jsonSerializer({ name: "custom" }).name).toBe("custom");
  });
});

describe("entry codec", () => {
  const entry: CacheEntry = {
    value: encodeUtf8("payload"),
    createdAt: 1000,
    expiresAt: 2000,
    staleUntil: 3000,
    revision: 7,
    state: "value",
    namespace: "products",
    visibility: "private",
    tags: ["products", "product:1"],
    compressed: "gzip",
    serializer: "json",
    metadata: { requestId: "abc" },
    label: "getProduct",
  };

  it("round trips through the binary envelope", () => {
    const decoded = decodeEntry(encodeEntry(entry));
    expect(decoded.value && decodeUtf8(decoded.value)).toBe("payload");
    expect(decoded.createdAt).toBe(1000);
    expect(decoded.expiresAt).toBe(2000);
    expect(decoded.staleUntil).toBe(3000);
    expect(decoded.revision).toBe(7);
    expect(decoded.namespace).toBe("products");
    expect(decoded.visibility).toBe("private");
    expect(decoded.tags).toEqual(["products", "product:1"]);
    expect(decoded.compressed).toBe("gzip");
    expect(decoded.metadata).toEqual({ requestId: "abc" });
  });

  it("round trips through the string envelope", () => {
    const encoded = entryToString(entry);
    expect(isEntryString(encoded)).toBe(true);
    expect(encoded.startsWith("RSC1|7|")).toBe(true);
    expect(decodeUtf8(entryFromString(encoded).value)).toBe("payload");
  });

  it("encodes entries that never expire", () => {
    const never: CacheEntry = { ...entry, expiresAt: Infinity, staleUntil: undefined };
    const decoded = entryFromString(entryToString(never));
    expect(decoded.expiresAt).toBe(Infinity);
    expect(decoded.staleUntil).toBeUndefined();
  });

  it("rejects corrupted envelopes", () => {
    expect(() => entryFromString("nonsense")).toThrowError(CacheSerializationError);
    expect(() => entryFromString("RSC1|not-a-number|e30=|")).toThrowError(
      CacheSerializationError,
    );
    expect(() => decodeEntry(new Uint8Array([1, 2, 3]))).toThrowError(CacheSerializationError);
  });
});

describe("compression", () => {
  it("exposes a pass-through provider", async () => {
    const bytes = encodeUtf8("hello");
    expect(await noCompression.compress(bytes)).toBe(bytes);
    expect(await noCompression.decompress(bytes)).toBe(bytes);
  });

  it("round trips through gzip when the runtime supports it", async () => {
    if (!isCompressionSupported()) {
      return;
    }
    const gzip = gzipCompression();
    const input = encodeUtf8("x".repeat(2000));
    const compressed = await gzip.compress(input);
    expect(compressed.length).toBeLessThan(input.length);
    expect(decodeUtf8(await gzip.decompress(compressed))).toBe(decodeUtf8(input));
  });

  it("stores compressed entries and reads them back", async () => {
    if (!isCompressionSupported()) {
      return;
    }
    const { cache } = createTestCache({ compression: gzipCompression() });
    const get = cache.cache(async (id: string) => ({ id, payload: "y".repeat(1000) }), {
      ttl: "1m",
    });

    expect((await get("1")).id).toBe("1");
    expect((await getEntryInfo(get, "1")).exists).toBe(true);
    expect((await get("1")).payload.length).toBe(1000);
    expect(cache.stats().hits).toBe(1);
    await cache.dispose();
  });
});

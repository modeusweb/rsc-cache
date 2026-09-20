import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "../src/duration.js";
import { CacheConfigurationError } from "../src/errors.js";
import { createTestCache, getEntryInfo } from "../src/testing/index.js";

describe("duration parsing", () => {
  it("parses numbers as milliseconds", () => {
    expect(parseDuration(60)).toBe(60);
    expect(parseDuration(5 * 60_000)).toBe(300_000);
    expect(parseDuration(0)).toBe(0);
  });

  it("parses unit strings", () => {
    expect(parseDuration("60ms")).toBe(60);
    expect(parseDuration("60s")).toBe(60_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1w")).toBe(604_800_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1h 30m")).toBe(5_400_000);
    expect(parseDuration("1.5s")).toBe(1500);
    expect(parseDuration("300")).toBe(300);
  });

  it("supports 'forever' spellings", () => {
    expect(parseDuration("never")).toBe(Infinity);
    expect(parseDuration("forever")).toBe(Infinity);
    expect(parseDuration(Infinity)).toBe(Infinity);
  });

  it("returns undefined for missing values", () => {
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration(null)).toBeUndefined();
  });

  it("rejects invalid input loudly", () => {
    expect(() => parseDuration("5 minutes")).toThrowError(CacheConfigurationError);
    expect(() => parseDuration("")).toThrowError(CacheConfigurationError);
    expect(() => parseDuration(-1)).toThrowError(CacheConfigurationError);
    expect(() => parseDuration(Number.NaN)).toThrowError(CacheConfigurationError);
  });

  it("formats durations for logs", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(undefined)).toBe("none");
    expect(formatDuration(Infinity)).toBe("inf");
  });
});

describe("ttl behaviour", () => {
  it("reports fresh, stale and expired states", async () => {
    const { cache, advanceTime } = createTestCache();
    const get = cache.cache(async (id: string) => `${id}:v`, {
      ttl: "5m",
      staleTtl: "30m",
      revalidate: "background",
    });

    await get("1");
    expect((await getEntryInfo(get, "1")).state).toBe("fresh");

    await advanceTime(6 * 60_000);
    expect((await getEntryInfo(get, "1")).state).toBe("stale");

    await advanceTime(30 * 60_000);
    expect((await getEntryInfo(get, "1")).state).toBe("missing");
    await cache.dispose();
  });

  it("keeps entries usable inside the stale window", async () => {
    const { cache, advanceTime } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async (id: string) => {
        calls += 1;
        return `${id}#${calls}`;
      },
      { ttl: "1m", staleTtl: "10m", revalidate: "background" },
    );

    await get("1");
    await advanceTime(2 * 60_000);
    // Stale values are served immediately; the refresh happens in background.
    expect(await get("1")).toBe("1#1");
    await cache.flushBackgroundTasks();
    expect(calls).toBe(2);
    await cache.dispose();
  });

  it("honours a zero ttl as immediately expired", async () => {
    const { cache, advanceTime } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async () => {
        calls += 1;
        return calls;
      },
      { ttl: 0 },
    );

    expect(await get()).toBe(1);
    await advanceTime(1);
    expect(await get()).toBe(2);
    await cache.dispose();
  });

  it("applies an errorTtl independent of the value ttl", async () => {
    const { cache, advanceTime } = createTestCache();
    let calls = 0;
    const get = cache.cache(
      async () => {
        calls += 1;
        throw new Error(`fail ${calls}`);
      },
      { ttl: "5m", cacheErrors: true, errorTtl: "10s" },
    );

    await expect(get()).rejects.toThrow("fail 1");
    await advanceTime(11_000);
    await expect(get()).rejects.toThrow("fail 2");
    await cache.dispose();
  });

  it("uses the instance defaults when a function does not set a ttl", async () => {
    const { cache, advanceTime } = createTestCache({ defaults: { ttl: "1m" } });
    let calls = 0;
    const get = cache.cache(async () => {
      calls += 1;
      return calls;
    });

    expect(await get()).toBe(1);
    await advanceTime(2 * 60_000);
    expect(await get()).toBe(2);
    await cache.dispose();
  });
});

/**
 * Micro-benchmarks for rsc-cache.
 *
 * Run with `npm run bench`. These are indicative, reproducible numbers — not
 * marketing claims. Every scenario prints per-op cost on the current machine.
 */

import { performance } from "node:perf_hooks";
import { memoryStorage } from "../src/memory.js";
import { createCache } from "../src/create-cache.js";
import { createFakeClock } from "../src/clock.js";
import { resetCache } from "../src/global.js";
import { jsonSerializer } from "../src/serializer.js";

interface ScenarioResult {
  name: string;
  opsPerSecond: number;
  meanMs: number;
}

function bench(name: string, iterations: number, fn: () => void | Promise<void>): ScenarioResult {
  const started = performance.now();
  const outcome = fn();
  const finish = (elapsed: number): ScenarioResult => {
    const meanMs = elapsed / iterations;
    return { name, opsPerSecond: iterations / (elapsed / 1000), meanMs };
  };
  if (outcome instanceof Promise) {
    throw new Error("Use benchAsync for async scenarios");
  }
  return finish(performance.now() - started);
}

async function benchAsync(
  name: string,
  iterations: number,
  fn: () => Promise<unknown>,
): Promise<ScenarioResult> {
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    await fn();
  }
  const elapsed = performance.now() - started;
  return { name, opsPerSecond: iterations / (elapsed / 1000), meanMs: elapsed / iterations };
}

function report(results: ScenarioResult[]): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const result of results) {
    const name = result.name.padEnd(width, " ");
    console.log(`${name}  ${result.meanMs.toFixed(6)} ms/op  ${Math.round(result.opsPerSecond).toLocaleString("en-US")} ops/s`);
  }
}

async function main(): Promise<void> {
  const clock = createFakeClock(Date.now());
  const storage = memoryStorage({ clock, maxEntries: 10_000 });
  const cache = createCache({ storage, clock, namespace: "bench", register: false });

  const results: ScenarioResult[] = [];

  // 1. Cache hit (memory)
  const getHit = cache.cache(async (id: string) => id, { ttl: "1h" });
  await getHit("warm");
  results.push(await benchAsync("cache hit (memory)", 100_000, () => getHit("warm")));

  // 2. Cache miss (source function executes)
  let counter = 0;
  const getMiss = cache.cache(async (_id: string) => counter++, { ttl: "1h" });
  results.push(await benchAsync("cache miss (memory)", 10_000, () => getMiss(`miss-${counter}`)));

  // 3. Serialization round trip
  const payload = { users: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `user-${i}` })) };
  const serializer = jsonSerializer();
  results.push(
    await benchAsync("serialize + deserialize (json, 100 items)", 10_000, async () => {
      const bytes = await serializer.serialize(payload);
      return serializer.deserialize(bytes);
    }),
  );

  // 4. Key generation
  const getKey = getHit.key;
  results.push(
    bench("key generation (object args)", 200_000, () => {
      getKey("id-123");
    }),
  );

  // 5. Concurrent hits (100 in flight)
  results.push(
    await benchAsync("100 concurrent hits", 1_000, async () => {
      await Promise.all(Array.from({ length: 100 }, () => getHit("warm")));
    }),
  );

  // 6. Concurrent misses sharing one flight (100 callers, 1 computation)
  const shared = cache.cache(async (_key: string) => {
    counter += 1;
    return counter;
  }, { ttl: "1h" });
  let round = 0;
  results.push(
    await benchAsync("100 concurrent single-flight misses", 200, async () => {
      const key = `flight-${round++}`;
      await Promise.all(Array.from({ length: 100 }, () => shared(key)));
    }),
  );

  report(results);
  await cache.dispose();
  resetCache();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

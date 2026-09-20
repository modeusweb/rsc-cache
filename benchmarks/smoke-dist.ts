/**
 * Smoke test: verify the built dist can be imported and works end-to-end.
 * Run after `npm run build`.
 */

import { revalidateTag } from "../dist/index.js";
import { memoryStorage } from "../dist/memory.js";
import { createCache } from "../dist/index.js";

const instance = createCache({ storage: memoryStorage(), namespace: "smoke" });

let calls: number = 0;
const getProduct = instance.cache(async (id) => {
  calls += 1;
  return { id, name: `Product ${id}` };
}, { ttl: "5m", tags: (id) => [`product:${id}`] });

const expectCalls = (n: number): void => {
  if (calls !== n) throw new Error(`expected ${n} calls, got ${calls}`);
};

const a = await getProduct("1");
const b = await getProduct("1");
expectCalls(1);
if (a.name !== b.name) throw new Error("value mismatch");

await revalidateTag("product:1", { cache: instance });
await getProduct("1");
expectCalls(2);
const stats = instance.stats();
if (!stats.hits || !stats.misses) throw new Error("stats not tracked");

const generic = instance.cache(async (v) => v, { ttl: "1h" });
if ((await generic(42)) !== 42) throw new Error("generic identity failed");

await instance.dispose();
console.log("dist smoke test OK:", { calls, hitRate: stats.hitRate });

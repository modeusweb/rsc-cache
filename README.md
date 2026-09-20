# rsc-cache

Persistent caching for React Server Components.

## Why?

React's `cache()` is request-scoped: it deduplicates work *inside a single render* and forgets everything when the request ends. In a server environment the next request — and the next process — pays for the same data again.

`rsc-cache` adds the missing layer: a **persistent cache between requests**, with TTL, tag invalidation, stale-while-revalidate and single-flight, that works in Node, Bun, Deno, Cloudflare Workers and any other Web API-compatible runtime. It is not tied to Next.js.

```text
React cache()
        ↓  request-scoped memoization
rsc-cache
        ↓  persistent / distributed cache
Redis / Valkey / KV / memory / custom backend
```

### React cache() vs rsc-cache

| | React `cache()` | `rsc-cache` |
|---|---|---|
| Scope | one request / render | across requests, across processes |
| Purpose | deduplication / memoization | persistent caching |
| Persistent | no | yes |
| Tags / invalidation | no | yes |
| SWR | no | yes |
| Distributed | no | Redis / KV adapters |

They are **complements, not replacements**. `rsc-cache/react` stacks React's `cache()` on top of the persistent layer for you.

## Installation

```bash
npm install rsc-cache
```

The core has **zero runtime dependencies**. React is an optional peer dependency used only by `rsc-cache/react`.

## Quick Start

```ts
import { cache } from "rsc-cache";

export const getProduct = cache(
  async (id: string) => {
    return db.product.findUnique({ where: { id } });
  },
  {
    ttl: "5m",
    tags: (id) => [`product:${id}`],
  },
);
```

```tsx
// In a Server Component
async function Product({ id }: { id: string }) {
  const product = await getProduct(id); // miss → DB; hit → cache
  return <h1>{product.name}</h1>;
}
```

After a mutation:

```ts
await updateProduct(id, data);
await revalidateTag(`product:${id}`);
```

The next `getProduct(id)` call misses and recomputes. Only cache deterministic, read-oriented functions by default — mutations must invalidate explicitly, the library never assumes a function is safe to cache.

## TTL

Durations accept numbers (milliseconds) or strings:

```ts
cache(fn, { ttl: 60_000 });
cache(fn, { ttl: "60s" });
cache(fn, { ttl: "5m" });
cache(fn, { ttl: "1h" });
cache(fn, { ttl: "1d" });
```

## Tags

One entry can carry many tags; invalidating one tag removes every entry that has it:

```ts
const getProduct = cache(
  async (id: string) => db.product.find(id),
  {
    ttl: "5m",
    tags: (id) => [
      "products",
      "products:featured",
      `product:${id}`,
      "category:shoes",
    ],
  },
);

await revalidateTag("products");       // every entry tagged "products" is gone
await revalidateKey("homepage");       // key-based invalidation
await revalidateNamespace("products"); // whole namespace
await clearCache();                    // everything
await invalidate({ tags: ["products"], keys: ["homepage"] });
```

## Stale-While-Revalidate

```ts
cache(fn, {
  ttl: "5m",       // fresh for 5 minutes
  staleTtl: "30m", // then stale but usable for 30 more
});
```

In the stale window the cached value is returned immediately and revalidation happens in the background — single-flight, so 100 concurrent requests trigger at most one recomputation. A failed revalidation leaves the stale value in place (configurable with `onRevalidationError`). `revalidate: "blocking"` recomputes before answering instead.

Background tasks are **best-effort**: in serverless/edge runtimes use `backgroundTasks: { waitUntil: (task) => ctx.waitUntil(task) }` to hand the work to the platform.

## Storage backends

**Memory** (default, process-local):

```ts
import { memoryStorage } from "rsc-cache/memory";

const storage = memoryStorage({ maxEntries: 1000 }); // LRU eviction, TTL sweep, stats
```

**Redis / Valkey** — the core never imports a Redis client; you bring your own:

```ts
import { createClient } from "@redis/client";
import { createRedisStorage } from "rsc-cache/redis";

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const storage = createRedisStorage({ client, namespace: "my-app" });
```

Native TTL (`PX`), native tags (`SADD`/`SMEMBERS`), Lua-based atomic writes and tag invalidation, `SET NX PX` distributed locks for cross-process single-flight, compare-and-set writes so a slow revalidation cannot overwrite a newer value. `ioredis` and `@upstash/redis` work through the same structural client interface.

**Cloudflare KV / generic KV:**

```ts
import { createKvStorage } from "rsc-cache/kv";
const storage = createKvStorage({ binding: env.MY_KV });
```

**Custom storage** — implement the interface and pass it to `createCache`:

```ts
const storage: CacheStorage = {
  async get(key) { /* ... */ },
  async set(key, entry, options) { /* ... */ },
  async delete(key) { /* ... */ },
  async has(key) { /* ... */ },
  async clear(options) { /* ... */ },
  // optional: invalidateTag, close, addTags, compareAndSet, acquireLock
};
```

Works with Postgres, DynamoDB, MongoDB, filesystem, edge storage — anything.

## Multiple instances & global config

```ts
const productCache = createCache({ namespace: "products", storage });
const userCache = createCache({ namespace: "users", storage });
const getProduct = productCache.cache(fetchProduct, { ttl: "5m" });
```

Namespaces isolate the key space (`rsc-cache:v1:products:...`), so one storage can be shared by several apps. For the simplest case a global default exists:

```ts
import { configureCache } from "rsc-cache";
configureCache({ storage, namespace: "app", defaults: { ttl: "5m" } });
```

## Next.js

`rsc-cache/next` bridges Next.js without coupling the core to it (the core never imports `next/*`). Inside Server Components prefer `rsc-cache/react`; inside Server Functions use `revalidateTag` after mutations. See the `next` module docs for `createNextCache`.

## Vite / other RSC setups

The core is framework-agnostic; Vite RSC, React Router RSC, TanStack Start and `@lazarv/rsc` all consume the same `cache()` / `createCache()` API. The only bundler-facing part is `rsc-cache/react`, which uses public React APIs (`cache()`, `cacheSignal()`).

## Edge

The core is built on Web APIs only (`Promise`, `AbortController`, `Uint8Array`, `crypto.subtle`, `TextEncoder`). No Node-only imports ship in `rsc-cache`. Runtime caveats:

- **AWS Lambda / Vercel Functions**: memory storage is per-instance and ephemeral; use Redis for shared state. Background revalidation may be cut short after the response.
- **Cloudflare Workers**: use the `kv` adapter and pass `waitUntil` for background revalidation.
- **Deno Deploy / Bun**: supported; memory storage is process-local.

## User-scoped cache

Never let per-user data leak into a shared cache. Use scopes:

```ts
const getDashboard = cache(
  async () => getDashboardFromDB(),
  {
    ttl: "1m",
    visibility: "private",
    scope: ({ context }) => [context.tenantId, context.userId],
  },
);

// During a request:
withCacheContext({ userId: "123", tenantId: "acme" }, () => getDashboard());
```

The scope is part of the key, so `user:123` and `user:456` never share entries. Argument-derived keys are always hashed (SHA-256) before they reach storage — no raw emails, tokens or passwords in Redis keys.

## Security

Read [SECURITY.md](./SECURITY.md). Summary: keys are normalized and hashed, namespaces isolate tenants, `visibility: "private"` requires a resolvable scope, the serializer never executes code (no `eval`/`new Function`), cache failures are fail-open by default, and logs/events contain hashed key identifiers — never raw user input.

## Performance

Run the included benchmark suite:

```bash
npm run bench
```

Scenarios: cache hit, cache miss, serialization, key generation, 100 concurrent hits, 100 concurrent single-flight misses. Numbers are printed for your machine; no cross-library claims are made without reproduction.

## Testing

```ts
import { createTestCache, createMockStorage, createFakeRedisClient } from "rsc-cache/testing";

const { cache, clock, dispose } = createTestCache();
const getProduct = cache.cache(fn, { ttl: "5m" });
await getProduct("1");
clock.advance(6 * 60_000);        // TTL testing without sleeping
await getProduct("1");            // miss again
await dispose();
```

`createMockStorage()` supports failure injection and shared backends for multi-process simulations; `createFakeRedisClient()` exercises the Redis adapter without a server.

## API reference

### `cache(fn, options?)`

Wraps any function preserving its full TypeScript signature (including generics). Extras on the returned function: `.name`, `.namespace`, `.key(...args)`, `.tags(...args)`, `.prefetch(...args)`, `.revalidate(...args)`, `.invalidate()`, `.stats()`, `.diagnostics()`, `.instance`.

### Cache options

| Option | Default | Description |
|---|---|---|
| `ttl` | required for caching | `number` (ms) or `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"` |
| `staleTtl` | – | stale-while-revalidate window |
| `tags` | – | static array or `(…args) => string[]` |
| `key` | derived | custom logical key or resolver |
| `namespace` | instance | key namespace |
| `version` | – | schema version; bump to invalidate everything |
| `serialize` / `compression` | JSON / none | storage format |
| `cacheErrors` / `errorTtl` | false / 10s | negative caching of failures |
| `cacheNull` | false | cache `null`/`undefined` results |
| `enabled` | true | static or runtime switch |
| `revalidate` | `"background"` | stale handling mode |
| `scope` / `visibility` | – | user/tenant isolation |
| `maxValueSize` | 1 MiB | rejects oversized payloads with a clear error |
| `maxKeyLength` | 200 | longer keys are hashed |
| `passSignal` | false | forwards `AbortSignal` as the last argument |
| `strictInvalidation` | – | tombstone check on write (closes the invalidate/write race) |
| `distributedLock` | off | cross-process single-flight (Redis locks) |

### Instance options (`createCache`)

`storage`, `namespace`, `version`, `defaults`, `failureMode` / `readFailureMode` / `writeFailureMode`, `timeouts`, `debug`, `onEvent`, `clock`, `register`, `distributedLock`, `backgroundTasks`, `includeKeysInEvents`.

### Invalidation

`revalidateTag(tag, {cache?})`, `revalidateKey(key, {cache?})`, `revalidateNamespace(ns, {cache?})`, `clearCache({cache?})`, `invalidate({ tags, keys, namespaces })`.

### Observability

```ts
createCache({
  onEvent(event) { /* { type: "hit", namespace, keyHash, durationMs, ... } */ },
});
instance.stats(); // { hits, misses, staleHits, errors, revalidations, evictions, hitRate }
```

`rsc-cache/opentelemetry` provides optional spans (`rsc.cache.get/set/revalidate`) with hashed keys only — never raw PII.

## Architecture

```text
                    React RSC
                       │
                       ▼
                ┌──────────────┐
                │ React cache  │   request memoization
                └──────┬───────┘
                       ▼
                ┌──────────────┐
                │ rsc-cache    │   TTL, tags, SWR, single-flight,
                └──────┬───────┘   stats, serialization
             ┌─────────┼──────────┐
             ▼         ▼          ▼
          Memory     Redis       KV / custom
             │         │          │
             └─────────┼──────────┘
                       ▼
                Database / API
```

Internally: `cache-function` (typed wrapper) → `runtime` (miss/hit/stale/lock/CAS logic) → `single-flight` (in-process coalescing) → `storage` (memory / redis / kv / custom). The tag index, invalidation tombstones and revision-based compare-and-set live between runtime and storage. The `cli` ships an `rsc-cache doctor` command. See [COMPETITIVE_ANALYSIS.md](./COMPETITIVE_ANALYSIS.md) for how this compares with React `cache`, Next.js caching, TanStack Query and friends.

## License

MIT


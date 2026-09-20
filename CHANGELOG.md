# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-20

Initial release.

### Added

- `cache()` — type-safe persistent caching wrapper preserving full function signatures and generics.
- `createCache()` — isolated cache instances with namespace, storage, defaults, failure modes, timeouts, event hooks and debug mode.
- `configureCache()` — global default instance for the zero-config happy path.
- Memory storage with TTL, LRU eviction, `maxEntries`, statistics and injectable clock.
- Redis/Valkey adapter (`rsc-cache/redis`) with native TTL, native tags, Lua atomic writes, compare-and-set revisions, distributed locks (`SET NX PX`) and structural client interface compatible with `@redis/client`, `ioredis` and Upstash.
- Cloudflare KV / generic KV adapter (`rsc-cache/kv`).
- TTL parsing for `number` and duration strings (`"500ms"`, `"30s"`, `"5m"`, `"1h"`, `"1d"`).
- Tags with static and argument-derived resolvers; `revalidateTag`, `revalidateKey`, `revalidateNamespace`, `clearCache`, `invalidate()`.
- Stale-while-revalidate with background single-flight revalidation; `blocking` and `background` modes.
- Single-flight / request coalescing with abort-aware cancellation (shared computations abort only when all consumers are gone).
- Distributed single-flight via optional storage locks with configurable `failure: "proceed" | "throw"`.
- Stable, hashed key generation (strings, numbers, booleans, null/undefined, arrays, objects, Date, URL, BigInt, nested structures; property-order-independent; cycle-safe).
- Serialization abstraction (JSON default, strict JSON variant), compression provider hook.
- Negative caching (`cacheErrors`, `errorTtl`, `cacheNull`).
- Request context (`createCacheContext`, `withCacheContext`, `createRequestCache`) with user/tenant scoping and `visibility: "public" | "private"`.
- Observability: event bus (`onEvent`), counters (`stats()`), debug logging with redaction, optional OpenTelemetry integration (`rsc-cache/opentelemetry`).
- React integration (`rsc-cache/react`) layering React `cache()` + `cacheSignal()` over the persistent layer.
- Next.js bridge (`rsc-cache/next`), CLI (`rsc-cache doctor`).
- Testing utilities (`rsc-cache/testing`): `createTestCache` with fake clock and `advanceTime`, `createMockStorage` with failure injection and shared backends, `createFakeRedisClient` implementing the Redis contract and Lua script simulators.
- Race-condition protections: revision-based compare-and-set prevents stale overwrites; strict invalidation tombstones close the invalidate/write race.
- Benchmark suite (`npm run bench`).
- ESM-first package with exports map, declaration files, sourcemaps, tree-shakable, zero runtime dependencies.

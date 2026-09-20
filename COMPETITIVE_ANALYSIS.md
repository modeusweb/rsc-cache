# Competitive Analysis

How existing solutions relate to `rsc-cache`. What each one solves, what it does not, and where the gaps are that motivated this library. Verified against the React documentation and npm registry as of September 2026.

## React `cache()`

- **What it solves:** request-scoped memoization during a single RSC render. Deduplicates identical calls with identical arguments inside one render pass.
- **What it doesn't solve:** anything past the request. No persistence, no TTL, no tags, no invalidation, no cross-process behaviour.
- **API:** `cache(fn)` — argument-identity memo.
- **Scope:** one render. **Persistence:** no. **Invalidation:** none (lifetime = render). **Framework coupling:** none (public React API, but RSC-only). **Edge:** yes. **Distributed:** no.
- **rsc-cache relationship:** complementary layer. `rsc-cache/react` wraps `cache()` on top of the persistent cache — the two lifetimes stay strictly separate.

## React `cacheSignal()` (React 19.2+ canary/RSC)

- **What it solves:** an `AbortSignal` for the current render so server work can be cancelled when the render is discarded.
- **What it doesn't solve:** caching at all. Also unavailable on the client and on stable React releases depending on channel.
- **Scope:** one render. **Persistence:** no. **Invalidation:** n/a. **Framework coupling:** React internals of the RSC runtime — deliberately isolated in `rsc-cache/react` (the core never imports React).
- **rsc-cache relationship:** used (when available) to attach cancellation to computations; a shared single-flight computation is aborted only when *all* consumers are gone.

## Next.js caching (`unstable_cache` / current cache primitives, fetch cache)

- **What it solves:** persistent caching *inside Next.js*, including `revalidateTag`-based invalidation and ISR-style revalidation.
- **What it doesn't solve:** portability. The API and semantics are Next-owned; behaviour differs across Next versions (`unstable_cache` has been deprecated/reworked repeatedly), works only where Next's incremental cache is configured, and tag invalidation is tied to Next's runtime.
- **API:** `unstable_cache(fn, keyParts, { tags, revalidate })` → newer `use cache` directive.
- **Scope:** cross-request, framework-managed. **Persistence:** yes (Next's cache handler). **Invalidation:** yes (tags/time). **Framework coupling:** total. **Edge:** yes in Next. **Distributed:** via cache handler.
- **rsc-cache relationship:** same problem domain, framework-agnostic answer. `rsc-cache/next` can bridge to Next invalidation without depending on it.

## Vercel cache primitives (`"use cache"`, cache handlers)

- **What it solves:** directive-based caching for the Vercel platform with per-request or build-time persistence.
- **What it doesn't solve:** non-Vercel deploys, custom storage (handler API exists but is Vercel-shaped), portability to Vite RSC / React Router RSC / TanStack Start.
- **Scope:** framework-managed. **Persistence:** platform. **Invalidation:** tags/profile. **Coupling:** Next/VDX. **Edge:** yes. **Distributed:** platform.
- **rsc-cache relationship:** explicit API (`cache(fn, { ttl, tags })`) over storage you own, identical semantics on any RSC stack.

## Apollo Client cache

- **What it solves:** normalized client-side GraphQL caching with entity-based invalidation.
- **What it doesn't solve:** server-side RSC data fetching; it is a client runtime, heavy for server-only use, GraphQL-coupled.
- **Scope:** browser/session. **Persistence:** optional client. **Invalidation:** entity GC. **Coupling:** GraphQL. **Edge:** no (client). **Distributed:** no.
- **rsc-cache relationship:** different layer entirely (client vs server).

## TanStack Query

- **What it solves:** async state management with caching, retries, SWR semantics — dominant for client SPAs, has server integrations.
- **What it doesn't solve:** RSC-native caching; its QueryClient is designed for interactive lifetimes, not per-request server rendering. Tag invalidation is manual (`invalidateQueries`), persistence is opt-in.
- **Scope:** client/session (server: per-request plumbing). **Persistence:** opt-in. **Invalidation:** query keys. **Coupling:** framework-light. **Edge:** runtime-dependent. **Distributed:** no (it is not a shared cache).
- **rsc-cache relationship:** `rsc-cache` is server-first and storage-backed; TanStack Query remains the right tool for client state.

## `@lazarv/rsc`

- **What it solves:** a standalone RSC server framework with its own conventions.
- **What it doesn't solve:** persistent caching as a first-class concern; per-framework, single-project focus.
- **Scope:** application. **Persistence:** framework-specific. **Invalidation:** ad hoc. **Coupling:** own runtime. **Edge:** limited. **Distributed:** no.
- **rsc-cache relationship:** compatible host; `rsc-cache` provides the cache layer it lacks.

## Existing npm RSC cache packages

A registry search for "rsc cache" returns a handful of small packages, mostly thin wrappers around `unstable_cache` or Next fetch-cache options, frequently unmaintained and version-pinned to specific Next internals. None offer: custom storage adapters, framework independence, distributed locks, CAS revisions, or a testing surface. **Naming:** the `rsc-cache` name was checked against npm before publishing this package.

## Redis caching libraries (`cache-manager`, `node-cache` etc.)

- **What they solve:** generic key-value caching with stores and TTL.
- **What they don't solve:** RSC awareness, tag resolvers derived from arguments, SWR semantics with single-flight revalidation, React/render-lifetime integration, request-context scoping, type-preserving wrappers (most lose the wrapped function's generics).
- **rsc-cache relationship:** rsc-cache's storage interface can be implemented on top of them, but their semantics alone do not cover the RSC use case.

## Summary of differentiators

| Capability | React cache | Next cache | TanStack Query | cache-manager | **rsc-cache** |
|---|---|---|---|---|---|
| Request dedup | ✅ | ✅ | ✅ | ❌ | ✅ |
| Persistent | ❌ | ✅ (Next) | opt-in | ✅ | ✅ |
| Tag invalidation | ❌ | ✅ (Next) | keys | ❌ | ✅ |
| SWR + single-flight | ❌ | partial | ✅ client | ❌ | ✅ |
| Distributed lock | ❌ | via handler | ❌ | ❌ | ✅ |
| Framework-agnostic | ✅ | ❌ | ✅ | ✅ | ✅ |
| RSC-aware cancellation | ❌ | ❌ | ❌ | ❌ | ✅ |
| CAS / stale-overwrite protection | ❌ | internal | ❌ | ❌ | ✅ |
| Test utilities (fake clock) | ❌ | ❌ | partial | ❌ | ✅ |

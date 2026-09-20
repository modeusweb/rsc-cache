/**
 * rsc-cache — public type definitions.
 *
 * These types describe the stable surface of the library: cache options,
 * storage contract, entries, events, statistics and the cache instance API.
 */

export type MaybePromise<T> = T | Promise<T>;

/** A duration in milliseconds (`60_000`) or a human readable string (`"5m"`). */
export type Duration = number | string;

/** Whether a cache entry may be shared between users/requests. */
export type Visibility = "public" | "private";

/** Revalidation strategy applied when an entry is stale but still usable. */
export type RevalidateMode = "blocking" | "background";

/** Behavior when the cache backend fails. */
export type FailureMode = "fail-open" | "fail-closed";

/** What an entry payload represents. */
export type EntryState = "value" | "null" | "error";

export type AnyFunction = (...args: any[]) => any;

/** Injectable time source. Production uses {@link systemClock}, tests use a fake clock. */
export interface Clock {
  now(): number;
}

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/**
 * Converts values to bytes and back.
 *
 * Implementations must be pure data transformations: they must never execute
 * code contained in the payload (no `eval`, no `new Function`, no `vm`).
 */
export interface Serializer {
  /** Stable identifier stored with entries so incompatible serializers never mix. */
  readonly name?: string;
  serialize(value: unknown): MaybePromise<Uint8Array>;
  deserialize(bytes: Uint8Array): MaybePromise<unknown>;
}

/** Optional byte-level compression provider (applied to the serialized payload). */
export interface CompressionProvider {
  readonly name: string;
  compress(bytes: Uint8Array): MaybePromise<Uint8Array>;
  decompress(bytes: Uint8Array): MaybePromise<Uint8Array>;
}

/**
 * A cache entry as handed to and returned from storage.
 *
 * Freshness is decided from `createdAt` / `expiresAt` / `staleUntil` using the
 * cache clock. Storages only persist entries; they never reinterpret them.
 */
export interface CacheEntry {
  /** Serialized (and optionally compressed) payload. */
  value: Uint8Array;
  /** Absolute creation time in milliseconds. */
  createdAt: number;
  /** Absolute time after which the entry is not usable at all (`Infinity` = never). */
  expiresAt: number;
  /** Absolute end of the stale-but-usable window, if any. */
  staleUntil?: number;
  /** Monotonic per-key revision, used for stale-overwrite protection. */
  revision: number;
  /** `value` | `null` | `error` — negative caching and error caching use this. */
  state?: EntryState;
  /** User supplied schema version. */
  version?: string;
  /** Namespace this entry belongs to (introspection/clear helper). */
  namespace?: string;
  visibility?: Visibility;
  /** Tags attached to this entry (self describing; the tag index is separate). */
  tags?: readonly string[];
  /** Compression provider that produced `value`, if any. */
  compressed?: string;
  /** Serializer that produced `value`, if any. */
  serializer?: string;
  /** Free-form, JSON-serializable user metadata. */
  metadata?: Record<string, unknown>;
  /** Human readable label (function name) for debugging. */
  label?: string;
}

/** Operational hints passed to {@link CacheStorage.set}. */
export interface StorageSetOptions {
  /** Relative TTL in milliseconds (used for storage-native expiry such as Redis `PX`). */
  ttlMs?: number;
  /** Relative stale window in milliseconds. */
  staleTtlMs?: number;
  /** Absolute expiry (cache clock) — stored in the entry, repeated here for convenience. */
  expiresAt?: number;
  /** Absolute stale deadline (cache clock). */
  staleUntil?: number;
  tags?: readonly string[];
  version?: string;
  metadata?: Record<string, unknown>;
  /** Compare-and-set precondition: the stored revision must equal this value (`null` = key absent). */
  expectedRevision?: number | null;
  /** Refuse to overwrite a stored entry whose revision is greater or equal. */
  onlyIfNewer?: boolean;
}

export interface StorageClearOptions {
  /** Delete only keys starting with this prefix. */
  prefix?: string;
  /** Delete only keys of this namespace (storage specific). */
  namespace?: string;
}

export interface StorageTagScope {
  namespace?: string;
}

export interface LockOptions {
  /** Lock lifetime in milliseconds. */
  ttlMs: number;
  /** Opaque token used to ensure only the owner can release the lock. */
  token?: string;
}

export interface CacheLock {
  readonly key: string;
  readonly token: string;
  release(): Promise<void>;
  extend?(ttlMs: number): Promise<boolean>;
}

/** Events emitted by storages that can report internal activity (evictions, expirations). */
export interface StorageEvent {
  type: "eviction" | "expiration" | "clear" | "error";
  key?: string;
  reason?: string;
  count?: number;
}

export interface ObservableStorage {
  observe(listener: (event: StorageEvent) => void): () => void;
}

/**
 * Minimal, replaceable storage contract.
 *
 * Only `get`, `set`, `delete` and `has` are required. All other members are
 * optional capabilities that unlock stronger guarantees (atomic tag
 * invalidation, distributed locks, compare-and-set writes).
 */
export interface CacheStorage {
  /** Backend name used in events/metrics (for example `"memory"`, `"redis"`). */
  readonly name?: string;
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry, options?: StorageSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(options?: StorageClearOptions): Promise<void>;
  /** Atomic write-if-revision-matches. Returns `true` when the write happened. */
  compareAndSet?(
    key: string,
    entry: CacheEntry,
    expectedRevision: number | null,
    options?: StorageSetOptions,
  ): Promise<boolean>;
  deleteMany?(keys: readonly string[]): Promise<void>;
  /** Register tag associations for a key (native tag index). */
  addTags?(key: string, tags: readonly string[], scope?: StorageTagScope): Promise<void>;
  /** Remove every entry carrying `tag` (native tag invalidation). */
  invalidateTag?(tag: string, scope?: StorageTagScope): Promise<void>;
  /** Best-effort distributed lock used by single-flight across processes. */
  acquireLock?(key: string, options: LockOptions): Promise<CacheLock | null>;
  close?(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

/** Request-scoped data available to key/scope/tag resolution. */
export interface CacheContext {
  /** Unique id of the current request/render (used for tracing and statistics). */
  requestId?: string;
  /** Authenticated user id. Never used in storage keys directly (always hashed). */
  userId?: string;
  /** Tenant / organization id. */
  tenantId?: string;
  /** Locale, when the app is localized. */
  locale?: string;
  /** Default visibility for cache calls in this context. */
  visibility?: Visibility;
  /** Cancellation signal of the current request/render. */
  signal?: AbortSignal;
  /** Request-scoped memoization store. */
  requestCache?: RequestCache;
  /** Arbitrary application metadata (available to `scope`, never persisted by default). */
  metadata?: Record<string, unknown>;
}

export interface CacheContextInit extends Omit<CacheContext, "requestCache"> {
  requestCache?: RequestCache;
}

/** Information passed to dynamic option resolvers (`scope`, `tags`, custom `key`). */
export interface CacheCallInfo<Args extends unknown[] = unknown[]> {
  args: Args;
  /** Context of the current call (merged request context). */
  context: CacheContext;
  clock: Clock;
  signal?: AbortSignal;
  cache: {
    namespace: string;
    name?: string;
    version?: string;
  };
}

export type ScopePart = string | number | bigint | null | undefined;

/**
 * Isolates entries per user/tenant/region.
 *
 * A scope makes the cache private by default: two different scope values can
 * never observe each other's entries.
 */
export type ScopeOption<Args extends unknown[] = unknown[]> =
  | ScopePart
  | readonly ScopePart[]
  | ((call: CacheCallInfo<Args>) => ScopePart | readonly ScopePart[] | null | undefined);

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface CacheOptions<Args extends unknown[] = unknown[]> {
  /** Time to live. `number` is milliseconds, strings support `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"`. */
  ttl?: Duration;
  /** Extra window after `ttl` during which the stale value is still served. */
  staleTtl?: Duration;
  /** Static tags or a resolver deriving tags from the call arguments. */
  tags?: readonly string[] | ((...args: Args) => readonly string[] | null | undefined);
  /** Explicit logical key, or a resolver. Overrides the default argument-derived key. */
  key?: string | ((...args: Args) => string);
  /** Namespace override for this function. */
  namespace?: string;
  /** Schema version. Changing it invalidates all previously written entries. */
  version?: string;
  /** Serializer override (must be compatible with previously written entries). */
  serialize?: Serializer;
  /** Compression override. */
  compression?: CompressionProvider;
  /** Cache thrown errors too (negative caching of failures). Default `false`. */
  cacheErrors?: boolean;
  /** TTL used for cached errors. Defaults to 10s. */
  errorTtl?: Duration;
  /** Cache `null`/`undefined` results. Default `false`. */
  cacheNull?: boolean;
  /** Turn caching on/off at runtime. Default `true`. */
  enabled?: boolean | (() => boolean);
  /** How to treat a stale-but-usable entry. Defaults to `"background"` when `staleTtl` is set. */
  revalidate?: RevalidateMode;
  /** Extra metadata persisted with the entry (must be JSON-serializable). */
  metadata?: Record<string, unknown>;
  /** Human readable name used in events, logs and key material. Defaults to `fn.name`. */
  name?: string;
  /**
   * How the function identity participates in the key.
   * - `"auto"` (default): explicit `name` when provided, otherwise `name + source hash`.
   * - `"name"`: only the name (stable across builds, caller's responsibility).
   * - `"source"`: always hash the function source (unstable across builds/minifiers).
   */
  keyIdentity?: "auto" | "name" | "source";
  /** Isolation scope (user/tenant/region). */
  scope?: ScopeOption<Args>;
  /** `"public"` entries may be shared; `"private"` entries require a resolvable scope. */
  visibility?: Visibility;
  /** Maximum serialized payload size in bytes. Default 1 MiB. */
  maxValueSize?: number;
  /** Maximum storage key length before the key gets hashed. Default 200. */
  maxKeyLength?: number;
  /**
   * Append the call `AbortSignal` as the last argument of the source function.
   * Default `false` — enable it when your data source accepts a signal.
   */
  passSignal?: boolean;
  /** What to return when a blocking revalidation fails: the stale value or the error. */
  onRevalidationError?: "stale" | "throw";
  /** Use the request-scoped memo store when a context is present. Default `true`. */
  requestMemo?: boolean;
  /** Check invalidation tombstones before writing (closes the invalidate/write race). */
  strictInvalidation?: boolean;
  /** Use a distributed lock when the storage supports it. */
  distributedLock?: boolean | DistributedLockOptions;
}

export interface DistributedLockOptions {
  enabled?: boolean;
  /** Lock lifetime (storage TTL). Default `"10s"`. */
  ttl?: Duration;
  /** How long to wait for another process to populate the cache. Default `"5s"`. */
  wait?: Duration;
  /** Poll interval while waiting for the lock holder. Default `"50ms"`. */
  pollInterval?: Duration;
  /** What to do when the lock cannot be acquired in time. Default `"proceed"`. */
  failure?: "proceed" | "throw";
}

export interface CacheTimeouts {
  /** Applies to all storage operations unless a more specific timeout is set. */
  default?: Duration;
  read?: Duration;
  write?: Duration;
  lock?: Duration;
  invalidate?: Duration;
}

export interface BackgroundTaskOptions {
  /**
   * How background revalidation tasks are handled.
   *
   * - `"detached"` (default): fire and forget, best effort.
   * - a function: hand the promise to the runtime, e.g. `(task) => ctx.waitUntil(task)`.
   */
  waitUntil?: (task: Promise<void>) => void;
}

/**
 * Defaults applied to every cached function of a cache instance.
 *
 * Same shape as {@link CacheOptions}: a default may provide anything a
 * per-function option can, except the key/tag resolvers that depend on a
 * specific function signature.
 */
export type DefaultCacheOptions<Args extends unknown[] = unknown[]> = CacheOptions<Args>;

/* -------------------------------------------------------------------------- */
/* Observability                                                              */
/* -------------------------------------------------------------------------- */

export type CacheEventType =
  | "hit"
  | "miss"
  | "stale"
  | "set"
  | "delete"
  | "revalidate"
  | "error"
  | "eviction"
  | "bypass"
  | "conflict"
  | "lock"
  | "clear";

/**
 * Structured observability event.
 *
 * `key` is a redacted, hashed identifier unless the cache was created with
 * `exposeKeys: true`. Never log raw user input from these events.
 */
export interface CacheEvent {
  type: CacheEventType;
  /** Namespace of the cache instance. */
  cache: string;
  /** Namespace of the entry. */
  namespace: string;
  /** Function label, when the event originates from a cached function. */
  name?: string;
  /** Redacted key (hashed) or the full key when `exposeKeys` is enabled. */
  key: string;
  /** Short hash of the full storage key. */
  keyHash: string;
  /** Backend name, when available. */
  backend?: string;
  tags?: readonly string[];
  /** Duration of the operation in milliseconds, when measurable. */
  duration?: number;
  hit?: boolean;
  stale?: boolean;
  /** Machine readable outcome: `"stored"`, `"too-large"`, `"conflict"`, `"fail-open"`, ... */
  outcome?: string;
  error?: Error;
  requestId?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface CacheEventInfo<Args extends unknown[] = unknown[]> {
  args: Args;
  context: CacheContext;
  /** Full storage key (use with care: may contain hashed user material only). */
  key: string;
  namespace: string;
  name?: string;
}

export type CacheEventHandler = (event: CacheEvent, info: CacheEventInfo) => void;

export interface CacheEventHandlers {
  onHit?: CacheEventHandler;
  onMiss?: CacheEventHandler;
  onStale?: CacheEventHandler;
  onSet?: CacheEventHandler;
  onDelete?: CacheEventHandler;
  onRevalidate?: CacheEventHandler;
  onError?: CacheEventHandler;
  onEviction?: CacheEventHandler;
  onBypass?: CacheEventHandler;
  onConflict?: CacheEventHandler;
  onLock?: CacheEventHandler;
  onClear?: CacheEventHandler;
}

export type CacheOperation =
  | "get"
  | "set"
  | "delete"
  | "invalidate"
  | "lock"
  | "source";

export interface CacheOperationMeta {
  operation: CacheOperation;
  cache: string;
  namespace: string;
  name?: string;
  keyHash: string;
  backend?: string;
  tags?: readonly string[];
  hit?: boolean;
  stale?: boolean;
}

/** Low-level instrumentation hook (OpenTelemetry and friends plug in here). */
export interface CacheInstrumentation {
  wrapOperation?<T>(
    operation: CacheOperation,
    meta: CacheOperationMeta,
    run: () => Promise<T>,
  ): Promise<T>;
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

export interface CacheStatsSnapshot {
  hits: number;
  misses: number;
  staleHits: number;
  sets: number;
  deletes: number;
  errors: number;
  revalidations: number;
  backgroundRevalidations: number;
  evictions: number;
  conflicts: number;
  bypasses: number;
  skipped: number;
  locks: number;
  /** hits / (hits + misses + staleHits), `0` when there was no lookup. */
  hitRate: number;
  /** hits + misses + staleHits. */
  lookups: number;
}

export interface CacheDiagnostics {
  /** In-flight single-flight computations. */
  inflight: number;
  /** Keys currently being computed. */
  inflightKeys: string[];
  /** Entries memoized in the active request context (0 outside of a request). */
  requestMemoSize: number;
  /** Background revalidation tasks that have not settled yet. */
  backgroundTasks: number;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

export interface InvalidateOptions {
  tags?: readonly string[];
  /** Logical keys (as produced by `cachedFn.key(...)` or a custom `key`). */
  keys?: readonly string[];
  namespaces?: readonly string[];
  /** Restrict the invalidation to a specific cache instance (namespace). */
  cache?: string;
}

export interface InvalidateResult {
  tags: number;
  keys: number;
  namespaces: number;
  /** Number of entry keys that were deleted through the tag index. */
  entries: number;
}

export interface PrefetchOptions {
  /** Recompute even when a fresh entry exists. Default `false`. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface PrefetchResult<T = unknown> {
  value: T | undefined;
  /** `true` when a usable entry answered the call without running the source. */
  hit: boolean;
  source: "cache" | "stale" | "source" | "skipped";
}

export interface WarmupOptions {
  /** Maximum number of concurrent warmup calls. Default 5. */
  concurrency?: number;
  /** Collect errors instead of rejecting on the first failure. Default `true`. */
  continueOnError?: boolean;
}

export interface WarmupResult {
  total: number;
  succeeded: number;
  failed: number;
  duration: number;
  errors: Array<{ index: number; error: Error }>;
}

export interface CacheGetOptions {
  namespace?: string;
  /** Treat entries inside the stale window as usable. Default `false`. */
  allowStale?: boolean;
  serializer?: Serializer;
  compression?: CompressionProvider;
}

export interface CacheSetOptions {
  namespace?: string;
  ttl?: Duration;
  staleTtl?: Duration;
  tags?: readonly string[];
  version?: string;
  metadata?: Record<string, unknown>;
  visibility?: Visibility;
  serializer?: Serializer;
  compression?: CompressionProvider;
  /** Revision precondition (`null` = key must not exist). */
  expectedRevision?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Cache instance                                                             */
/* -------------------------------------------------------------------------- */

export interface CreateCacheOptions {
  /** Namespace isolates this cache from other caches sharing the same storage. */
  namespace?: string;
  /** Root key prefix. Default `"rsc-cache"`. */
  prefix?: string;
  storage?: CacheStorage;
  serializer?: Serializer;
  compression?: CompressionProvider;
  clock?: Clock;
  /** Defaults applied to every cached function of this instance. */
  defaults?: CacheOptions<unknown[]>;
  /** Default schema version for this instance. */
  version?: string;
  debug?: boolean;
  logger?: Logger;
  /** Single sink for every event. */
  onEvent?: (event: CacheEvent) => void;
  /** Fine grained handlers. */
  hooks?: CacheEventHandlers;
  instrumentation?: CacheInstrumentation;
  timeouts?: CacheTimeouts;
  /** Behavior when the storage fails. Default `"fail-open"`. */
  failureMode?: FailureMode;
  readFailureMode?: FailureMode;
  writeFailureMode?: FailureMode;
  distributedLock?: boolean | DistributedLockOptions;
  backgroundTasks?: BackgroundTaskOptions;
  /** Include full keys in events. Default `false` (hashed keys only). */
  exposeKeys?: boolean;
  /** Register the instance in the global registry used by the standalone helpers. Default `true`. */
  register?: boolean;
}

/**
 * An isolated cache with its own namespace, storage binding and statistics.
 *
 * Use `createCache()` when you need dependency injection (tests, multi-tenant
 * setups, several backends). Use the standalone `cache()` for the happy path.
 */
export interface CacheInstance {
  readonly namespace: string;
  readonly prefix: string;
  readonly storage: CacheStorage;
  readonly clock: Clock;
  /** Wrap a function with this instance's configuration. */
  cache<F extends AnyFunction>(
    fn: F,
    options?: CacheOptions<Parameters<F>>,
  ): CachedFunction<F>;
  /** Raw read of a logical key (bypasses function wrappers). */
  get<T = unknown>(key: string, options?: CacheGetOptions): Promise<T | undefined>;
  /** Raw write of a logical key. */
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  delete(key: string, options?: { namespace?: string }): Promise<boolean>;
  has(key: string, options?: { namespace?: string }): Promise<boolean>;
  revalidateTag(tag: string): Promise<void>;
  revalidateKey(key: string, options?: { namespace?: string }): Promise<void>;
  revalidateNamespace(namespace?: string): Promise<void>;
  invalidate(options: InvalidateOptions): Promise<InvalidateResult>;
  clear(options?: { namespace?: string }): Promise<void>;
  stats(): CacheStatsSnapshot;
  resetStats(): void;
  /** In-flight computations, background tasks and request memo size. */
  diagnostics(): CacheDiagnostics;
  /** Wait for background revalidations to settle (tests, graceful shutdown). */
  flushBackgroundTasks(): Promise<void>;
  /** Close the storage (when owned) and unregister the instance. */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Cached function                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Extra methods attached to a cached function. The call signature of the
 * original function is preserved exactly (including generics).
 */
export interface CachedFunctionExtras<F extends AnyFunction> {
  /** Label used in keys/events (defaults to the source function name). */
  readonly name: string;
  readonly namespace: string;
  readonly version?: string;
  /** The cache instance owning this function. */
  readonly instance: CacheInstance;
  /** Full storage key for the given arguments. */
  key(...args: Parameters<F>): string;
  /** Tags for the given arguments. */
  tags(...args: Parameters<F>): readonly string[];
  /** Run the cached function and resolve the value (used for warming). */
  prefetch(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
  /** Force recomputation, store the result and return it. */
  revalidate(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
  /** Delete the entry for the given arguments. */
  invalidate(...args: Parameters<F>): Promise<void>;
  stats(): CacheStatsSnapshot;
  diagnostics(): CacheDiagnostics;
}

export type CachedFunction<F extends AnyFunction> = F & CachedFunctionExtras<F>;

/* -------------------------------------------------------------------------- */
/* Request-scoped memoization                                                 */
/* -------------------------------------------------------------------------- */

export interface RequestCache {
  /** Number of memoized entries. */
  readonly size: number;
  run<T>(key: string, tags: readonly string[], factory: () => Promise<T>): Promise<T>;
  /** Read a memoized promise without scheduling work. */
  peek<T>(key: string): Promise<T> | undefined;
  evict(keys: readonly string[]): void;
  evictByTags(tags: readonly string[]): void;
  clear(): void;
}

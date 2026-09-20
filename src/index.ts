/**
 * rsc-cache — persistent caching for React Server Components.
 *
 * Entry points:
 *
 * - `rsc-cache`              — core API (framework agnostic, zero dependencies)
 * - `rsc-cache/memory`       — memory storage
 * - `rsc-cache/redis`        — Redis/Valkey (and any Redis-compatible client)
 * - `rsc-cache/kv`           — generic key/value storages (Workers KV, Deno KV, ...)
 * - `rsc-cache/react`        — React `cache()` + `cacheSignal()` integration
 * - `rsc-cache/next`         — Next.js bridge (optional, no `next/*` import)
 * - `rsc-cache/opentelemetry`— tracing
 * - `rsc-cache/testing`      — fake clock, test cache, assertions
 */

/* Core API ----------------------------------------------------------------- */
export { cache, cacheWith } from "./cache.js";
export { createCache, DEFAULT_NAMESPACE } from "./create-cache.js";
export {
  configureCache,
  getCache,
  getDefaultCache,
  registerCache,
  registeredCaches,
  resetCache,
  resetGlobalCache,
  setDefaultCache,
  unregisterCache,
} from "./global.js";

/* Invalidation ------------------------------------------------------------- */
export {
  clearCache,
  invalidate,
  revalidateKey,
  revalidateNamespace,
  revalidateTag,
} from "./invalidation.js";
export type { InvalidationOptions } from "./invalidation.js";

/* Warming ------------------------------------------------------------------ */
export { prefetch, prefetchDetailed, warmup } from "./prefetch.js";

/* Storage ------------------------------------------------------------------ */
export { memoryStorage } from "./memory.js";
export type {
  MemoryStorage,
  MemoryStorageOptions,
  MemoryStorageStats,
} from "./memory.js";
export {
  defineStorage,
  deleteKeys,
  inspectStorage,
  isObservableStorage,
  observeStorage,
  wrapStorageError,
} from "./storage.js";
export type { StorageCapabilities } from "./storage.js";

/* Serialization & compression ---------------------------------------------- */
export {
  defaultSerializer,
  jsonSerializer,
  strictJsonSerializer,
} from "./serializer.js";
export type { JsonSerializerOptions } from "./serializer.js";
export {
  createCompressionProvider,
  deflateCompression,
  gzipCompression,
  isCompressionSupported,
  noCompression,
} from "./compression.js";
export { decodeEntry, encodeEntry, entryFromString, entryToString } from "./codec.js";

/* Keys, hashing, values ---------------------------------------------------- */
export {
  DEFAULT_KEY_PREFIX,
  KEY_FORMAT_VERSION,
  keyIdentifier,
  sanitizeLabel,
  validateNamespace,
  validatePrefix,
  validateTag,
} from "./keys.js";
export { canonicalize, canonicalizeArgs } from "./stable-stringify.js";
export { DEFAULT_HASH_LENGTH, hashValue, shortHash } from "./hash.js";
export { sha256, sha256Hex } from "./sha256.js";
export { formatDuration, parseDuration } from "./duration.js";
export { createClock, createFakeClock, systemClock } from "./clock.js";
export { getFreshness, isValidEntry } from "./entry.js";
export type { Freshness } from "./entry.js";

/* Context ------------------------------------------------------------------ */
export {
  EMPTY_CONTEXT,
  createCacheContext,
  createRequestCache,
  getCacheContext,
  getRequestCache,
  isAsyncContextEnabled,
  warmUpContextStore,
  withCacheContext,
} from "./context.js";
export type { ContextInit } from "./context.js";

/* Observability ------------------------------------------------------------ */
export { CacheStats } from "./stats.js";
export { EventBus } from "./events.js";
export type { EventBusOptions } from "./events.js";
export { createLogger, redact, silentLogger } from "./logger.js";
export type { LoggerOptions } from "./logger.js";
export { SingleFlight } from "./single-flight.js";
export { TagIndex, readTagTombstones, writeTagTombstone } from "./tag-index.js";

/* Errors ------------------------------------------------------------------- */
export {
  CacheError,
  CacheConfigurationError,
  CacheKeyError,
  CacheLockError,
  CacheSerializationError,
  CacheStorageError,
  CacheTimeoutError,
  isAbortError,
  toError,
} from "./errors.js";
export type { CacheErrorOptions } from "./errors.js";

/* Types -------------------------------------------------------------------- */
export type {
  AnyFunction,
  BackgroundTaskOptions,
  CacheCallInfo,
  CacheContext,
  CacheContextInit,
  CacheDiagnostics,
  CacheEntry,
  CacheEvent,
  CacheEventHandler,
  CacheEventHandlers,
  CacheEventInfo,
  CacheEventType,
  CacheGetOptions,
  CacheInstance,
  CacheInstrumentation,
  CacheLock,
  CacheOperation,
  CacheOperationMeta,
  CacheOptions,
  CacheSetOptions,
  CachedFunction,
  CachedFunctionExtras,
  CacheStatsSnapshot,
  CacheStorage,
  CacheTimeouts,
  Clock,
  CompressionProvider,
  CreateCacheOptions,
  DefaultCacheOptions,
  DistributedLockOptions,
  Duration,
  EntryState,
  FailureMode,
  InvalidateOptions,
  InvalidateResult,
  LockOptions,
  Logger,
  MaybePromise,
  ObservableStorage,
  PrefetchOptions,
  PrefetchResult,
  RequestCache,
  RevalidateMode,
  ScopeOption,
  ScopePart,
  Serializer,
  StorageClearOptions,
  StorageEvent,
  StorageSetOptions,
  Visibility,
  WarmupOptions,
  WarmupResult,
} from "./types.js";

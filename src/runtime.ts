/**
 * Cache runtime.
 *
 * The runtime owns everything that happens *between* the user's function and
 * the storage: key derivation, freshness decisions, compare-and-set writes,
 * single-flight, stale-while-revalidate, distributed locks, failure modes,
 * timeouts, events and statistics.
 *
 * The split matters: `create-cache.ts` only wires configuration, `runtime.ts`
 * owns the semantics and is the single place where "is this value usable?"
 * is decided.
 */

import { canonicalize } from "./stable-stringify.js";
import {
  CacheError,
  CacheKeyError,
  CacheLockError,
  CacheSerializationError,
  CacheStorageError,
  isAbortError,
  toError,
} from "./errors.js";
import { getCacheContext } from "./context.js";
import { delay, withTimeout } from "./timeout.js";
import { formatDuration, parseDuration } from "./duration.js";
import { getFreshness, isValidEntry } from "./entry.js";
import { hashValue } from "./hash.js";
import {
  KEY_FORMAT_VERSION,
  buildCustomEntryKey,
  buildEntryKey,
  buildLockKey,
  keyIdentifier,
  validateTag,
  type KeyContext,
} from "./keys.js";
import { isObservableStorage } from "./storage.js";
import { TagIndex, readTagTombstones, writeTagTombstone } from "./tag-index.js";
import { SingleFlight } from "./single-flight.js";
import { randomToken } from "./random.js";
import type { EventBus } from "./events.js";
import type { CacheStats } from "./stats.js";
import type {
  AnyFunction,
  BackgroundTaskOptions,
  CacheCallInfo,
  CacheContext,
  CacheEntry,
  CacheEventInfo,
  CacheInstrumentation,
  CacheLock,
  CacheOperation,
  CacheOperationMeta,
  CacheOptions,
  CacheStorage,
  Clock,
  CompressionProvider,
  DefaultCacheOptions,
  DistributedLockOptions,
  Duration,
  EntryState,
  FailureMode,
  Logger,
  RevalidateMode,
  ScopePart,
  Serializer,
  Visibility,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Resolved configuration                                                     */
/* -------------------------------------------------------------------------- */

export interface ResolvedTimeouts {
  read: number | undefined;
  write: number | undefined;
  lock: number | undefined;
  invalidate: number | undefined;
}

export function resolveTimeouts(input: {
  default?: Duration;
  read?: Duration;
  write?: Duration;
  lock?: Duration;
  invalidate?: Duration;
} | undefined): ResolvedTimeouts {
  const fallback = parseDuration(input?.default, "timeouts.default");
  return {
    read: parseDuration(input?.read, "timeouts.read") ?? fallback,
    write: parseDuration(input?.write, "timeouts.write") ?? fallback,
    lock: parseDuration(input?.lock, "timeouts.lock") ?? fallback,
    invalidate: parseDuration(input?.invalidate, "timeouts.invalidate") ?? fallback,
  };
}

export interface ResolvedLockOptions {
  enabled: boolean;
  ttlMs: number;
  waitMs: number;
  pollIntervalMs: number;
  failure: "proceed" | "throw";
}

export function resolveLockOptions(
  input: boolean | DistributedLockOptions | undefined,
): ResolvedLockOptions {
  const options: DistributedLockOptions =
    input === undefined || input === false
      ? { enabled: false }
      : input === true
        ? { enabled: true }
        : input;
  return {
    enabled: options.enabled ?? true,
    ttlMs: parseDuration(options.ttl ?? "10s", "distributedLock.ttl") ?? 10_000,
    waitMs: parseDuration(options.wait ?? "5s", "distributedLock.wait") ?? 5_000,
    pollIntervalMs: parseDuration(options.pollInterval ?? "50ms", "distributedLock.pollInterval") ?? 50,
    failure: options.failure ?? "proceed",
  };
}

/** A cached function plus everything needed to execute it deterministically. */
export interface FunctionDescriptor {
  fn: AnyFunction;
  label: string;
  identity: string;
  namespace: string;
  version?: string;
  keyContext: KeyContext;
  options: CacheOptions<unknown[]>;
  keyResolver?: (args: unknown[]) => string;
  tagsResolver?: (args: unknown[]) => readonly string[];
  scopeResolver?: CacheOptions<unknown[]>["scope"];
  visibility: Visibility;
  ttlMs?: number;
  staleTtlMs?: number;
  errorTtlMs: number;
  revalidate: RevalidateMode;
  cacheNull: boolean;
  cacheErrors: boolean;
  enabled: boolean | (() => boolean);
  maxValueSize: number;
  passSignal: boolean;
  onRevalidationError: "stale" | "throw";
  requestMemo: boolean;
  strictInvalidation: boolean;
  lockOptions: ResolvedLockOptions;
  serializer: Serializer;
  compression?: CompressionProvider;
  metadata?: Record<string, unknown>;
  /**
   * Late signal provider (used by the React adapter to read `cacheSignal()` at
   * call time, inside the render that owns the request).
   */
  signalProvider?: () => AbortSignal | null | undefined;
}

/** Everything that can differ between two calls of the same function. */
interface CallPlan {
  key: string;
  keyHash: string;
  tags: readonly string[];
  enabled: boolean;
  signal?: AbortSignal;
  requestCache?: {
    peek<T>(key: string): Promise<T> | undefined;
    run<T>(key: string, tags: readonly string[], factory: () => Promise<T>): Promise<T>;
  };
}

export interface CacheRuntimeOptions {
  namespace: string;
  prefix: string;
  storage: CacheStorage;
  serializer: Serializer;
  compression?: CompressionProvider;
  clock: Clock;
  version?: string;
  defaults?: DefaultCacheOptions<unknown[]>;
  timeouts: ResolvedTimeouts;
  readFailureMode: FailureMode;
  writeFailureMode: FailureMode;
  distributedLock: ResolvedLockOptions;
  backgroundTasks?: BackgroundTaskOptions;
  eventBus: EventBus;
  stats: CacheStats;
  logger: Logger;
  debug: boolean;
  instrumentation?: CacheInstrumentation;
}

/** Result of a distributed-lock attempt that may already have found a value. */
interface LockAttempt {
  lock: CacheLock | null;
  entry: CacheEntry | null;
}

export class CacheRuntime {
  readonly namespace: string;
  readonly prefix: string;
  readonly storage: CacheStorage;
  readonly clock: Clock;
  readonly serializer: Serializer;
  readonly compression: CompressionProvider | undefined;
  readonly stats: CacheStats;
  readonly eventBus: EventBus;
  readonly timeouts: ResolvedTimeouts;
  readonly logger: Logger;

  private readonly defaults: DefaultCacheOptions<unknown[]>;
  private readonly readFailureMode: FailureMode;
  private readonly writeFailureMode: FailureMode;
  private readonly backgroundTasks: BackgroundTaskOptions | undefined;
  private readonly instrumentation: CacheInstrumentation | undefined;
  private readonly singleFlight = new SingleFlight();
  private readonly tagIndex: TagIndex;
  private readonly nativeTags: boolean;
  private readonly cas: boolean;
  private readonly unsubscribeStorage: () => void;
  private disposed = false;

  constructor(options: CacheRuntimeOptions) {
    this.namespace = options.namespace;
    this.prefix = options.prefix;
    this.storage = options.storage;
    this.clock = options.clock;
    this.serializer = options.serializer;
    this.compression = options.compression;
    this.stats = options.stats;
    this.eventBus = options.eventBus;
    this.timeouts = options.timeouts;
    this.logger = options.logger;
    this.defaults = options.defaults ?? {};
    this.readFailureMode = options.readFailureMode;
    this.writeFailureMode = options.writeFailureMode;
    this.backgroundTasks = options.backgroundTasks;
    this.instrumentation = options.instrumentation;
    this.cas = typeof options.storage.compareAndSet === "function";
    this.nativeTags =
      typeof options.storage.addTags === "function" &&
      typeof options.storage.invalidateTag === "function";

    this.tagIndex = new TagIndex({
      storage: options.storage,
      context: { prefix: options.prefix, namespace: options.namespace, version: options.version },
      onError: (error) => {
        this.stats.increment("errors");
        this.logger.warn("tag index update failed", { error });
      },
    });

    this.unsubscribeStorage = isObservableStorage(options.storage)
      ? options.storage.observe((event) => {
          if (event.type === "eviction") {
            this.stats.increment("evictions");
            this.emitRaw("eviction", event.key ?? "", { outcome: event.reason ?? "capacity" });
          }
        })
      : () => undefined;
  }

  get backend(): string {
    return this.storage.name ?? "custom";
  }

  get capabilities(): { cas: boolean; nativeTags: boolean; locks: boolean } {
    return {
      cas: this.cas,
      nativeTags: this.nativeTags,
      locks: typeof this.storage.acquireLock === "function",
    };
  }

  get defaultsSnapshot(): DefaultCacheOptions<unknown[]> {
    return this.defaults;
  }

  private emitRaw(
    type: Parameters<EventBus["publish"]>[0],
    key: string,
    payload: Partial<Parameters<EventBus["publish"]>[1]> = {},
  ): void {
    this.eventBus.publish(
      type,
      {
        key,
        namespace: this.namespace,
        backend: this.backend,
        ...payload,
      },
      {
        args: [],
        context: getCacheContext(),
        key,
        namespace: this.namespace,
      },
    );
  }

  private async instrument<T>(
    operation: CacheOperation,
    meta: Omit<CacheOperationMeta, "operation" | "cache" | "backend">,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!this.instrumentation?.wrapOperation) {
      return run();
    }
    return this.instrumentation.wrapOperation(
      operation,
      { operation, cache: this.namespace, backend: this.backend, ...meta },
      run,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Storage primitives                                                     */
  /* ---------------------------------------------------------------------- */

  private async readEntry(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    info: CacheEventInfo,
  ): Promise<CacheEntry | null> {
    const startedAt = Date.now();
    try {
      const entry = await this.instrument(
        "get",
        { namespace: this.namespace, name: descriptor.label, keyHash: plan.keyHash },
        () =>
          withTimeout(this.storage.get(plan.key), this.timeouts.read, {
            name: "cache storage read",
          }),
      );

      if (!entry) {
        return null;
      }

      if (!isValidEntry(entry)) {
        this.stats.increment("errors");
        this.eventBus.publish(
          "error",
          {
            key: plan.key,
            name: descriptor.label,
            outcome: "invalid-entry",
            error: new CacheStorageError("Cache backend returned a malformed entry"),
          },
          info,
        );
        await this.silentDelete(plan.key);
        return null;
      }

      return entry;
    } catch (error) {
      const cause = toError(error);
      if (isAbortError(cause) && plan.signal?.aborted) {
        throw cause;
      }
      this.stats.increment("errors");
      const failOpen = this.readFailureMode === "fail-open";
      this.eventBus.publish(
        "error",
        {
          key: plan.key,
          name: descriptor.label,
          outcome: failOpen ? "fail-open" : "fail-closed",
          error: cause,
          duration: Date.now() - startedAt,
        },
        info,
      );
      if (!failOpen) {
        throw new CacheStorageError("Cache read failed (failureMode: fail-closed)", {
          cause,
          details: { backend: this.backend },
        });
      }
      return null;
    }
  }

  private async silentDelete(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch {
      // Removing a corrupt entry is best effort.
    }
  }

  private async serializeValue(
    descriptor: FunctionDescriptor,
    value: unknown,
  ): Promise<Uint8Array> {
    const bytes = await descriptor.serializer.serialize(value);
    if (!(bytes instanceof Uint8Array)) {
      throw new CacheSerializationError("serializer.serialize() must return a Uint8Array");
    }
    if (bytes.length > descriptor.maxValueSize) {
      throw new CacheSerializationError(
        `Serialized value is ${bytes.length} bytes which exceeds maxValueSize (${descriptor.maxValueSize})`,
        { code: "ERR_CACHE_VALUE_TOO_LARGE" },
      );
    }
    return bytes;
  }

  private async prepareBytes(
    descriptor: FunctionDescriptor,
    value: unknown,
  ): Promise<{ bytes: Uint8Array; compressed?: string }> {
    const serialized = await this.serializeValue(descriptor, value);
    const provider = descriptor.compression ?? this.compression;
    if (!provider || provider.name === "none") {
      return { bytes: serialized };
    }
    const compressed = await provider.compress(serialized);
    return { bytes: compressed, compressed: provider.name };
  }

  /** Deserializes an entry. Returns `{ ok: false }` when the payload must be treated as a miss. */
  private async deserializeEntry(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    entry: CacheEntry,
    info: CacheEventInfo,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    if (
      entry.serializer !== undefined &&
      descriptor.serializer.name !== undefined &&
      entry.serializer !== descriptor.serializer.name
    ) {
      this.stats.increment("errors");
      this.eventBus.publish(
        "error",
        {
          key: plan.key,
          name: descriptor.label,
          outcome: "serializer-mismatch",
          error: new CacheSerializationError(
            `Entry was written with serializer "${entry.serializer}" but "${descriptor.serializer.name}" is configured`,
          ),
        },
        info,
      );
      return { ok: false };
    }

    let bytes = entry.value;
    try {
      if (entry.compressed) {
        const provider = descriptor.compression ?? this.compression;
        if (!provider || provider.name !== entry.compressed) {
          throw new CacheSerializationError(
            `Entry is compressed with "${entry.compressed}" but no matching compression provider is configured`,
          );
        }
        bytes = await provider.decompress(bytes);
      }
      return { ok: true, value: await descriptor.serializer.deserialize(bytes) };
    } catch (error) {
      const cause = toError(error);
      this.stats.increment("errors");
      this.eventBus.publish(
        "error",
        { key: plan.key, name: descriptor.label, outcome: "corrupt-payload", error: cause },
        info,
      );
      // A corrupt entry must not be served again: drop it so the next call recomputes.
      await this.silentDelete(plan.key);
      return { ok: false };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Writes, deletes, locks                                                 */
  /* ---------------------------------------------------------------------- */

  private async writeEntry(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    info: CacheEventInfo,
    payload: {
      value: unknown;
      state: EntryState;
      ttlMs: number | undefined;
      staleTtlMs: number | undefined;
      observedRevision: number | null;
      startedAt: number;
    },
  ): Promise<boolean> {
    const now = this.clock.now();

    // Strict invalidation: refuse to write data whose computation started before
    // the tag was invalidated (invalidate() racing a slow source function).
    if (descriptor.strictInvalidation && plan.tags.length > 0) {
      try {
        const tombstones = await readTagTombstones(
          this.storage,
          descriptor.keyContext,
          plan.tags,
          now,
        );
        for (const [tag, invalidatedAt] of tombstones) {
          if (invalidatedAt >= payload.startedAt) {
            this.stats.increment("conflicts");
            this.eventBus.publish(
              "conflict",
              {
                key: plan.key,
                name: descriptor.label,
                tags: plan.tags,
                outcome: `invalidated:${tag}`,
              },
              info,
            );
            return false;
          }
        }
      } catch (error) {
        this.logger.warn("strict invalidation check failed", { error: toError(error) });
      }
    }

    let prepared: { bytes: Uint8Array; compressed?: string };
    try {
      prepared = await this.prepareBytes(descriptor, payload.value);
    } catch (error) {
      const cause = toError(error);
      const tooLarge = cause instanceof CacheError && cause.code === "ERR_CACHE_VALUE_TOO_LARGE";
      this.stats.increment("errors");
      if (tooLarge) {
        this.stats.increment("skipped");
      }
      this.eventBus.publish(
        "error",
        {
          key: plan.key,
          name: descriptor.label,
          outcome: tooLarge ? "too-large" : "serialization-failed",
          error: cause,
        },
        info,
      );
      if (!tooLarge && this.writeFailureMode === "fail-closed") {
        throw cause;
      }
      return false;
    }

    const expiresAt = payload.ttlMs === undefined ? Infinity : now + payload.ttlMs;
    const staleUntil =
      payload.ttlMs === undefined || payload.staleTtlMs === undefined
        ? undefined
        : now + payload.ttlMs + payload.staleTtlMs;

    const entry: CacheEntry = {
      value: prepared.bytes,
      createdAt: now,
      expiresAt,
      revision: (payload.observedRevision ?? 0) + 1,
      state: payload.state,
      namespace: this.namespace,
      visibility: descriptor.visibility,
      tags: plan.tags,
      label: descriptor.label,
    };
    if (staleUntil !== undefined) entry.staleUntil = staleUntil;
    if (prepared.compressed !== undefined) entry.compressed = prepared.compressed;
    if (descriptor.serializer.name !== undefined) entry.serializer = descriptor.serializer.name;
    if (descriptor.version !== undefined) entry.version = descriptor.version;
    if (descriptor.metadata !== undefined) entry.metadata = this.sanitizeMetadata(descriptor.metadata);

    const setOptions: Parameters<CacheStorage["set"]>[2] = {
      expectedRevision: payload.observedRevision,
      expiresAt,
    };
    if (payload.ttlMs !== undefined) setOptions.ttlMs = payload.ttlMs;
    if (payload.staleTtlMs !== undefined) setOptions.staleTtlMs = payload.staleTtlMs;
    if (staleUntil !== undefined) setOptions.staleUntil = staleUntil;
    if (plan.tags.length > 0) setOptions.tags = plan.tags;
    if (descriptor.version !== undefined) setOptions.version = descriptor.version;
    if (entry.metadata !== undefined) setOptions.metadata = entry.metadata;

    try {
      const written = await this.instrument(
        "set",
        { namespace: this.namespace, name: descriptor.label, keyHash: plan.keyHash, tags: plan.tags },
        async () => {
          if (typeof this.storage.compareAndSet === "function") {
            return withTimeout(
              this.storage.compareAndSet(plan.key, entry, payload.observedRevision, setOptions),
              this.timeouts.write,
              { name: "cache storage write" },
            );
          }
          // Emulated compare-and-set for storages without a native primitive:
          // read, compare, write. Not atomic — documented in SECURITY.md.
          const current = await withTimeout(this.storage.get(plan.key), this.timeouts.read, {
            name: "cache storage read",
          });
          if ((current?.revision ?? null) !== payload.observedRevision) {
            return false;
          }
          await withTimeout(this.storage.set(plan.key, entry, setOptions), this.timeouts.write, {
            name: "cache storage write",
          });
          return true;
        },
      );

      if (!written) {
        this.stats.increment("conflicts");
        this.eventBus.publish(
          "conflict",
          {
            key: plan.key,
            name: descriptor.label,
            outcome: "newer-revision-present",
            metadata: {
              observedRevision: payload.observedRevision,
              attemptedRevision: entry.revision,
            },
          },
          info,
        );
        return false;
      }
    } catch (error) {
      const cause = toError(error);
      this.stats.increment("errors");
      this.eventBus.publish(
        "error",
        { key: plan.key, name: descriptor.label, outcome: "write-failed", error: cause },
        info,
      );
      if (this.writeFailureMode === "fail-closed") {
        throw new CacheStorageError("Cache write failed (failureMode: fail-closed)", { cause });
      }
      return false;
    }

    if (plan.tags.length > 0) {
      try {
        if (this.nativeTags && typeof this.storage.addTags === "function") {
          await this.storage.addTags(plan.key, plan.tags, { namespace: this.namespace });
        } else {
          await this.tagIndex.add(plan.key, plan.tags, {
            ...(payload.ttlMs !== undefined ? { ttlMs: payload.ttlMs } : {}),
            ...(payload.staleTtlMs !== undefined ? { staleTtlMs: payload.staleTtlMs } : {}),
          });
        }
      } catch (error) {
        this.stats.increment("errors");
        this.eventBus.publish(
          "error",
          {
            key: plan.key,
            name: descriptor.label,
            outcome: "tag-index-failed",
            error: toError(error),
          },
          info,
        );
      }
    }

    this.stats.increment("sets");
    this.eventBus.publish(
      "set",
      {
        key: plan.key,
        name: descriptor.label,
        tags: plan.tags,
        outcome: "stored",
        metadata: {
          ttl: formatDuration(payload.ttlMs),
          staleTtl: formatDuration(payload.staleTtlMs),
          revision: entry.revision,
        },
      },
      info,
    );
    return true;
  }

  /** `metadata` must survive JSON encoding; drop it (with a warning) when it cannot. */
  private sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    try {
      JSON.stringify(metadata);
      return metadata;
    } catch (error) {
      this.logger.warn("cache entry metadata is not JSON serializable and was dropped", {
        error: toError(error),
      });
      return {};
    }
  }

  private async deleteEntry(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    info: CacheEventInfo,
    options: { silent?: boolean } = {},
  ): Promise<boolean> {
    try {
      await this.instrument(
        "delete",
        { namespace: this.namespace, name: descriptor.label, keyHash: plan.keyHash },
        () =>
          withTimeout(this.storage.delete(plan.key), this.timeouts.write, {
            name: "cache storage delete",
          }),
      );
    } catch (error) {
      this.stats.increment("errors");
      this.eventBus.publish(
        "error",
        { key: plan.key, name: descriptor.label, outcome: "delete-failed", error: toError(error) },
        info,
      );
      return false;
    }

    if (options.silent !== true) {
      this.stats.increment("deletes");
      this.eventBus.publish(
        "delete",
        { key: plan.key, name: descriptor.label, outcome: "deleted" },
        info,
      );
    }
    return true;
  }

  /**
   * Distributed single-flight.
   *
   * Acquires a lock when the storage supports it and another process is not
   * already computing the same key. While waiting, the cache is polled: when a
   * peer populates it first, that value is returned instead of computing twice.
   */
  private async acquireLockOrWait(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    info: CacheEventInfo,
  ): Promise<LockAttempt> {
    const options = descriptor.lockOptions;
    if (!options.enabled || typeof this.storage.acquireLock !== "function") {
      return { lock: null, entry: null };
    }

    const lockKey = buildLockKey(
      { prefix: this.prefix, namespace: this.namespace },
      plan.key,
    );
    const deadline = Date.now() + options.waitMs;
    const startedAt = Date.now();

    for (;;) {
      let lock: CacheLock | null = null;
      try {
        lock = await withTimeout(
          this.storage.acquireLock(lockKey, { ttlMs: options.ttlMs, token: randomToken() }),
          this.timeouts.lock,
          { name: "cache lock" },
        );
      } catch (error) {
        this.stats.increment("errors");
        this.eventBus.publish(
          "error",
          {
            key: plan.key,
            name: descriptor.label,
            outcome: "lock-failed",
            error: toError(error),
          },
          info,
        );
        return { lock: null, entry: null };
      }

      if (lock) {
        this.stats.increment("locks");
        this.eventBus.publish(
          "lock",
          {
            key: plan.key,
            name: descriptor.label,
            outcome: "acquired",
            duration: Date.now() - startedAt,
          },
          info,
        );
        // Double check: a peer may have populated the entry while we waited.
        const entry = await this.readEntry(descriptor, plan, info);
        if (entry && getFreshness(entry, this.clock.now()) === "fresh") {
          await this.releaseLock(lock);
          return { lock: null, entry };
        }
        return { lock, entry: null };
      }

      await delay(options.pollIntervalMs);
      const entry = await this.readEntry(descriptor, plan, info);
      if (entry && getFreshness(entry, this.clock.now()) === "fresh") {
        this.eventBus.publish(
          "lock",
          { key: plan.key, name: descriptor.label, outcome: "waited-for-peer" },
          info,
        );
        return { lock: null, entry };
      }

      if (Date.now() >= deadline) {
        this.eventBus.publish(
          "lock",
          {
            key: plan.key,
            name: descriptor.label,
            outcome: "timeout",
            duration: Date.now() - startedAt,
          },
          info,
        );
        if (options.failure === "throw") {
          throw new CacheLockError(
            `Could not acquire the distributed cache lock within ${options.waitMs}ms`,
            plan.key,
            options.waitMs,
          );
        }
        // Fail open: compute locally rather than failing the request.
        return { lock: null, entry: null };
      }
    }
  }

  private async releaseLock(lock: CacheLock): Promise<void> {
    try {
      await lock.release();
    } catch (error) {
      this.logger.warn("failed to release a cache lock", { error: toError(error) });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                              */
  /* ---------------------------------------------------------------------- */

  /** Resolves everything that can change between two calls: key, tags, scope, memo. */
  createPlan(descriptor: FunctionDescriptor, args: unknown[], context: CacheContext): CallPlan {
    const callInfo: CacheCallInfo = {
      args,
      context,
      clock: this.clock,
      cache: {
        namespace: descriptor.namespace,
        name: descriptor.label,
        version: descriptor.version,
      },
    };
    if (context.signal !== undefined) {
      callInfo.signal = context.signal;
    }

    // Scope: isolates private data (user/tenant/region) inside the key.
    let scopeParts: ScopePart[] = [];
    if (descriptor.scopeResolver !== undefined) {
      const resolved =
        typeof descriptor.scopeResolver === "function"
          ? descriptor.scopeResolver(callInfo)
          : descriptor.scopeResolver;
      if (resolved === undefined || resolved === null) {
        scopeParts = [];
      } else if (Array.isArray(resolved)) {
        scopeParts = [...resolved];
      } else {
        scopeParts = [resolved as ScopePart];
      }
    }

    if (scopeParts.length === 0 && (context.userId !== undefined || context.tenantId !== undefined)) {
      // Fall back to the ambient identity so a `private` function without an
      // explicit scope is still isolated per user/tenant.
      if (context.userId !== undefined) scopeParts.push(context.userId);
      if (context.tenantId !== undefined) scopeParts.push(context.tenantId);
    }

    const scopeToken = scopeParts.length === 0 ? undefined : hashValue(canonicalize(scopeParts), 16);

    // Tags.
    let tags: readonly string[] = [];
    if (descriptor.tagsResolver) {
      const resolved = descriptor.tagsResolver(args);
      if (resolved && resolved.length > 0) {
        tags = [...new Set(resolved.map((tag) => validateTag(tag)))];
      }
    }

    // Key.
    let key: string;
    if (descriptor.keyResolver) {
      const custom = descriptor.keyResolver(args);
      const scoped = scopeToken === undefined ? custom : `${custom}~${scopeToken}`;
      key = buildCustomEntryKey(descriptor.keyContext, descriptor.label, scoped);
    } else {
      const material = `${descriptor.identity}|${scopeToken ?? ""}|${canonicalize(args)}`;
      key = buildEntryKey(descriptor.keyContext, descriptor.label, hashValue(material));
    }

    const enabled =
      typeof descriptor.enabled === "function" ? descriptor.enabled() : descriptor.enabled;

    const visibility = context.visibility ?? descriptor.visibility;
    if (visibility === "private" && scopeParts.length === 0) {
      throw new CacheKeyError(
        `Cache function "${descriptor.label}" is private but no scope could be resolved. ` +
          "Provide a `scope` option (or a context with userId/tenantId) so private data can never " +
          "be served from a shared cache entry.",
      );
    }

    const plan: CallPlan = {
      key,
      keyHash: keyIdentifier(key),
      tags,
      enabled,
    };
    const providedSignal = descriptor.signalProvider?.() ?? undefined;
    const signal = providedSignal ?? context.signal;
    if (signal !== undefined) {
      plan.signal = signal;
    }
    if (descriptor.requestMemo && context.requestCache !== undefined) {
      plan.requestCache = context.requestCache;
    }
    return plan;
  }

  private eventInfo(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    args: unknown[],
    context: CacheContext,
  ): CacheEventInfo {
    return {
      args,
      context,
      key: plan.key,
      namespace: descriptor.namespace,
      ...(descriptor.label ? { name: descriptor.label } : {}),
    };
  }

  /** Calls the wrapped function, optionally passing the cancellation signal. */
  private async callSource(
    descriptor: FunctionDescriptor,
    args: unknown[],
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    return this.instrument("source", { namespace: this.namespace, name: descriptor.label, keyHash: "" }, async () => {
      if (descriptor.passSignal) {
        return await descriptor.fn(...args, signal);
      }
      return await descriptor.fn(...args);
    });
  }

  /**
   * Computes the value, coalescing every concurrent call for the same key.
   *
   * `observedRevision` is the revision the caller saw when it decided to
   * compute; the write only succeeds while the stored revision is unchanged
   * (compare-and-set), so a slow revalidation can never overwrite a newer one.
   */
  private async refresh(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    args: unknown[],
    info: CacheEventInfo,
    options: { observedRevision: number | null; background?: boolean },
  ): Promise<unknown> {
    const background = options.background === true;
    const startedAt = this.clock.now();

    return this.singleFlight.run(
      plan.key,
      async (sharedSignal) => {
        const attempt = await this.acquireLockOrWait(descriptor, plan, info);
        if (attempt.entry) {
          const peer = await this.deserializeEntry(descriptor, plan, attempt.entry, info);
          if (peer.ok) {
            if (attempt.entry.state === "error") {
              throw this.rehydrateError(peer.value, descriptor);
            }
            // Another process populated the entry while we waited.
            this.stats.increment("hits");
            this.eventBus.publish(
              "hit",
              {
                key: plan.key,
                name: descriptor.label,
                hit: true,
                outcome: "populated-by-peer",
                metadata: { revision: attempt.entry.revision },
              },
              info,
            );
            return peer.value;
          }
        }

        try {
          const value = await this.callSource(descriptor, args, sharedSignal);

          if (sharedSignal.aborted) {
            // Every consumer is gone: the result may be partial, do not persist it.
            return value;
          }

          const state: EntryState = value === null || value === undefined ? "null" : "value";
          if (state === "null" && !descriptor.cacheNull) {
            return value;
          }

          await this.writeEntry(descriptor, plan, info, {
            value,
            state,
            ttlMs: descriptor.ttlMs,
            staleTtlMs: descriptor.staleTtlMs,
            observedRevision: options.observedRevision,
            startedAt,
          });

          if (background) {
            this.stats.increment("backgroundRevalidations");
          }
          this.stats.increment("revalidations");
          this.eventBus.publish(
            "revalidate",
            {
              key: plan.key,
              name: descriptor.label,
              tags: plan.tags,
              outcome: background ? "background" : "blocking",
            },
            info,
          );
          return value;
        } catch (error) {
          const cause = toError(error);
          if (descriptor.cacheErrors && !isAbortError(cause) && !sharedSignal.aborted) {
            try {
              await this.writeEntry(descriptor, plan, info, {
                value: cause,
                state: "error",
                ttlMs: descriptor.errorTtlMs,
                staleTtlMs: undefined,
                observedRevision: options.observedRevision,
                startedAt,
              });
            } catch (writeError) {
              this.logger.warn("failed to cache an error result", { error: toError(writeError) });
            }
          }
          throw cause;
        } finally {
          if (attempt.lock) {
            await this.releaseLock(attempt.lock);
          }
        }
      },
      background ? { keepAlive: true } : plan.signal ? { signal: plan.signal } : {},
    );
  }

  private rehydrateError(value: unknown, descriptor: FunctionDescriptor): Error {
    if (value instanceof Error) {
      return value;
    }
    return new CacheError(
      `Cached error entry for "${descriptor.label}" did not contain an Error instance`,
      { code: "ERR_CACHE_STORED_ERROR" },
    );
  }

  /**
   * Starts a detached revalidation.
   *
   * Best effort by contract: if the runtime cannot keep executing after the
   * response (many serverless/edge runtimes), the promise is simply dropped.
   * Pass `backgroundTasks.waitUntil` to give it a real lifetime.
   */
  private startBackgroundRefresh(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    args: unknown[],
    info: CacheEventInfo,
    observedRevision: number,
  ): void {
    const task = this.refresh(descriptor, plan, args, info, {
      observedRevision,
      background: true,
    }).then(
      () => undefined,
      (error: unknown) => {
        this.eventBus.publish(
          "error",
          {
            key: plan.key,
            name: descriptor.label,
            outcome: "background-revalidation-failed",
            error: toError(error),
          },
          info,
        );
      },
    );

    const tracked = this.singleFlight.track(task);
    if (this.backgroundTasks?.waitUntil) {
      try {
        this.backgroundTasks.waitUntil(tracked);
      } catch (error) {
        this.logger.warn("backgroundTasks.waitUntil threw", { error: toError(error) });
      }
      return;
    }
    void tracked;
  }

  /** Entry point used by every cached function created from this runtime. */
  async execute(descriptor: FunctionDescriptor, args: unknown[]): Promise<unknown> {
    const context = getCacheContext();
    if (context.signal?.aborted) {
      throw context.signal.reason ?? new Error("Aborted");
    }

    const plan = this.createPlan(descriptor, args, context);
    const info = this.eventInfo(descriptor, plan, args, context);
    this.logger.debug(
      `CALL ${descriptor.label} ${plan.keyHash} backend=${this.backend} ttl=${formatDuration(descriptor.ttlMs)}`,
    );

    if (!plan.enabled) {
      this.stats.increment("bypasses");
      this.eventBus.publish(
        "bypass",
        { key: plan.key, name: descriptor.label, outcome: "disabled" },
        info,
      );
      return this.callSource(descriptor, args, context.signal);
    }

    if (plan.requestCache) {
      const memo = plan.requestCache.peek(plan.key);
      if (memo) {
        return memo;
      }
      return plan.requestCache.run(plan.key, plan.tags, () =>
        this.resolveWithCache(descriptor, plan, args, info),
      );
    }

    return this.resolveWithCache(descriptor, plan, args, info);
  }

  /** Cache-aside: read → (hit | stale | miss) → compute → write → return. */
  private async resolveWithCache(
    descriptor: FunctionDescriptor,
    plan: CallPlan,
    args: unknown[],
    info: CacheEventInfo,
  ): Promise<unknown> {
    const entry = await this.readEntry(descriptor, plan, info);
    let observedRevision = entry?.revision ?? null;

    if (entry) {
      const now = this.clock.now();
      const freshness = getFreshness(entry, now);
      if (freshness !== "expired") {
        const payload = await this.deserializeEntry(descriptor, plan, entry, info);
        if (!payload.ok) {
          // Corrupt/incompatible payload: the entry was dropped, compute fresh.
          observedRevision = null;
        } else if (freshness === "fresh") {
          this.stats.increment("hits");
          this.eventBus.publish(
            "hit",
            {
              key: plan.key,
              name: descriptor.label,
              hit: true,
              tags: entry.tags,
              outcome: entry.state ?? "value",
              metadata: { revision: entry.revision },
            },
            info,
          );
          if (entry.state === "error") {
            throw this.rehydrateError(payload.value, descriptor);
          }
          return payload.value;
        } else {
          this.stats.increment("staleHits");
          this.eventBus.publish(
            "stale",
            {
              key: plan.key,
              name: descriptor.label,
              stale: true,
              tags: entry.tags,
              outcome: descriptor.revalidate,
              metadata: { revision: entry.revision },
            },
            info,
          );

          if (descriptor.revalidate === "background") {
            this.startBackgroundRefresh(descriptor, plan, args, info, entry.revision);
            return payload.value;
          }

          try {
            return await this.refresh(descriptor, plan, args, info, {
              observedRevision: entry.revision,
            });
          } catch (error) {
            if (descriptor.onRevalidationError === "throw") {
              throw error;
            }
            this.eventBus.publish(
              "error",
              {
                key: plan.key,
                name: descriptor.label,
                outcome: "serve-stale-after-error",
                error: toError(error),
              },
              info,
            );
            return payload.value;
          }
        }
      }
    }

    this.stats.increment("misses");
    this.eventBus.publish("miss", { key: plan.key, name: descriptor.label, hit: false }, info);
    return this.refresh(descriptor, plan, args, info, { observedRevision });
  }

  /** Forces a recomputation and stores the result (used by `cachedFn.revalidate`). */
  async forceRecompute(descriptor: FunctionDescriptor, args: unknown[]): Promise<unknown> {
    const context = getCacheContext();
    const plan = this.createPlan(descriptor, args, context);
    const info = this.eventInfo(descriptor, plan, args, context);
    context.requestCache?.evict([plan.key]);
    const entry = await this.readEntry(descriptor, plan, info);
    return this.refresh(descriptor, plan, args, info, {
      observedRevision: entry?.revision ?? null,
    });
  }

  /** Deletes the entry of a specific call (used by `cachedFn.invalidate`). */
  async invalidateFunction(descriptor: FunctionDescriptor, args: unknown[]): Promise<boolean> {
    const context = getCacheContext();
    const plan = this.createPlan(descriptor, args, context);
    const info = this.eventInfo(descriptor, plan, args, context);
    context.requestCache?.evict([plan.key]);
    return this.deleteEntry(descriptor, plan, info);
  }

  /* ---------------------------------------------------------------------- */
  /* Invalidation                                                           */
  /* ---------------------------------------------------------------------- */

  private readonly tagIndexes = new Map<string, TagIndex>();

  private contextFor(namespace: string, version?: string): KeyContext {
    return {
      prefix: this.prefix,
      namespace,
      ...(version !== undefined ? { version } : {}),
    };
  }

  /**
   * Raw keys may be logical (`"homepage"`, namespaced automatically) or full
   * storage keys as returned by `cachedFn.key(...)`.
   */
  private storageKeyFor(key: string, namespace: string): string {
    return key.startsWith(`${this.prefix}:`)
      ? key
      : buildCustomEntryKey(this.contextFor(namespace), "kv", key);
  }

  private tagIndexFor(namespace: string): TagIndex {
    if (namespace === this.namespace) {
      return this.tagIndex;
    }
    let index = this.tagIndexes.get(namespace);
    if (!index) {
      index = new TagIndex({
        storage: this.storage,
        context: { prefix: this.prefix, namespace },
        onError: (error) => {
          this.stats.increment("errors");
          this.logger.warn("tag index update failed", { error });
        },
      });
      this.tagIndexes.set(namespace, index);
    }
    return index;
  }

  /**
   * Invalidates every entry carrying one of the tags.
   *
   * Failures are surfaced (the first one is thrown after all tags were
   * attempted): a mutation that silently invalidated nothing would keep serving
   * stale data, which is worse than a visible error.
   */
  async invalidateTags(tags: readonly string[], namespace?: string): Promise<number> {
    const targetNamespace = namespace ?? this.namespace;
    const now = this.clock.now();
    let entries = 0;
    let firstError: Error | undefined;

    for (const tag of tags) {
      const validated = validateTag(tag);
      try {
        await this.instrument(
          "invalidate",
          { namespace: targetNamespace, tags: [validated], keyHash: "" },
          async () => {
            if (
              targetNamespace === this.namespace &&
              this.nativeTags &&
              typeof this.storage.invalidateTag === "function"
            ) {
              await withTimeout(
                this.storage.invalidateTag(validated, { namespace: targetNamespace }),
                this.timeouts.invalidate,
                { name: "cache invalidate" },
              );
            } else {
              entries += await this.tagIndexFor(targetNamespace).invalidate(validated);
            }
          },
        );
      } catch (error) {
        firstError ??= toError(error);
        this.stats.increment("errors");
        this.emitRaw("error", "", {
          outcome: "tag-invalidation-failed",
          error: toError(error),
          tags: [validated],
          namespace: targetNamespace,
        });
      }

      // Record a tombstone so `strictInvalidation` can reject in-flight writes.
      try {
        await writeTagTombstone(
          this.storage,
          this.contextFor(targetNamespace),
          validated,
          now,
        );
      } catch (error) {
        this.logger.warn("failed to write an invalidation tombstone", { error: toError(error) });
      }

      this.emitRaw("delete", "", {
        outcome: "tag-invalidated",
        tags: [validated],
        namespace: targetNamespace,
      });
    }

    if (firstError) {
      throw firstError;
    }
    return entries;
  }

  /** Invalidates logical keys (or full storage keys) inside one namespace. */
  async invalidateKeys(keys: readonly string[], namespace?: string): Promise<number> {
    const targetNamespace = namespace ?? this.namespace;
    let deleted = 0;

    for (const key of keys) {
      const storageKey = this.storageKeyFor(key, targetNamespace);
      try {
        await this.storage.delete(storageKey);
        deleted += 1;
      } catch (error) {
        this.stats.increment("errors");
        this.emitRaw("error", storageKey, {
          outcome: "key-invalidation-failed",
          error: toError(error),
        });
      }
    }

    if (deleted > 0) {
      this.stats.increment("deletes", deleted);
    }
    return deleted;
  }

  /** Clears one namespace (or every namespace using this prefix). */
  async invalidateNamespace(namespace?: string): Promise<void> {
    const prefix =
      namespace === undefined
        ? `${this.prefix}:`
        : `${this.prefix}:${KEY_FORMAT_VERSION}:${namespace}:`;
    await this.instrument("invalidate", { namespace: namespace ?? "*", keyHash: "" }, async () => {
      await withTimeout(
        this.storage.clear({ prefix, ...(namespace ? { namespace } : {}) }),
        this.timeouts.invalidate,
        { name: "cache clear" },
      );
    });
    this.stats.increment("deletes");
    this.emitRaw("clear", "", {
      outcome: namespace === undefined ? "all-namespaces" : "namespace",
      namespace: namespace ?? this.namespace,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Raw key/value API                                                      */
  /* ---------------------------------------------------------------------- */

  private async readRawEntry(
    storageKey: string,
    serializer: Serializer,
    compression: CompressionProvider | undefined,
    options: { allowStale?: boolean } = {},
  ): Promise<
    { ok: true; entry: CacheEntry; value: unknown } | { ok: false; entry: CacheEntry | null }
  > {
    const entry = await this.storage.get(storageKey);
    if (!entry || !isValidEntry(entry)) {
      return { ok: false, entry: null };
    }
    const freshness = getFreshness(entry, this.clock.now());
    if (freshness === "expired" || (freshness === "stale" && options.allowStale !== true)) {
      return { ok: false, entry };
    }
    try {
      let bytes = entry.value;
      if (entry.compressed) {
        const provider = compression ?? this.compression;
        if (!provider || provider.name !== entry.compressed) {
          return { ok: false, entry };
        }
        bytes = await provider.decompress(bytes);
      }
      return { ok: true, entry, value: await serializer.deserialize(bytes) };
    } catch (error) {
      this.stats.increment("errors");
      this.emitRaw("error", storageKey, { outcome: "corrupt-payload", error: toError(error) });
      return { ok: false, entry };
    }
  }

  async rawGet<T>(
    key: string,
    options: {
      namespace?: string;
      allowStale?: boolean;
      serializer?: Serializer;
      compression?: CompressionProvider;
    } = {},
  ): Promise<T | undefined> {
    const namespace = options.namespace ?? this.namespace;
    const storageKey = this.storageKeyFor(key, namespace);
    const serializer = options.serializer ?? this.serializer;
    const result = await this.readRawEntry(storageKey, serializer, options.compression, {
      ...(options.allowStale !== undefined ? { allowStale: options.allowStale } : {}),
    });
    if (!result.ok) {
      this.stats.increment("misses");
      this.emitRaw("miss", storageKey, { hit: false });
      return undefined;
    }
    this.stats.increment("hits");
    this.emitRaw("hit", storageKey, { hit: true, outcome: "raw" });
    return result.value as T;
  }

  private async serializeRawValue(serializer: Serializer, value: unknown): Promise<Uint8Array> {
    const bytes = await serializer.serialize(value);
    if (!(bytes instanceof Uint8Array)) {
      throw new CacheSerializationError("serializer.serialize() must return a Uint8Array");
    }
    return bytes;
  }

  async rawSet<T>(
    key: string,
    value: T,
    options: {
      namespace?: string;
      ttl?: Duration;
      tags?: readonly string[];
      serializer?: Serializer;
      compression?: CompressionProvider;
      expectedRevision?: number | null;
    } = {},
  ): Promise<void> {
    const namespace = options.namespace ?? this.namespace;
    const storageKey = this.storageKeyFor(key, namespace);
    const serializer = options.serializer ?? this.serializer;
    const compression = options.compression ?? this.compression;
    const ttlMs = parseDuration(options.ttl, "ttl");
    const now = this.clock.now();

    const bytes = await this.serializeRawValue(serializer, value);
    let payload = bytes;
    let compressed: string | undefined;
    if (compression && compression.name !== "none") {
      payload = await compression.compress(bytes);
      compressed = compression.name;
    }

    const current = await this.storage.get(storageKey);
    const observedRevision =
      options.expectedRevision === undefined
        ? (current?.revision ?? null)
        : options.expectedRevision;

    const entry: CacheEntry = {
      value: payload,
      createdAt: now,
      expiresAt: ttlMs === undefined ? Infinity : now + ttlMs,
      revision: (observedRevision ?? 0) + 1,
      state: value === null || value === undefined ? "null" : "value",
      namespace,
    };
    if (compressed !== undefined) entry.compressed = compressed;
    if (serializer.name !== undefined) entry.serializer = serializer.name;
    if (options.tags && options.tags.length > 0) {
      entry.tags = [...new Set(options.tags.map((tag) => validateTag(tag)))];
    }

    const setOptions: Parameters<CacheStorage["set"]>[2] = { expectedRevision: observedRevision };
    if (ttlMs !== undefined) setOptions.ttlMs = ttlMs;

    if (typeof this.storage.compareAndSet === "function") {
      await this.storage.compareAndSet(storageKey, entry, observedRevision, setOptions);
    } else {
      await this.storage.set(storageKey, entry, setOptions);
    }

    if (entry.tags && entry.tags.length > 0) {
      if (this.nativeTags && typeof this.storage.addTags === "function") {
        await this.storage.addTags(storageKey, entry.tags, { namespace });
      } else {
        await this.tagIndexFor(namespace).add(storageKey, entry.tags, {
          ...(ttlMs !== undefined ? { ttlMs } : {}),
        });
      }
    }

    this.stats.increment("sets");
    this.emitRaw("set", storageKey, {
      outcome: "stored",
      ...(entry.tags ? { tags: entry.tags } : {}),
    });
  }

  async rawDelete(key: string, options: { namespace?: string } = {}): Promise<boolean> {
    const namespace = options.namespace ?? this.namespace;
    const storageKey = this.storageKeyFor(key, namespace);
    await this.storage.delete(storageKey);
    this.stats.increment("deletes");
    this.emitRaw("delete", storageKey, { outcome: "deleted" });
    return true;
  }

  async rawHas(key: string, options: { namespace?: string } = {}): Promise<boolean> {
    const namespace = options.namespace ?? this.namespace;
    const storageKey = this.storageKeyFor(key, namespace);
    return this.storage.has(storageKey);
  }

  /* ---------------------------------------------------------------------- */
  /* Diagnostics                                                            */
  /* ---------------------------------------------------------------------- */

  diagnostics(): {
    inflight: number;
    inflightKeys: string[];
    requestMemoSize: number;
    backgroundTasks: number;
  } {
    return {
      inflight: this.singleFlight.size,
      inflightKeys: this.singleFlight.keys().map((key) => keyIdentifier(key)),
      requestMemoSize: getCacheContext().requestCache?.size ?? 0,
      backgroundTasks: this.singleFlight.backgroundSize,
    };
  }

  /** Waits for in-flight computations and detached revalidations. */
  settle(): Promise<void> {
    return this.singleFlight.settle();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribeStorage();
    this.singleFlight.clear();
    this.tagIndexes.clear();
  }
}

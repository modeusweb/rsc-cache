/**
 * Turns a plain function into a cached function.
 *
 * The signature of the wrapped function is preserved exactly (including
 * generics and overloads) because the returned type is `F & CachedFunctionExtras<F>`:
 * TypeScript keeps the call signature of `F` and only adds helpers.
 */

import { getCacheContext } from "./context.js";
import { parseDuration } from "./duration.js";
import { CacheConfigurationError } from "./errors.js";
import { hashValue } from "./hash.js";
import { DEFAULT_MAX_KEY_LENGTH, validateNamespace } from "./keys.js";
import { resolveLockOptions, type CacheRuntime, type FunctionDescriptor } from "./runtime.js";
import type {
  AnyFunction,
  CacheInstance,
  CacheOptions,
  CachedFunction,
  CompressionProvider,
  DefaultCacheOptions,
  DistributedLockOptions,
  ScopeOption,
  Serializer,
  Visibility,
} from "./types.js";

export const DEFAULT_ERROR_TTL_MS = 10_000;
export const DEFAULT_MAX_VALUE_SIZE = 1024 * 1024;

export interface DescriptorContext {
  runtime: CacheRuntime;
  instance: CacheInstance;
  namespace: string;
  version?: string;
  defaults: DefaultCacheOptions<unknown[]>;
  serializer: Serializer;
  compression?: CompressionProvider;
  lock: ReturnType<typeof resolveLockOptions>;
}

function functionSource(fn: AnyFunction): string {
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "native";
  }
}

/**
 * Function identity used in cache keys.
 *
 * - `"auto"` (default): an explicit `name` wins (stable across builds), else the
 *   function source is hashed (stable across processes of the same build).
 * - `"name"`: only the name — stable across builds, but the caller owns
 *   collision safety.
 * - `"source"`: always hash the source — changes when a minifier changes output.
 */
function computeIdentity(fn: AnyFunction, name: string | undefined, mode: string): string {
  if (mode === "name") {
    return `name:${name ?? fn.name ?? "anonymous"}`;
  }
  const sourceHash = hashValue(functionSource(fn), 16);
  if (mode === "source" || name === undefined) {
    return `src:${fn.name ?? "anonymous"}:${sourceHash}`;
  }
  return `name:${name}`;
}

function resolveTagsResolver(
  tags: CacheOptions<unknown[]>["tags"],
): ((args: unknown[]) => readonly string[]) | undefined {
  if (tags === undefined) {
    return undefined;
  }
  if (typeof tags === "function") {
    return (args) => tags(...args) ?? [];
  }
  return () => tags;
}

function resolveKeyResolver(
  key: CacheOptions<unknown[]>["key"],
): ((args: unknown[]) => string) | undefined {
  if (key === undefined) {
    return undefined;
  }
  if (typeof key === "function") {
    return (args) => key(...args);
  }
  return () => key;
}

/** Resolves instance defaults + per-function options into a descriptor. */
export function resolveDescriptor<F extends AnyFunction>(
  context: DescriptorContext,
  fn: F,
  options: CacheOptions<unknown[]> = {},
): FunctionDescriptor {
  if (typeof fn !== "function") {
    throw new CacheConfigurationError("cache() expects a function as its first argument");
  }

  const defaults = context.defaults;
  const label = options.name ?? defaults.name ?? fn.name ?? "anonymous";
  const namespace = validateNamespace(options.namespace ?? context.namespace);
  const version = options.version ?? defaults.version ?? context.version;
  const ttlMs = parseDuration(options.ttl ?? defaults.ttl, "ttl");
  const staleTtlMs = parseDuration(options.staleTtl ?? defaults.staleTtl, "staleTtl");
  const errorTtlMs =
    parseDuration(options.errorTtl ?? defaults.errorTtl, "errorTtl") ?? DEFAULT_ERROR_TTL_MS;

  const scope: ScopeOption<unknown[]> | undefined = options.scope ?? defaults.scope;
  const visibility: Visibility =
    options.visibility ?? defaults.visibility ?? (scope !== undefined ? "private" : "public");

  const maxValueSize = options.maxValueSize ?? defaults.maxValueSize ?? DEFAULT_MAX_VALUE_SIZE;
  if (!Number.isFinite(maxValueSize) || maxValueSize <= 0) {
    throw new CacheConfigurationError("maxValueSize must be a positive number of bytes");
  }
  const maxKeyLength = options.maxKeyLength ?? defaults.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;
  if (!Number.isFinite(maxKeyLength) || maxKeyLength < 32) {
    throw new CacheConfigurationError("maxKeyLength must be at least 32 characters");
  }

  const lockOption: boolean | DistributedLockOptions | undefined =
    options.distributedLock ?? defaults.distributedLock;
  const lockOptions = lockOption === undefined ? context.lock : resolveLockOptions(lockOption);

  const keyIdentity = options.keyIdentity ?? defaults.keyIdentity ?? "auto";
  const name = options.name ?? defaults.name;

  const descriptor: FunctionDescriptor = {
    fn: fn as AnyFunction,
    label,
    identity: computeIdentity(fn, name, keyIdentity),
    namespace,
    keyContext: {
      prefix: context.runtime.prefix,
      namespace,
      maxKeyLength,
      ...(version !== undefined ? { version } : {}),
    },
    options,
    visibility,
    errorTtlMs,
    revalidate:
      options.revalidate ??
      defaults.revalidate ??
      (staleTtlMs !== undefined ? "background" : "blocking"),
    cacheNull: options.cacheNull ?? defaults.cacheNull ?? false,
    cacheErrors: options.cacheErrors ?? defaults.cacheErrors ?? false,
    enabled: options.enabled ?? defaults.enabled ?? true,
    maxValueSize,
    passSignal: options.passSignal ?? defaults.passSignal ?? false,
    onRevalidationError: options.onRevalidationError ?? defaults.onRevalidationError ?? "stale",
    requestMemo: options.requestMemo ?? defaults.requestMemo ?? true,
    strictInvalidation: options.strictInvalidation ?? defaults.strictInvalidation ?? false,
    lockOptions,
    serializer: options.serialize ?? defaults.serialize ?? context.serializer,
    tagsResolver: resolveTagsResolver(options.tags ?? defaults.tags),
    keyResolver: resolveKeyResolver(options.key ?? defaults.key),
  };

  if (version !== undefined) descriptor.version = version;
  if (ttlMs !== undefined) descriptor.ttlMs = ttlMs;
  if (staleTtlMs !== undefined) descriptor.staleTtlMs = staleTtlMs;
  if (scope !== undefined) descriptor.scopeResolver = scope;
  const compression = options.compression ?? defaults.compression ?? context.compression;
  if (compression !== undefined) descriptor.compression = compression;
  const metadata = options.metadata ?? defaults.metadata;
  if (metadata !== undefined) descriptor.metadata = metadata;

  return descriptor;
}

/** Wraps a function with the runtime, attaching the ergonomic helpers. */
export function createCachedFunction<F extends AnyFunction>(
  runtime: CacheRuntime,
  instance: CacheInstance,
  descriptor: FunctionDescriptor,
): CachedFunction<F> {
  const cached = ((...args: unknown[]) =>
    runtime.execute(descriptor, args)) as unknown as CachedFunction<F>;

  const define = (property: string, value: unknown): void => {
    Object.defineProperty(cached, property, {
      value,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  };

  define("name", descriptor.label);
  define("namespace", descriptor.namespace);
  define("version", descriptor.version);
  define("instance", instance);
  define("key", (...args: unknown[]) => runtime.createPlan(descriptor, args, getCacheContext()).key);
  define("tags", (...args: unknown[]) =>
    runtime.createPlan(descriptor, args, getCacheContext()).tags,
  );
  define("prefetch", (...args: unknown[]) => runtime.execute(descriptor, args));
  define("revalidate", (...args: unknown[]) => runtime.forceRecompute(descriptor, args));
  define("invalidate", async (...args: unknown[]) => {
    await runtime.invalidateFunction(descriptor, args);
  });
  define("stats", () => runtime.stats.snapshot());
  define("diagnostics", () => runtime.diagnostics());

  return cached;
}

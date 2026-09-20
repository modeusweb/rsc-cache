/**
 * Error hierarchy of rsc-cache.
 *
 * Every error thrown by the library extends {@link CacheError}, so applications
 * can catch one type. Cache failures are fail-open by default: a broken storage
 * must not break rendering — the source function is called instead.
 */

export interface CacheErrorOptions {
  cause?: unknown;
  code?: string;
  details?: Record<string, unknown>;
}

export class CacheError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: CacheErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CacheError";
    this.code = options.code ?? "ERR_CACHE";
    this.details = options.details ?? {};
  }
}

/** Thrown when a value cannot be serialized or a payload cannot be decoded. */
export class CacheSerializationError extends CacheError {
  constructor(message: string, options: CacheErrorOptions = {}) {
    super(message, { code: "ERR_CACHE_SERIALIZATION", ...options });
    this.name = "CacheSerializationError";
  }
}

/** Thrown when a storage backend fails or is misconfigured. */
export class CacheStorageError extends CacheError {
  constructor(message: string, options: CacheErrorOptions = {}) {
    super(message, { code: "ERR_CACHE_STORAGE", ...options });
    this.name = "CacheStorageError";
  }
}

/** Thrown when a cache key cannot be derived (unencodable argument, bad scope). */
export class CacheKeyError extends CacheError {
  constructor(message: string, options: CacheErrorOptions = {}) {
    super(message, { code: "ERR_CACHE_KEY", ...options });
    this.name = "CacheKeyError";
  }
}

/** Thrown when a storage operation exceeds its configured timeout. */
export class CacheTimeoutError extends CacheError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options: CacheErrorOptions = {}) {
    super(message, { code: "ERR_CACHE_TIMEOUT", ...options });
    this.name = "CacheTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when a distributed lock cannot be acquired. */
export class CacheLockError extends CacheError {
  readonly key: string;
  readonly timeoutMs: number;

  constructor(message: string, key: string, timeoutMs: number, options: CacheErrorOptions = {}) {
    super(message, { code: "ERR_CACHE_LOCK", ...options });
    this.name = "CacheLockError";
    this.key = key;
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown for invalid configuration (bad durations, namespaces, tags, options). */
export class CacheConfigurationError extends CacheError {
  constructor(message: string, options: CacheErrorOptions = {}) {
    super(message, { code: "ERR_CACHE_CONFIGURATION", ...options });
    this.name = "CacheConfigurationError";
  }
}

/** Normalizes any thrown value into an `Error`. */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  try {
    return new Error(`Non-error thrown: ${String(value)}`);
  } catch {
    return new Error("Non-error thrown");
  }
}

/** True for `AbortSignal` related errors (`AbortError`, `TimeoutError`, ...). */
export function isAbortError(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const name = (value as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

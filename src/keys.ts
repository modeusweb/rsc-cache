/**
 * Key generation.
 *
 * Storage keys look like:
 *
 * ```text
 * rsc-cache:v1:products:3f9a1c02:getProduct:a41d3c9be7f8...
 *  ^prefix    ^fmt ^namespace ^version ^label  ^hash(scope + args)
 * ```
 *
 * Rules that matter:
 *
 * - **Nothing sensitive is ever written in clear text.** Arguments (which may
 *   contain emails, ids or tokens) are hashed with SHA-256; only the function
 *   label stays readable, and it is sanitized.
 * - **Keys are bounded.** Anything longer than `maxKeyLength` is replaced by a
 *   hash, so a huge argument cannot produce a huge Redis key.
 * - **Namespaces and versions are structural.** One storage can serve several
 *   applications/subsystems, and bumping `version` invalidates old entries.
 * - **Reserved segments use `~`**, which sanitized labels can never contain, so
 *   tag indexes and locks cannot collide with entry keys.
 */

import { CacheConfigurationError } from "./errors.js";
import { DEFAULT_HASH_LENGTH, hashValue } from "./hash.js";

/** Format version of the key layout itself. */
export const KEY_FORMAT_VERSION = "v1";

export const DEFAULT_KEY_PREFIX = "rsc-cache";
export const DEFAULT_MAX_KEY_LENGTH = 200;
export const MAX_NAMESPACE_LENGTH = 64;
export const MAX_TAG_LENGTH = 256;

const SEGMENT_SAFE = /[^A-Za-z0-9_.-]+/g;

/** Validates and returns a namespace. Namespaces are structural, not arbitrary text. */
export function validateNamespace(namespace: string): string {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new CacheConfigurationError("namespace must be a non-empty string");
  }
  if (namespace.length > MAX_NAMESPACE_LENGTH) {
    throw new CacheConfigurationError(
      `namespace must be at most ${MAX_NAMESPACE_LENGTH} characters (got ${namespace.length})`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(namespace)) {
    throw new CacheConfigurationError(
      `namespace "${namespace}" contains invalid characters (allowed: A-Z a-z 0-9 . _ -)`,
    );
  }
  return namespace;
}

export function validatePrefix(prefix: string): string {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new CacheConfigurationError("prefix must be a non-empty string");
  }
  if (prefix.length > 48) {
    throw new CacheConfigurationError("prefix must be at most 48 characters");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new CacheConfigurationError(
      `prefix "${prefix}" contains invalid characters (allowed: A-Z a-z 0-9 . _ -)`,
    );
  }
  return prefix;
}

/** Tags are user defined but become index keys; validate early and loudly. */
export function validateTag(tag: string): string {
  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new CacheConfigurationError("tags must be non-empty strings");
  }
  if (tag.length > MAX_TAG_LENGTH) {
    throw new CacheConfigurationError(`tag exceeds ${MAX_TAG_LENGTH} characters`);
  }
  // Control characters almost always indicate a bug and would break indexes/logs.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(tag)) {
    throw new CacheConfigurationError("tags must not contain control characters");
  }
  return tag;
}

/** Readable, bounded label used in keys and logs. */
export function sanitizeLabel(label: string | undefined): string {
  const base = (label ?? "").trim();
  if (base === "") {
    return "fn";
  }
  const sanitized = base.replace(SEGMENT_SAFE, "-").replace(/^-+|-+$/g, "");
  return sanitized.length === 0 ? "fn" : sanitized.slice(0, 40);
}

export interface KeyContext {
  prefix: string;
  namespace: string;
  /** Schema version of the cached data (not the key format). */
  version?: string;
  maxKeyLength?: number;
}

/** `rsc-cache:v1:products:<versionToken>` */
export function keyBase(context: KeyContext): string {
  const versionToken = hashValue(context.version ?? "", 8);
  return `${context.prefix}:${KEY_FORMAT_VERSION}:${context.namespace}:${versionToken}`;
}

function enforceMaxLength(key: string, maxKeyLength: number): string {
  if (key.length <= maxKeyLength) {
    return key;
  }
  // Keep as much of the structural head readable as fits, and replace the rest
  // with a hash of the *whole* key. The limit is a hard guarantee: even when
  // the head alone exceeds the budget the result is trimmed below `maxKeyLength`.
  const hash = hashValue(key, DEFAULT_HASH_LENGTH);
  const suffixLength = hash.length + 2; // ":" + "h" + hash
  if (suffixLength >= maxKeyLength) {
    // Pathological budget (min supported is 32): the hash alone carries the key.
    const shortened = hashValue(key, Math.max(4, maxKeyLength - 1));
    return `h${shortened}`.slice(0, maxKeyLength);
  }
  const lastSeparator = key.lastIndexOf(":");
  const head = lastSeparator === -1 ? "" : key.slice(0, lastSeparator);
  const headBudget = maxKeyLength - suffixLength;
  const trimmedHead = head.length <= headBudget ? head : head.slice(0, headBudget);
  const candidate = `${trimmedHead}:h${hash}`;
  return candidate.length <= maxKeyLength ? candidate : candidate.slice(0, maxKeyLength);
}

/** Entry key derived from a hashed payload (scope + arguments). */
export function buildEntryKey(context: KeyContext, label: string, hash: string): string {
  const key = `${keyBase(context)}:${sanitizeLabel(label)}:${hash}`;
  return enforceMaxLength(key, context.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH);
}

/** Entry key derived from a caller supplied logical key. */
export function buildCustomEntryKey(
  context: KeyContext,
  label: string,
  customKey: string,
): string {
  if (typeof customKey !== "string" || customKey.length === 0) {
    throw new CacheConfigurationError("`key` resolvers must return a non-empty string");
  }
  const maxKeyLength = context.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;
  const segment = `${sanitizeLabel(label)}:${customKey}`.replace(/:/g, "-");
  const key = `${keyBase(context)}:${segment}`;
  return enforceMaxLength(key, maxKeyLength);
}

/** Tag index key (core fallback index and adapters agree on this layout). */
export function buildTagIndexKey(context: KeyContext, tag: string): string {
  const key = `${keyBase(context)}:~tags~:${hashValue(tag, 24)}`;
  return enforceMaxLength(key, context.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH);
}

/** Tombstone written by strict invalidation. */
export function buildTagTombstoneKey(context: KeyContext, tag: string): string {
  const key = `${keyBase(context)}:~tomb~:${hashValue(tag, 24)}`;
  return enforceMaxLength(key, context.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH);
}

/** Distributed lock key. */
export function buildLockKey(context: KeyContext, entryKey: string): string {
  const key = `${keyBase(context)}:~lock~:${hashValue(entryKey, 24)}`;
  return enforceMaxLength(key, context.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH);
}

/** Short identifier used in events and logs (never the full key by default). */
export function keyIdentifier(key: string): string {
  return hashValue(key, 12);
}

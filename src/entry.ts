import type { CacheEntry } from "./types.js";

export type Freshness = "fresh" | "stale" | "expired";

/**
 * Freshness is decided exclusively from absolute timestamps and the injected
 * clock. Storages never make this decision, so a fake clock in tests sees the
 * same behavior as production.
 */
export function getFreshness(entry: CacheEntry, now: number): Freshness {
  if (now < entry.expiresAt) {
    return "fresh";
  }
  if (entry.staleUntil !== undefined && now < entry.staleUntil) {
    return "stale";
  }
  return "expired";
}

/** Approximate in-memory/storage footprint used by size based eviction. */
export function entrySize(entry: CacheEntry): number {
  let size = entry.value.length + 64;
  if (entry.tags) {
    for (const tag of entry.tags) {
      size += tag.length * 2;
    }
  }
  if (entry.metadata) {
    try {
      size += JSON.stringify(entry.metadata).length;
    } catch {
      size += 64;
    }
  }
  if (entry.version) size += entry.version.length;
  return size;
}

/**
 * Defensive validation for entries coming from an untrusted backend.
 *
 * A corrupted or poisoned payload must fail as a cache miss, never as a crash
 * or as silently wrong data.
 */
export function isValidEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<CacheEntry>;
  if (!(entry.value instanceof Uint8Array)) {
    return false;
  }
  if (typeof entry.createdAt !== "number" || Number.isNaN(entry.createdAt)) {
    return false;
  }
  if (typeof entry.expiresAt !== "number" || Number.isNaN(entry.expiresAt)) {
    return false;
  }
  if (typeof entry.revision !== "number" || Number.isNaN(entry.revision)) {
    return false;
  }
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")) {
      return false;
    }
  }
  return true;
}

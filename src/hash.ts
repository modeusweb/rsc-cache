import { sha256Hex } from "./sha256.js";

/** Default length (in hex characters) of keys and identifiers. */
export const DEFAULT_HASH_LENGTH = 32;

/**
 * Hex hash used for storage keys, key hashes and identifiers.
 *
 * 32 hex characters = 128 bits, which keeps keys short while leaving collision
 * risk negligible (birthday bound ≈ 2^64 keys).
 */
export function hashValue(value: string | Uint8Array, length = DEFAULT_HASH_LENGTH): string {
  const full = sha256Hex(value);
  return length >= full.length ? full : full.slice(0, Math.max(4, length));
}

/** Short hash used in events and logs. */
export function shortHash(value: string, length = 12): string {
  return hashValue(value, length);
}

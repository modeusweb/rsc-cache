/**
 * Entry codec: packs a {@link CacheEntry} into a single value.
 *
 * Storages that can only hold one value per key (Redis, KV, HTTP cache, ...)
 * use this codec. The metadata is JSON, the payload stays opaque bytes — the
 * codec is serializer agnostic, which is why adapters never need to know which
 * serializer the application uses.
 */

import { decodeUtf8, encodeUtf8, fromBase64, toBase64 } from "./bytes.js";
import { CacheSerializationError } from "./errors.js";
import type { CacheEntry, EntryState, Visibility } from "./types.js";

const MAGIC = [0x52, 0x53, 0x43, 0x31]; // "RSC1"
const HEADER_SIZE = 9; // magic (4) + flags (1) + meta length (4)

interface EntryMeta {
  createdAt: number;
  expiresAt: number | null;
  staleUntil?: number | null;
  revision: number;
  state?: EntryState;
  version?: string;
  namespace?: string;
  visibility?: Visibility;
  tags?: string[];
  compressed?: string;
  serializer?: string;
  metadata?: Record<string, unknown>;
  label?: string;
}

function toMeta(entry: CacheEntry): EntryMeta {
  const meta: EntryMeta = {
    createdAt: entry.createdAt,
    expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
    revision: entry.revision,
  };
  if (entry.staleUntil !== undefined) {
    meta.staleUntil = Number.isFinite(entry.staleUntil) ? entry.staleUntil : null;
  }
  if (entry.state !== undefined) meta.state = entry.state;
  if (entry.version !== undefined) meta.version = entry.version;
  if (entry.namespace !== undefined) meta.namespace = entry.namespace;
  if (entry.visibility !== undefined) meta.visibility = entry.visibility;
  if (entry.tags !== undefined && entry.tags.length > 0) meta.tags = [...entry.tags];
  if (entry.compressed !== undefined) meta.compressed = entry.compressed;
  if (entry.serializer !== undefined) meta.serializer = entry.serializer;
  if (entry.metadata !== undefined) meta.metadata = entry.metadata;
  if (entry.label !== undefined) meta.label = entry.label;
  return meta;
}

function fromMeta(meta: EntryMeta, value: Uint8Array): CacheEntry {
  const entry: CacheEntry = {
    value,
    createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
    expiresAt: meta.expiresAt === null || meta.expiresAt === undefined ? Infinity : meta.expiresAt,
    revision: typeof meta.revision === "number" ? meta.revision : 1,
  };
  if (meta.staleUntil !== undefined) {
    entry.staleUntil =
      meta.staleUntil === null ? Infinity : (meta.staleUntil as number);
  }
  if (meta.state !== undefined) entry.state = meta.state;
  if (meta.version !== undefined) entry.version = meta.version;
  if (meta.namespace !== undefined) entry.namespace = meta.namespace;
  if (meta.visibility !== undefined) entry.visibility = meta.visibility;
  if (meta.tags !== undefined) entry.tags = meta.tags;
  if (meta.compressed !== undefined) entry.compressed = meta.compressed;
  if (meta.serializer !== undefined) entry.serializer = meta.serializer;
  if (meta.metadata !== undefined) entry.metadata = meta.metadata;
  if (meta.label !== undefined) entry.label = meta.label;
  return entry;
}

/** Binary envelope: `RSC1` + flags + meta length + meta JSON + payload. */
export function encodeEntry(entry: CacheEntry): Uint8Array {
  const metaBytes = encodeUtf8(JSON.stringify(toMeta(entry)));
  const out = new Uint8Array(HEADER_SIZE + metaBytes.length + entry.value.length);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = MAGIC[2];
  out[3] = MAGIC[3];
  out[4] = 0; // flags (reserved)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(5, metaBytes.length, false);
  out.set(metaBytes, HEADER_SIZE);
  out.set(entry.value, HEADER_SIZE + metaBytes.length);
  return out;
}

export function decodeEntry(bytes: Uint8Array): CacheEntry {
  if (bytes.length < HEADER_SIZE || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) {
    throw new CacheSerializationError("Corrupted cache entry: invalid header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLength = view.getUint32(5, false);
  if (metaLength <= 0 || HEADER_SIZE + metaLength > bytes.length) {
    throw new CacheSerializationError("Corrupted cache entry: invalid metadata length");
  }
  let meta: EntryMeta;
  try {
    meta = JSON.parse(decodeUtf8(bytes.subarray(HEADER_SIZE, HEADER_SIZE + metaLength))) as EntryMeta;
  } catch (error) {
    throw new CacheSerializationError("Corrupted cache entry: metadata is not valid JSON", {
      cause: error,
    });
  }
  return fromMeta(meta, bytes.subarray(HEADER_SIZE + metaLength));
}

/**
 * Single-value (string) form for Redis/KV/anything string based.
 *
 * Layout — deliberately Lua friendly and human readable:
 *
 * ```text
 * RSC1|<revision>|<meta JSON base64>|<payload base64>
 * ```
 *
 * - field 2 is the revision, which lets Redis Lua do compare-and-set without
 *   decoding the payload,
 * - fields 3 and 4 are base64, so neither can contain the `|` delimiter.
 */
export function entryToString(entry: CacheEntry): string {
  const meta = toBase64(encodeUtf8(JSON.stringify(toMeta(entry))));
  const payload = toBase64(entry.value);
  return `RSC1|${entry.revision}|${meta}|${payload}`;
}

export function entryFromString(value: string): CacheEntry {
  const parts = value.split("|");
  if (parts.length < 4 || parts[0] !== "RSC1") {
    throw new CacheSerializationError("Corrupted cache entry: invalid RSC1 envelope");
  }
  const revision = Number(parts[1]);
  if (!Number.isFinite(revision)) {
    throw new CacheSerializationError("Corrupted cache entry: invalid revision field");
  }
  let meta: EntryMeta;
  try {
    meta = JSON.parse(decodeUtf8(fromBase64(parts[2] as string))) as EntryMeta;
  } catch (error) {
    throw new CacheSerializationError("Corrupted cache entry: metadata is not valid JSON", {
      cause: error,
    });
  }
  const payload = fromBase64(parts.slice(3).join("|"));
  const entry = fromMeta(meta, payload);
  entry.revision = revision;
  return entry;
}

/** True when a string looks like a value produced by {@link entryToString}. */
export function isEntryString(value: string): boolean {
  return typeof value === "string" && value.startsWith("RSC1|");
}

/** Extracts the revision field of an encoded entry without decoding the payload. */
export function readRevisionFromString(value: string): number | null {
  const end = value.indexOf("|", 5);
  if (!value.startsWith("RSC1|") || end === -1) {
    return null;
  }
  const revision = Number(value.slice(5, end));
  return Number.isFinite(revision) ? revision : null;
}

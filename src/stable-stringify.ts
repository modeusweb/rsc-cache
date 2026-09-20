/**
 * Canonical, deterministic encoding of arbitrary values.
 *
 * Used to derive cache keys from function arguments. Deliberately *not*
 * `JSON.stringify(args)`:
 *
 * - property order cannot change the key (keys are sorted),
 * - `undefined`, `NaN`, `-0`, `Infinity`, `BigInt`, `Date`, `URL`, `RegExp`,
 *   `Map`, `Set`, typed arrays and `ArrayBuffer` are encoded with explicit tags,
 * - strings are length-prefixed, so `["ab", "c"]` and `["a", "bc"]` differ,
 * - circular references are encoded instead of throwing,
 * - functions, symbols and class instances are rejected: they cannot be keyed
 *   deterministically and would silently collide.
 *
 * The output is stable across processes and runtimes.
 */

import { CacheKeyError } from "./errors.js";
import { hashValue } from "./hash.js";
import { toHex } from "./bytes.js";

const MAX_DEPTH = 32;
const MAX_INLINE_BYTES = 256;

/** Canonical string encoding of a value. */
export function canonicalize(value: unknown): string {
  return encode(value, [], 0);
}

/** Canonical encoding of a list of arguments (used for keys). */
export function canonicalizeArgs(args: readonly unknown[]): string {
  return canonicalize(args);
}

function numberRepr(value: number): string {
  if (Object.is(value, -0)) {
    return "-0";
  }
  if (Number.isNaN(value)) {
    return "NaN";
  }
  return String(value);
}

function binaryRepr(bytes: Uint8Array): string {
  if (bytes.length > MAX_INLINE_BYTES) {
    return `*${bytes.length}:${hashValue(bytes)}`;
  }
  return toHex(bytes);
}

function unsupported(value: object, kind: string): never {
  const name =
    typeof (value as { constructor?: { name?: string } }).constructor?.name === "string"
      ? (value as { constructor: { name: string } }).constructor.name
      : "Object";
  throw new CacheKeyError(
    `Cannot derive a stable cache key from ${kind} (${name}). ` +
      `Pass primitives, plain objects, arrays, Date, URL, RegExp, Map, Set or typed arrays, ` +
      `or provide an explicit \`key\` option.`,
  );
}

function encode(value: unknown, stack: object[], depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CacheKeyError(
      `Cache key arguments are nested too deeply (max depth ${MAX_DEPTH}). Provide an explicit \`key\` option.`,
    );
  }

  if (value === undefined) {
    return "u";
  }
  if (value === null) {
    return "n";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "b1" : "b0";
    case "number":
      return `d:${numberRepr(value)}`;
    case "bigint":
      return `i:${value.toString()}`;
    case "string":
      return `s:${value.length}:${value}`;
    case "symbol":
      throw new CacheKeyError(
        "Cannot derive a stable cache key from a Symbol. Provide an explicit `key` option.",
      );
    case "function":
      throw new CacheKeyError(
        "Cannot derive a stable cache key from a function argument. Provide an explicit `key` option.",
      );
    default:
      break;
  }

  const object = value as object;
  const cycleIndex = stack.lastIndexOf(object);
  if (cycleIndex !== -1) {
    return `c:${stack.length - cycleIndex}`;
  }

  stack.push(object);
  try {
    return encodeObject(object, stack, depth);
  } finally {
    stack.pop();
  }
}

function encodeObject(object: object, stack: object[], depth: number): string {
  if (object instanceof Date) {
    return `D:${Number.isNaN(object.getTime()) ? "invalid" : object.toISOString()}`;
  }
  if (object instanceof URL) {
    return `U:${object.href}`;
  }
  if (object instanceof RegExp) {
    return `R:${object.source}/${object.flags}`;
  }
  if (object instanceof Uint8Array) {
    return `B:${binaryRepr(object)}`;
  }
  if (object instanceof ArrayBuffer) {
    return `B:${binaryRepr(new Uint8Array(object))}`;
  }
  if (ArrayBuffer.isView(object)) {
    const view = object as ArrayBufferView & { byteLength: number };
    return `B:${binaryRepr(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))}`;
  }
  if (object instanceof Map) {
    const entries: string[] = [];
    for (const [key, entryValue] of object) {
      entries.push(`${encode(key, stack, depth + 1)}=${encode(entryValue, stack, depth + 1)}`);
    }
    entries.sort();
    return `M:${object.size}{${entries.join(";")}}`;
  }
  if (object instanceof Set) {
    const items: string[] = [];
    for (const item of object) {
      items.push(encode(item, stack, depth + 1));
    }
    items.sort();
    return `S:${object.size}{${items.join(";")}}`;
  }
  if (Array.isArray(object)) {
    const items = object.map((item) => encode(item, stack, depth + 1));
    return `A:${object.length}[${items.join(",")}]`;
  }
  if (object instanceof Error) {
    unsupported(object, "an Error instance");
  }

  const prototype = Object.getPrototypeOf(object) as object | null;
  if (prototype !== null && prototype !== Object.prototype) {
    unsupported(object, "a class instance");
  }

  const record = object as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entryValue = record[key];
    if (entryValue === undefined) {
      continue;
    }
    parts.push(`${key}=${encode(entryValue, stack, depth + 1)}`);
  }
  return `O:${parts.length}{${parts.join(";")}}`;
}

/**
 * Default serializer: typed JSON.
 *
 * Design goals, in order:
 *
 * 1. **Safe.** Decoding is `JSON.parse` plus a small, closed reconstruction
 *    table. No `eval`, no `new Function`, no prototype walking, no `__proto__`
 *    assignment. A malicious cache backend cannot execute code.
 * 2. **Useful for RSC data.** Dates, BigInt, Map, Set, RegExp, URL, typed
 *    arrays, `undefined`, `NaN` and `-Infinity` survive a round trip — plain
 *    `JSON.stringify` would silently destroy them.
 * 3. **Deterministic.** Same value → same bytes, independent of property order.
 *
 * Unsupported (throws {@link CacheSerializationError}): functions, symbols,
 * class instances, `WeakMap`/`WeakSet`, `Promise`, circular references and
 * anything else that is not data.
 *
 * React elements are *not* supported and are not meant to be: React elements
 * contain symbols and functions and are bound to a specific render. Cache data,
 * not markup.
 */

import { CacheSerializationError } from "./errors.js";
import { decodeUtf8, encodeUtf8, fromBase64, toBase64 } from "./bytes.js";
import type { Serializer } from "./types.js";

const TAG_KEY = "~rsc";

interface Tagged {
  [TAG_KEY]: string;
  v?: unknown;
  [key: string]: unknown;
}

function isTagged(value: unknown): value is Tagged {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Tagged)[TAG_KEY] === "string"
  );
}

function fail(message: string, value?: unknown): never {
  throw new CacheSerializationError(message, { details: { type: typeof value } });
}

/**
 * Converts a value into a JSON-safe structure.
 *
 * `seen` tracks ancestors to reject cycles instead of producing broken data.
 */
function toJsonSafe(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === undefined) {
    return { [TAG_KEY]: "undefined" };
  }
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value;
    case "number":
      if (Number.isFinite(value)) {
        return Object.is(value, -0) ? { [TAG_KEY]: "number", v: "-0" } : value;
      }
      return { [TAG_KEY]: "number", v: String(value) };
    case "bigint":
      return { [TAG_KEY]: "bigint", v: value.toString() };
    case "symbol":
      return fail(`Cannot serialize a Symbol at ${path}`, value);
    case "function":
      return fail(`Cannot serialize a function at ${path}`, value);
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    return fail(`Cannot serialize a circular reference at ${path}`, value);
  }

  seen.add(object);
  try {
    if (object instanceof Date) {
      return { [TAG_KEY]: "date", v: Number.isNaN(object.getTime()) ? null : object.toISOString() };
    }
    if (object instanceof URL) {
      return { [TAG_KEY]: "url", v: object.href };
    }
    if (object instanceof RegExp) {
      return { [TAG_KEY]: "regexp", v: object.source, f: object.flags };
    }
    if (object instanceof Uint8Array) {
      return { [TAG_KEY]: "bytes", v: toBase64(object) };
    }
    if (object instanceof ArrayBuffer) {
      return { [TAG_KEY]: "bytes", v: toBase64(new Uint8Array(object)) };
    }
    if (ArrayBuffer.isView(object)) {
      const view = object as ArrayBufferView & { byteLength: number };
      return {
        [TAG_KEY]: "bytes",
        v: toBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
      };
    }
    if (object instanceof Map) {
      const entries: unknown[] = [];
      for (const [key, entryValue] of object) {
        entries.push([
          toJsonSafe(key, `${path}.<map-key>`, seen),
          toJsonSafe(entryValue, `${path}.<map-value>`, seen),
        ]);
      }
      return { [TAG_KEY]: "map", v: entries };
    }
    if (object instanceof Set) {
      const items: unknown[] = [];
      for (const item of object) {
        items.push(toJsonSafe(item, `${path}[]`, seen));
      }
      return { [TAG_KEY]: "set", v: items };
    }
    if (Array.isArray(object)) {
      return object.map((item, index) => toJsonSafe(item, `${path}[${index}]`, seen));
    }
    if (object instanceof Error) {
      return {
        [TAG_KEY]: "error",
        v: {
          name: object.name,
          message: object.message,
          stack: typeof object.stack === "string" ? object.stack : undefined,
        },
      };
    }

    return serializePlainObject(object, path, seen);
  } finally {
    seen.delete(object);
  }
}

function serializePlainObject(object: object, path: string, seen: Set<object>): unknown {
  const prototype = Object.getPrototypeOf(object) as object | null;
  if (prototype !== null && prototype !== Object.prototype) {
    const name = (object as { constructor?: { name?: string } }).constructor?.name ?? "Object";
    return fail(
      `Cannot serialize a class instance (${name}) at ${path}. ` +
        "Return plain data from cached functions, or provide a custom serializer.",
      object,
    );
  }

  const out: Record<string, unknown> = {};
  // Keys are sorted so the same data always produces the same bytes, whatever
  // order the producing code used.
  for (const key of Object.keys(object).sort()) {
    if (key === TAG_KEY) {
      continue;
    }
    const entryValue = (object as Record<string, unknown>)[key];
    if (entryValue === undefined) {
      continue;
    }
    out[key] = toJsonSafe(entryValue, `${path}.${key}`, seen);
  }
  return out;
}

/** Rebuilds the original value from the tagged structure (closed set of tags). */
function fromJsonSafe(value: unknown, path: string): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => fromJsonSafe(item, `${path}[${index}]`));
  }
  if (isTagged(value)) {
    switch (value[TAG_KEY]) {
      case "undefined":
        return undefined;
      case "number": {
        const raw = value.v as string;
        if (raw === "NaN") return Number.NaN;
        if (raw === "Infinity") return Number.POSITIVE_INFINITY;
        if (raw === "-Infinity") return Number.NEGATIVE_INFINITY;
        if (raw === "-0") return -0;
        return Number(raw);
      }
      case "bigint":
        return BigInt(value.v as string);
      case "date": {
        const raw = value.v as string | null;
        return raw === null ? new Date(Number.NaN) : new Date(raw);
      }
      case "url":
        return new URL(value.v as string);
      case "regexp":
        return new RegExp(value.v as string, (value.f as string | undefined) ?? "");
      case "bytes":
        return fromBase64(value.v as string);
      case "map": {
        const entries = value.v as Array<[unknown, unknown]>;
        const map = new Map<unknown, unknown>();
        for (const [key, entryValue] of entries) {
          map.set(
            fromJsonSafe(key, `${path}.<map-key>`),
            fromJsonSafe(entryValue, `${path}.<map-value>`),
          );
        }
        return map;
      }
      case "set": {
        const items = value.v as unknown[];
        const set = new Set<unknown>();
        for (const item of items) {
          set.add(fromJsonSafe(item, `${path}[]`));
        }
        return set;
      }
      case "error": {
        const raw = value.v as { name?: string; message?: string; stack?: string };
        const error = new Error(raw.message ?? "");
        error.name = raw.name ?? "Error";
        if (typeof raw.stack === "string") {
          error.stack = raw.stack;
        }
        return error;
      }
      default:
        return fail(`Unknown serialization tag "${value[TAG_KEY]}" at ${path}`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__") {
      continue; // never allow prototype injection coming from a cache backend
    }
    out[key] = fromJsonSafe((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
  return out;
}

export interface JsonSerializerOptions {
  /** Identifier stored with entries; keep it stable when changing formats. */
  name?: string;
  /** Enable pretty printing (debugging only; larger payloads). */
  pretty?: boolean;
}

/**
 * Creates a typed-JSON serializer (the default).
 *
 * ```ts
 * createCache({ serializer: jsonSerializer() });
 * ```
 */
export function jsonSerializer(options: JsonSerializerOptions = {}): Serializer {
  const name = options.name ?? "json";
  const space = options.pretty === true ? 2 : undefined;

  return {
    name,
    serialize(value: unknown): Uint8Array {
      let safe: unknown;
      try {
        safe = toJsonSafe(value, "$", new Set());
      } catch (error) {
        if (error instanceof CacheSerializationError) {
          throw error;
        }
        throw new CacheSerializationError("Failed to serialize value", { cause: error });
      }
      try {
        return encodeUtf8(JSON.stringify(safe, null, space));
      } catch (error) {
        throw new CacheSerializationError("Failed to encode serialized value as UTF-8", {
          cause: error,
        });
      }
    },
    deserialize(bytes: Uint8Array): unknown {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeUtf8(bytes));
      } catch (error) {
        throw new CacheSerializationError("Failed to decode cached payload (invalid JSON)", {
          cause: error,
        });
      }
      try {
        return fromJsonSafe(parsed, "$");
      } catch (error) {
        if (error instanceof CacheSerializationError) {
          throw error;
        }
        throw new CacheSerializationError("Failed to reconstruct cached payload", { cause: error });
      }
    },
  };
}

/** Shared default instance. Stateless and safe to reuse. */
export const defaultSerializer: Serializer = jsonSerializer();

/**
 * Strict JSON serializer: fastest, but only JSON-representable data survives
 * (`Date` becomes a string, `BigInt` throws, `undefined` is dropped).
 */
export function strictJsonSerializer(): Serializer {
  return {
    name: "json-strict",
    serialize(value: unknown): Uint8Array {
      try {
        const json = JSON.stringify(value);
        if (json === undefined) {
          throw new CacheSerializationError(
            "Value is not JSON serializable (undefined, function or symbol)",
          );
        }
        return encodeUtf8(json);
      } catch (error) {
        if (error instanceof CacheSerializationError) {
          throw error;
        }
        throw new CacheSerializationError("Failed to serialize value with JSON.stringify", {
          cause: error,
        });
      }
    },
    deserialize(bytes: Uint8Array): unknown {
      try {
        return JSON.parse(decodeUtf8(bytes));
      } catch (error) {
        throw new CacheSerializationError("Failed to decode cached payload (invalid JSON)", {
          cause: error,
        });
      }
    },
  };
}

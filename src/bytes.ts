/** Thin, typed wrappers around `TextEncoder`/`TextDecoder` and base64. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET[i]] = i;
  }
  return table;
})();

/**
 * Base64 encoding without `Buffer`/`btoa`: works identically on Node, Bun,
 * Deno, Cloudflare Workers and browsers.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64_ALPHABET[(chunk >>> 18) & 63];
    out += BASE64_ALPHABET[(chunk >>> 12) & 63];
    out += BASE64_ALPHABET[(chunk >>> 6) & 63];
    out += BASE64_ALPHABET[chunk & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    out += BASE64_ALPHABET[(chunk >>> 18) & 63];
    out += BASE64_ALPHABET[(chunk >>> 12) & 63];
    out += "==";
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += BASE64_ALPHABET[(chunk >>> 18) & 63];
    out += BASE64_ALPHABET[(chunk >>> 12) & 63];
    out += BASE64_ALPHABET[(chunk >>> 6) & 63];
    out += "=";
  }
  return out;
}

export function fromBase64(value: string): Uint8Array {
  let input = value.trim();
  while (input.endsWith("=")) {
    input = input.slice(0, -1);
  }
  const length = Math.floor((input.length * 3) / 4);
  const out = new Uint8Array(length);
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i += 1) {
    const digit = BASE64_LOOKUP[input[i]];
    if (digit === undefined) {
      throw new Error(`Invalid base64 character at index ${i}`);
    }
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >>> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += HEX[bytes[i] >>> 4];
    out += HEX[bytes[i] & 0x0f];
  }
  return out;
}

const HEX = "0123456789abcdef";

const cryptoRef = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } })
  .crypto;

let fallbackCounter = 0;

/**
 * Random identifier used for lock ownership tokens.
 *
 * Prefers Web Crypto (`crypto.getRandomValues`, available in Node 20+, Bun,
 * Deno, Workers and browsers) and falls back to a counter+Math.random mix.
 * Lock tokens only need uniqueness against an accidental release by another
 * holder — they are not secrets.
 */
export function randomToken(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(buffer);
  } else {
    fallbackCounter += 1;
    const seed = `${Date.now()}:${fallbackCounter}:${Math.random()}`;
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
    const suffix = seed.length;
    buffer[0] = (buffer[0] ^ suffix) & 0xff;
  }
  let out = "";
  for (let i = 0; i < buffer.length; i += 1) {
    out += HEX[buffer[i] >>> 4];
    out += HEX[buffer[i] & 0x0f];
  }
  return out;
}

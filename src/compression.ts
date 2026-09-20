import { concatBytes } from "./bytes.js";
import { CacheConfigurationError } from "./errors.js";
import type { CompressionProvider } from "./types.js";

/** Pass-through provider. Compression is off by default. */
export const noCompression: CompressionProvider = {
  name: "none",
  compress: (bytes: Uint8Array) => bytes,
  decompress: (bytes: Uint8Array) => bytes,
};

type StreamCtor = new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

interface CompressionGlobals {
  CompressionStream?: StreamCtor;
  DecompressionStream?: StreamCtor;
}

function globals(): CompressionGlobals {
  return globalThis as unknown as CompressionGlobals;
}

/** `true` when the runtime ships Web Streams compression (Node 18+, Deno, Bun, Workers, browsers). */
export function isCompressionSupported(): boolean {
  const g = globals();
  return typeof g.CompressionStream === "function" && typeof g.DecompressionStream === "function";
}

async function transform(
  bytes: Uint8Array,
  format: string,
  direction: "compress" | "decompress",
  providerName: string,
): Promise<Uint8Array> {
  const g = globals();
  const Ctor = direction === "compress" ? g.CompressionStream : g.DecompressionStream;
  if (typeof Ctor !== "function") {
    throw new CacheConfigurationError(
      `Compression provider "${providerName}" requires Web Streams compression ` +
        "(`CompressionStream`/`DecompressionStream`), which this runtime does not provide. " +
        "Use `noCompression` or a custom provider.",
    );
  }

  const stream = new Ctor(format);
  const chunks: Uint8Array[] = [];

  const reading = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
  })();

  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  await reading;

  return concatBytes(chunks);
}

/**
 * gzip compression based on Web Streams (no Node `zlib` import, so edge
 * runtimes keep working).
 *
 * ```ts
 * createCache({ compression: gzipCompression() });
 * ```
 */
export function gzipCompression(options: { name?: string } = {}): CompressionProvider {
  const name = options.name ?? "gzip";
  return {
    name,
    compress: (bytes: Uint8Array) => transform(bytes, "gzip", "compress", name),
    decompress: (bytes: Uint8Array) => transform(bytes, "gzip", "decompress", name),
  };
}

/** `deflate-raw`/`deflate` variant for runtimes that prefer it. */
export function deflateCompression(format: "deflate" | "deflate-raw" = "deflate"): CompressionProvider {
  return {
    name: format,
    compress: (bytes: Uint8Array) => transform(bytes, format, "compress", format),
    decompress: (bytes: Uint8Array) => transform(bytes, format, "decompress", format),
  };
}

/** Custom provider helper (brotli, zstd, lz4, ...). */
export function createCompressionProvider(provider: CompressionProvider): CompressionProvider {
  if (!provider.name) {
    throw new CacheConfigurationError("Compression providers must declare a name");
  }
  return provider;
}

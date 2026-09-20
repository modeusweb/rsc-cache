import { defineConfig } from "tsup";

/**
 * Build configuration for rsc-cache.
 *
 * - ESM only (the package is server-oriented and modern-runtime oriented).
 * - One entry per public subpath export, so `exports` never points at internals.
 * - Declarations are bundled per entry, so consumers never need to resolve
 *   internal modules or worry about extension mapping.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    memory: "src/memory.ts",
    redis: "src/redis.ts",
    kv: "src/kv.ts",
    react: "src/react/index.ts",
    next: "src/next.ts",
    opentelemetry: "src/opentelemetry.ts",
    testing: "src/testing/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: true,
  minify: false,
  outDir: "dist",
  external: ["react", "node:async_hooks", "node:module", "node:process"],
});

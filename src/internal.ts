/**
 * Internal cross-module wiring.
 *
 * Not exported from the package: subpath entries (`rsc-cache/react`,
 * `rsc-cache/next`, ...) are bundled together with the core, so they can reach
 * internals while applications cannot.
 */

import type { DescriptorContext } from "./cache-function.js";
import type { CacheRuntime } from "./runtime.js";
import type { CacheInstance } from "./types.js";

export const INTERNALS: unique symbol = Symbol.for("rsc-cache.internals");

export interface CacheInstanceInternals {
  runtime: CacheRuntime;
  descriptorContext: DescriptorContext;
}

export function attachInternals(instance: CacheInstance, internals: CacheInstanceInternals): void {
  Object.defineProperty(instance, INTERNALS, {
    value: internals,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function getInternals(instance: CacheInstance): CacheInstanceInternals {
  const internals = (instance as unknown as Record<symbol, CacheInstanceInternals | undefined>)[
    INTERNALS
  ];
  if (!internals) {
    throw new Error(
      "rsc-cache: this cache instance was not created by createCache() and cannot be used " +
        "by the framework adapters.",
    );
  }
  return internals;
}

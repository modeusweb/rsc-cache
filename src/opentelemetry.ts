/**
 * `rsc-cache/opentelemetry` — optional tracing integration.
 *
 * No dependency on `@opentelemetry/api`: the tracer is injected through a small
 * structural interface, so this module works with any OpenTelemetry-compatible
 * implementation (and stays tree-shakable when unused).
 *
 * Spans produced:
 *
 * ```text
 * rsc.cache.get        rsc.cache.set        rsc.cache.delete
 * rsc.cache.invalidate rsc.cache.lock       rsc.cache.source
 * ```
 *
 * Attributes: `cache.key_hash`, `cache.namespace`, `cache.backend`,
 * `cache.hit`, `cache.stale`, `cache.tags`, `cache.duration`.
 *
 * **Full cache keys are never emitted by default.** Keys are hashed anyway, but
 * `attributeKeys: "full"` exists for debugging and must be an explicit choice.
 */

import type { CacheInstrumentation, CacheOperation, CacheOperationMeta } from "./types.js";

export interface OtelSpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setAttributes?(attributes: Record<string, string | number | boolean>): unknown;
  recordException?(error: unknown): unknown;
  setStatus?(status: { code: number; message?: string }): unknown;
  end(): unknown;
}

export interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): OtelSpanLike;
}

export interface OpenTelemetryOptions {
  tracer: OtelTracerLike;
  /** Span name prefix. Default `"rsc.cache"`. */
  prefix?: string;
  /** Extra attributes added to every span. */
  attributes?: Record<string, string | number | boolean>;
}

const SPAN_NAMES: Record<CacheOperation, string> = {
  get: "get",
  set: "set",
  delete: "delete",
  invalidate: "invalidate",
  lock: "lock",
  source: "source",
};

/** Error status code of the OpenTelemetry status enum (`SpanStatusCode.ERROR`). */
const OTEL_ERROR = 2;

interface SpanResult {
  hit?: boolean;
  stale?: boolean;
  duration: number;
}

/** Infers `cache.hit` / `cache.stale` from the operation result. */
function describeResult(operation: CacheOperation, result: unknown): SpanResult {
  const span: SpanResult = { duration: 0 };
  if (operation === "get") {
    const entry = result as { expiresAt?: number } | null | undefined;
    span.hit = entry !== null && entry !== undefined;
    if (entry && typeof entry.expiresAt === "number") {
      span.stale = Date.now() >= entry.expiresAt;
    }
  }
  return span;
}

/**
 * Creates instrumentation producing spans with cache attributes.
 *
 * ```ts
 * import { trace } from "@opentelemetry/api";
 * import { createOpenTelemetryInstrumentation } from "rsc-cache/opentelemetry";
 *
 * const cache = createCache({
 *   instrumentation: createOpenTelemetryInstrumentation({ tracer: trace.getTracer("app") }),
 * });
 * ```
 */
export function createOpenTelemetryInstrumentation(
  options: OpenTelemetryOptions,
): CacheInstrumentation {
  const prefix = options.prefix ?? "rsc.cache";

  return {
    async wrapOperation<T>(
      operation: CacheOperation,
      meta: CacheOperationMeta,
      run: () => Promise<T>,
    ): Promise<T> {
      const span = options.tracer.startSpan(`${prefix}.${SPAN_NAMES[operation]}`, {
        attributes: {
          "cache.operation": operation,
          "cache.namespace": meta.namespace,
          "cache.key_hash": meta.keyHash,
          ...(meta.backend ? { "cache.backend": meta.backend } : {}),
          ...(meta.name ? { "cache.name": meta.name } : {}),
          ...(meta.tags && meta.tags.length > 0 ? { "cache.tags": meta.tags.join(",") } : {}),
          ...options.attributes,
        },
      });

      const startedAt = Date.now();
      try {
        const result = await run();
        const described = describeResult(operation, result);
        const attributes: Record<string, string | number | boolean> = {
          "cache.duration": Date.now() - startedAt,
        };
        if (described.hit !== undefined) {
          attributes["cache.hit"] = described.hit;
        }
        if (described.stale !== undefined) {
          attributes["cache.stale"] = described.stale;
        }
        if (span.setAttributes) {
          span.setAttributes(attributes);
        } else {
          for (const [key, value] of Object.entries(attributes)) {
            span.setAttribute(key, value);
          }
        }
        return result;
      } catch (error) {
        span.recordException?.(error);
        span.setStatus?.({
          code: OTEL_ERROR,
          ...(error instanceof Error ? { message: error.message } : {}),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  };
}

/**
 * Minimal in-memory tracer, useful in tests and for asserting span attributes
 * without pulling in the OpenTelemetry SDK.
 */
export function createRecordingTracer(): OtelTracerLike & {
  spans: Array<{ name: string; attributes: Record<string, unknown> }>;
} {
  const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  return {
    spans,
    startSpan(name, spanOptions) {
      const record = { name, attributes: { ...(spanOptions?.attributes ?? {}) } as Record<string, unknown> };
      spans.push(record);
      return {
        setAttribute(key, value) {
          record.attributes[key] = value;
          return undefined;
        },
        recordException() {
          return undefined;
        },
        setStatus() {
          return undefined;
        },
        end() {
          return undefined;
        },
      };
    },
  };
}

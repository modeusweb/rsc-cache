import { keyIdentifier } from "./keys.js";
import { getCacheContext } from "./context.js";
import type {
  CacheEvent,
  CacheEventHandlers,
  CacheEventInfo,
  CacheEventType,
  Logger,
} from "./types.js";
import { toError } from "./errors.js";

const HOOKS: Record<CacheEventType, keyof CacheEventHandlers> = {
  hit: "onHit",
  miss: "onMiss",
  stale: "onStale",
  set: "onSet",
  delete: "onDelete",
  revalidate: "onRevalidate",
  error: "onError",
  eviction: "onEviction",
  bypass: "onBypass",
  conflict: "onConflict",
  lock: "onLock",
  clear: "onClear",
};

export interface EventBusOptions {
  cache: string;
  /** Backend name attached to every event (for example `"memory"`, `"redis"`). */
  backend?: string;
  onEvent?: (event: CacheEvent) => void;
  hooks?: CacheEventHandlers;
  logger: Logger;
  debug?: boolean;
  /** Include full keys in events (default: hashed keys only). */
  exposeKeys?: boolean;
}

/**
 * Emits structured events.
 *
 * Handler failures are swallowed and reported through the logger: observability
 * must never break an application request.
 */
export class EventBus {
  private readonly options: EventBusOptions;
  private readonly logger: Logger;

  constructor(options: EventBusOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  create(type: CacheEventType, input: Partial<CacheEvent> & { key: string }): CacheEvent {
    const backend = input.backend ?? this.options.backend;
    const requestId = input.requestId ?? getCacheContext().requestId;
    const event: CacheEvent = {
      type,
      cache: this.options.cache,
      namespace: input.namespace ?? this.options.cache,
      key: this.options.exposeKeys === true ? input.key : keyIdentifier(input.key),
      keyHash: input.keyHash ?? keyIdentifier(input.key),
      timestamp: Date.now(),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(backend !== undefined ? { backend } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(input.hit !== undefined ? { hit: input.hit } : {}),
      ...(input.stale !== undefined ? { stale: input.stale } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    return event;
  }

  emit(event: CacheEvent, info: CacheEventInfo): void {
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      this.logger.error("onEvent handler threw", { event: event.type, error: toError(error) });
    }

    const hookName = HOOKS[event.type];
    const handler = this.options.hooks?.[hookName];
    if (handler) {
      try {
        handler(event, info);
      } catch (error) {
        this.logger.error(`${hookName} handler threw`, { error: toError(error) });
      }
    }

    if (this.options.debug === true) {
      this.debugLog(event);
    }
  }

  /** Convenience: build and emit in one call. */
  publish(
    type: CacheEventType,
    input: Partial<CacheEvent> & { key: string },
    info: CacheEventInfo,
  ): CacheEvent {
    const event = this.create(type, input);
    this.emit(event, info);
    return event;
  }

  private debugLog(event: CacheEvent): void {
    const details: string[] = [];
    if (event.duration !== undefined) {
      details.push(`duration=${Math.round(event.duration)}ms`);
    }
    if (event.tags && event.tags.length > 0) {
      details.push(`tags=${event.tags.join(",")}`);
    }
    if (event.outcome) {
      details.push(`outcome=${event.outcome}`);
    }
    if (event.backend) {
      details.push(`backend=${event.backend}`);
    }
    if (event.error) {
      details.push(`error=${event.error.name}: ${event.error.message}`);
    }
    this.logger.debug(
      `${event.type.toUpperCase()} ${event.key}${event.name ? ` (${event.name})` : ""}${
        details.length > 0 ? ` ${details.join(" ")}` : ""
      }`,
    );
  }
}

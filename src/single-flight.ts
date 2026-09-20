/**
 * Single-flight (request coalescing) with per-consumer cancellation.
 *
 * The problem: 100 concurrent renders hit the same cold key. Without
 * coalescing that is 100 database queries (cache stampede). With it, one query
 * and 100 consumers of the same promise.
 *
 * Cancellation rules (important for RSC):
 *
 * - Each consumer keeps its own `AbortSignal` (React's `cacheSignal()` in the
 *   React integration). A consumer that goes away only detaches itself.
 * - The shared computation is aborted **only** when every consumer has gone
 *   away — never because one stream finished early.
 * - Background revalidations are `keepAlive`: they are not tied to a request.
 */

import { createSharedSignal } from "./timeout.js";

interface FlightRecord {
  promise: Promise<unknown>;
  /** Number of consumers still interested in the result. */
  consumers: number;
  /** `true` for background work that must survive the request that started it. */
  keepAlive: boolean;
  /** `true` once the computation settled (do not abort a finished computation). */
  settled: boolean;
  /** Shared cancellation signal handed to the source function. */
  shared: { signal: AbortSignal; abort: (reason?: unknown) => void };
}

export interface RunOptions {
  signal?: AbortSignal;
  keepAlive?: boolean;
}

export class SingleFlight {
  private readonly flights = new Map<string, FlightRecord>();
  private readonly background = new Set<Promise<unknown>>();

  /**
   * Runs (or joins) the computation for `key`.
   *
   * The factory receives the shared `AbortSignal`; it must not be aborted just
   * because one consumer left.
   */
  run<T>(
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    options: RunOptions = {},
  ): Promise<T> {
    const { signal, keepAlive = false } = options;

    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Aborted before start"));
    }

    let record = this.flights.get(key);
    if (!record) {
      const shared = createSharedSignal();
      const created: FlightRecord = {
        // Consumers are counted by `attachConsumer` below, which runs
        // synchronously before the factory (scheduled on the next microtask),
        // so the shared signal is never aborted while work is in flight.
        consumers: 0,
        keepAlive,
        settled: false,
        shared,
        promise: undefined as unknown as Promise<unknown>,
      };
      created.promise = Promise.resolve()
        .then(() => factory(shared.signal))
        .finally(() => {
          created.settled = true;
          if (this.flights.get(key) === created) {
            this.flights.delete(key);
          }
        });
      // A flight whose consumers all left must not produce unhandled rejections.
      created.promise.catch(() => undefined);
      this.flights.set(key, created);
      record = created;
    } else if (keepAlive) {
      record.keepAlive = true;
    }

    const release = this.attachConsumer(record, signal);
    const result = record.promise.then(
      (value) => {
        release();
        return value;
      },
      (error: unknown) => {
        release();
        throw error;
      },
    );

    if (!signal) {
      return result as Promise<T>;
    }

    // A consumer whose request was cancelled stops waiting immediately, while
    // the shared work continues for everyone else.
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        release();
        reject(signal.reason ?? new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      result.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private attachConsumer(record: FlightRecord, signal?: AbortSignal): () => void {
    record.consumers += 1;
    let released = false;

    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      record.consumers -= 1;
      if (record.consumers <= 0 && !record.keepAlive && !record.settled) {
        record.shared.abort(new Error("All consumers of this computation are gone"));
      }
    };

    if (signal) {
      const listener = (): void => release();
      signal.addEventListener("abort", listener, { once: true });
      return () => {
        signal.removeEventListener("abort", listener);
        release();
      };
    }

    return release;
  }

  /** Registers a detached (best effort) task so it can be awaited on shutdown. */
  track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.catch(() => undefined);
    this.background.add(tracked);
    void tracked.finally(() => {
      this.background.delete(tracked);
    });
    return promise;
  }

  get size(): number {
    return this.flights.size;
  }

  keys(): string[] {
    return [...this.flights.keys()];
  }

  get backgroundSize(): number {
    return this.background.size;
  }

  has(key: string): boolean {
    return this.flights.has(key);
  }

  /** Waits for every in-flight computation and tracked background task. */
  async settle(): Promise<void> {
    while (this.flights.size > 0 || this.background.size > 0) {
      const pending: Array<Promise<unknown>> = [
        ...[...this.flights.values()].map((flight) => flight.promise.catch(() => undefined)),
        ...this.background,
      ];
      if (pending.length === 0) {
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  clear(): void {
    for (const record of this.flights.values()) {
      record.shared.abort(new Error("Single-flight cleared"));
    }
    this.flights.clear();
    this.background.clear();
  }
}

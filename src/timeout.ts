import { CacheTimeoutError } from "./errors.js";

/**
 * Guards a promise with a timeout.
 *
 * Storage operations must never hang forever. When the timeout fires the
 * rejection is a {@link CacheTimeoutError}; the caller decides whether that is
 * fail-open (default) or fail-closed.
 *
 * Uses the global timer functions only — no Node-only APIs.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  options: {
    name: string;
    signal?: AbortSignal;
    onTimeout?: () => void;
  },
): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return promise;
  }

  const { name, signal } = options;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      options.onTimeout?.();
      reject(new CacheTimeoutError(`${name} timed out after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(signal?.reason ?? new Error(`${name} aborted`));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** `setTimeout` as a promise, abortable. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Cancellable shared signal.
 *
 * Used by single-flight: one computation may be awaited by many consumers, and
 * it must only be cancelled once *every* consumer went away.
 */
export function createSharedSignal(): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
  };
}

/**
 * Combines multiple signals into one (`AbortSignal.any` is not available in
 * every runtime, so the logic is implemented locally).
 */
export function anySignal(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const controller = new AbortController();

  if (present.length === 0) {
    return { signal: controller.signal, dispose: () => undefined };
  }

  const listeners: Array<[AbortSignal, () => void]> = [];
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  for (const signal of present) {
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }
    const listener = (): void => abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      listeners.length = 0;
    },
  };
}

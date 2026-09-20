/** Test helpers shared by the suite. */

/** Polls until `condition` is true (avoids arbitrary sleeps). */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
  intervalMs = 2,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition was not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A promise plus its resolvers, for deterministic interleaving in tests. */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

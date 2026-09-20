import type { CacheStatsSnapshot } from "./types.js";

type CounterName = keyof Omit<CacheStatsSnapshot, "hitRate" | "lookups">;

/**
 * Bounded statistics.
 *
 * Only counters are kept — no per-key history — so statistics can run for
 * months without growing memory. Per-key observability belongs to events.
 */
export class CacheStats {
  private counters: Record<CounterName, number> = {
    hits: 0,
    misses: 0,
    staleHits: 0,
    sets: 0,
    deletes: 0,
    errors: 0,
    revalidations: 0,
    backgroundRevalidations: 0,
    evictions: 0,
    conflicts: 0,
    bypasses: 0,
    skipped: 0,
    locks: 0,
  };

  increment(name: CounterName, delta = 1): void {
    this.counters[name] += delta;
  }

  snapshot(): CacheStatsSnapshot {
    const { hits, misses, staleHits } = this.counters;
    const lookups = hits + misses + staleHits;
    return {
      ...this.counters,
      lookups,
      hitRate: lookups === 0 ? 0 : hits / lookups,
    };
  }

  reset(): void {
    for (const key of Object.keys(this.counters) as CounterName[]) {
      this.counters[key] = 0;
    }
  }
}

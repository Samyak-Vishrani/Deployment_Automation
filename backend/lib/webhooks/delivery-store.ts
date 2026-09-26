/**
 * Remembers GitHub delivery IDs so a redelivered webhook is processed once.
 *
 * A class rather than module-level state, so it can be constructed with a
 * different TTL in tests and shared as one instance everywhere else.
 *
 * This is the FAST path only, and it is deliberately allowed to forget: the
 * memory is empty after a restart, so a redelivery arriving then would sail
 * straight through. The durable guarantee lives in the database, on
 * Deployment's unique (projectId, deliveryId) constraint. Two layers, because
 * this one is cheap and catches the common case without touching Postgres.
 */
export class DeliveryStore {
  private seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxEntries = 1000,
  ) {}

  /** Returns true the first time a delivery ID is seen, false afterwards. */
  markAsProcessed(deliveryId: string): boolean {
    this.prune();
    if (this.seen.has(deliveryId)) {
      return false;
    }
    this.seen.set(deliveryId, Date.now());
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, timestamp] of this.seen) {
      if (timestamp < cutoff) {
        this.seen.delete(id);
      }
    }
    // Hard cap, oldest first, in case of a burst of deliveries.
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

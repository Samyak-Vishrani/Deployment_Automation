/**
 * At most N open streams per key (a user id): live log tails are costly for
 * the provider's rate limits and for us, and a forgotten tab must not hold
 * more than its share. In memory: a restart releases everything, which is
 * right, since every stream died with the process.
 */
export class StreamLimiter {
  private readonly open = new Map<string, number>();

  constructor(private readonly maxPerKey: number) {}

  /** A release function, or null when the key is at its limit. Releasing twice is harmless. */
  acquire(key: string): (() => void) | null {
    const count = this.open.get(key) ?? 0;
    if (count >= this.maxPerKey) return null;
    this.open.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = (this.open.get(key) ?? 1) - 1;
      if (now <= 0) this.open.delete(key);
      else this.open.set(key, now);
    };
  }

  count(key: string): number {
    return this.open.get(key) ?? 0;
  }
}

/**
 * Env vars handed over with a deploy request, held in memory only until the
 * run that needs them takes them.
 *
 * Moved from render_integration (Phase 9) so vercel_integration can use it
 * too. They are never written to a service's database: values at rest are
 * values that can leak, and the main backend sends them again with every
 * deploy. The cost: a deploy interrupted by a restart BEFORE it reached the
 * provider cannot continue, and is failed with "deploy again".
 */
export class EnvVault<T = { key: string; value: string }> {
  private readonly entries = new Map<string, { vars: T[]; expiresAt: number }>();

  constructor(private readonly ttlMs = 60 * 60 * 1000) {}

  put(deploymentId: string, vars: T[] | undefined): void {
    this.sweep();
    this.entries.set(deploymentId, { vars: vars ?? [], expiresAt: Date.now() + this.ttlMs });
  }

  /** Returns the vars and forgets them; undefined when they are gone (restart, expiry). */
  take(deploymentId: string): T[] | undefined {
    this.sweep();
    const entry = this.entries.get(deploymentId);
    this.entries.delete(deploymentId);
    return entry?.vars;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

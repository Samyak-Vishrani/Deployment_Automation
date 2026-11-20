import type { EnvVar } from "../types";

/**
 * The project's env vars handed over with a deploy request, held in memory
 * only until the run that needs them takes them.
 *
 * They are never written to this service's database: values at rest are
 * values that can leak, and the main backend sends them again with every
 * deploy. The cost: a deploy interrupted by a restart BEFORE it reached Render
 * cannot continue, and is failed with "deploy again".
 */
export class EnvVault {
  private readonly entries = new Map<string, { vars: EnvVar[]; expiresAt: number }>();

  constructor(private readonly ttlMs = 60 * 60 * 1000) {}

  put(deploymentId: string, vars: EnvVar[] | undefined): void {
    this.sweep();
    this.entries.set(deploymentId, { vars: vars ?? [], expiresAt: Date.now() + this.ttlMs });
  }

  /** Returns the vars and forgets them; undefined when they are gone (restart, expiry). */
  take(deploymentId: string): EnvVar[] | undefined {
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

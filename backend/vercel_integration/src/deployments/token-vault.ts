/**
 * GitHub installation tokens handed over with a deploy request, held in memory
 * only and only until the run that needs them takes them.
 *
 * They are never written to the database: a token at rest is a token that can
 * leak, and these expire within an hour anyway. The cost is that a deploy
 * interrupted by a restart BEFORE its upload cannot finish the upload; it is
 * failed with "deploy again" instead.
 */
export class TokenVault {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly ttlMs = 55 * 60 * 1000) {}

  put(deploymentId: string, token: string | undefined): void {
    this.sweep();
    if (token) this.tokens.set(deploymentId, { token, expiresAt: Date.now() + this.ttlMs });
  }

  /** Returns the token and forgets it. */
  take(deploymentId: string): string | undefined {
    this.sweep();
    const entry = this.tokens.get(deploymentId);
    this.tokens.delete(deploymentId);
    return entry?.token;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(id);
    }
  }
}

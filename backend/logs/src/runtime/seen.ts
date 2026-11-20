/** The last N ids seen, for de-duplicating overlapping polls and reconnects. */
export class SeenIds {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly max = 2000) {}

  /** True the first time an id is seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > this.max) this.ids.delete(this.order.shift()!);
    return true;
  }
}

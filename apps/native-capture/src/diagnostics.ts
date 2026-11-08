import { DiagnosticTimeline } from '@meeting/contracts';
/** Memory only: four attempts, thirty minutes after last event. */
export class CaptureDiagnostics {
  private readonly entries = new Map<string, { timeline: DiagnosticTimeline; touched: number; active: boolean }>();
  constructor(private readonly now = () => performance.now()) {}
  private prune(): void {
    for (const [id, item] of this.entries) if (!item.active && this.now() - item.touched > 30 * 60_000) this.entries.delete(id);
  }
  begin(id: string): ((event: unknown) => void) | undefined {
    this.prune();
    if (this.entries.has(id)) return;
    const entry = { timeline: new DiagnosticTimeline(id, this.now), touched: this.now(), active: true };
    this.entries.set(id, entry);
    while (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
    return event => { entry.touched = this.now(); entry.timeline.record(event); };
  }
  finish(id: string): void {
    const item = this.entries.get(id);
    if (item) { item.active = false; item.touched = this.now(); }
  }
  snapshot(id: string) { this.prune(); return this.entries.get(id)?.timeline.snapshot(); }
}

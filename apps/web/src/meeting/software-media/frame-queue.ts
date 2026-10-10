export class FrameQueue<T extends { close(): void }> {
  private readonly items: Array<{ frame: T; capturedAt: number }> = [];
  queueDrops = 0;
  expiredDrops = 0;
  get length(): number { return this.items.length; }
  push(frame: T, capturedAt: number): void {
    if (this.items.length >= 6) { this.items.shift()!.frame.close(); this.queueDrops++; }
    this.items.push({ frame, capturedAt });
  }
  take(now: number): { frame: T; capturedAt: number } | undefined {
    while (this.items.length) {
      const item = this.items.shift()!;
      if (now - item.capturedAt > 150) { item.frame.close(); this.expiredDrops++; }
      else return item;
    }
    return undefined;
  }
  clear(): void { for (const item of this.items.splice(0)) item.frame.close(); }
}

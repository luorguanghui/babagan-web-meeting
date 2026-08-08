export class AudioPlayback {
  private readonly elements = new Set<HTMLMediaElement>();
  private readonly blockedElements = new Set<HTMLMediaElement>();
  private readonly attempts = new Map<HTMLMediaElement, number>();
  private readonly listeners = new Set<(blocked: boolean) => void>();
  private blocked = false;
  private generation = 0;

  subscribe(listener: (blocked: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.blocked);
    return () => this.listeners.delete(listener);
  }

  async add(element: HTMLMediaElement): Promise<void> {
    this.elements.add(element);
    await this.tryPlay(element);
  }

  remove(element: HTMLMediaElement): void {
    this.elements.delete(element);
    this.blockedElements.delete(element);
    this.attempts.delete(element);
    element.remove();
    this.recomputeBlocked();
  }

  async resume(): Promise<void> {
    await Promise.all([...this.elements].map((element) => this.tryPlay(element)));
  }

  clear(): void {
    this.generation += 1;
    for (const element of this.elements) element.remove();
    this.elements.clear();
    this.blockedElements.clear();
    this.attempts.clear();
    this.recomputeBlocked();
  }

  private async tryPlay(element: HTMLMediaElement): Promise<void> {
    const generation = this.generation;
    const attempt = (this.attempts.get(element) ?? 0) + 1;
    this.attempts.set(element, attempt);
    try {
      await element.play();
      if (!this.ownsAttempt(element, generation, attempt)) return;
      this.blockedElements.delete(element);
      this.recomputeBlocked();
    } catch (reason) {
      if (!this.ownsAttempt(element, generation, attempt)) return;
      if (typeof reason === 'object' && reason !== null && 'name' in reason && reason.name === 'NotAllowedError') {
        this.blockedElements.add(element);
        this.recomputeBlocked();
        return;
      }
      throw reason;
    }
  }

  private ownsAttempt(element: HTMLMediaElement, generation: number, attempt: number): boolean {
    return this.generation === generation && this.elements.has(element) && this.attempts.get(element) === attempt;
  }

  private recomputeBlocked(): void {
    this.setBlocked(this.blockedElements.size > 0);
  }

  private setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    for (const listener of this.listeners) listener(blocked);
  }
}

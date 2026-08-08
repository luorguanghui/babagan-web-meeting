export class AudioPlayback {
  private readonly elements = new Set<HTMLMediaElement>();
  private readonly listeners = new Set<(blocked: boolean) => void>();
  private blocked = false;

  subscribe(listener: (blocked: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.blocked);
    return () => this.listeners.delete(listener);
  }

  async add(element: HTMLMediaElement): Promise<void> {
    this.elements.add(element);
    await this.tryPlay([element]);
  }

  remove(element: HTMLMediaElement): void {
    this.elements.delete(element);
    element.remove();
  }

  async resume(): Promise<void> {
    await this.tryPlay([...this.elements]);
  }

  clear(): void {
    for (const element of this.elements) element.remove();
    this.elements.clear();
    this.setBlocked(false);
  }

  private async tryPlay(elements: HTMLMediaElement[]): Promise<void> {
    try {
      await Promise.all(elements.map((element) => element.play()));
      this.setBlocked(false);
    } catch (reason) {
      if (typeof reason === 'object' && reason !== null && 'name' in reason && reason.name === 'NotAllowedError') {
        this.setBlocked(true);
        return;
      }
      throw reason;
    }
  }

  private setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    for (const listener of this.listeners) listener(blocked);
  }
}

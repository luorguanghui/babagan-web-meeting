import type { Clock } from '../../src/services/meeting-service.js';

export class FakeClock implements Clock {
  public constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  set(value: number): void {
    this.value = value;
  }
}

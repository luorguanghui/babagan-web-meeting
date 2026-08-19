import { Mutex } from 'async-mutex';

export class KeyedMutex {
  private readonly mutexes = new Map<string, Mutex>();

  async runExclusive<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const mutex = this.mutexes.get(key) ?? new Mutex();
    this.mutexes.set(key, mutex);

    try {
      return await mutex.runExclusive(fn);
    } finally {
      if (!mutex.isLocked()) this.mutexes.delete(key);
    }
  }
}

/** One in-process mutex per normalized file path. */
export class KeyedMutex {
  readonly #queues = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#queues.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }
}

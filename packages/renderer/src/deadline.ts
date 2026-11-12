/** Whole-job deadline. Every awaited Electron or filesystem promise is raced with it. */
export class JobDeadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  #reason: Error;

  constructor(remainingMs: number, message: string) {
    this.#reason = new Error(message);
    this.#timer = setTimeout(() => this.abort(message), Math.max(0, remainingMs));
    this.#timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get aborted(): boolean {
    return this.signal.aborted;
  }

  get reason(): Error {
    return this.#reason;
  }

  abort(reason: Error | string): void {
    if (this.signal.aborted) return;
    this.#reason = typeof reason === "string" ? new Error(reason) : reason;
    this.#controller.abort(this.#reason);
  }

  race<T>(promise: Promise<T>): Promise<T> {
    if (this.aborted) return Promise.reject(this.#reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.#reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    clearTimeout(this.#timer);
  }
}

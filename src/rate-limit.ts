export class StartRateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private nextStart = 0;

  async run<T>(minimumGapMs: number, task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const wait = Math.max(0, this.nextStart - Date.now());
    if (wait) await Bun.sleep(wait);
    this.nextStart = Date.now() + minimumGapMs;
    release();
    return task();
  }

  reset(): void {
    this.nextStart = 0;
    this.queue = Promise.resolve();
  }
}

// src/jobLock.ts
export class JobLock {
  private locked = false;
  private timer: NodeJS.Timeout | null = null;
  private waiting: Array<() => void> = [];

  constructor(private maxHoldMs = 30 * 60 * 1000) {} // 30 minutes default

  get isLocked() {
    return this.locked;
  }

  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryLock = () => {
        if (!this.locked) {
          this.locked = true;
          // TTL watchdog to avoid permanent deadlocks
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            // Force release if holder forgot to release or process stuck
            this.forceRelease();
          }, this.maxHoldMs);
          resolve(this.release);
        } else {
          this.waiting.push(tryLock);
        }
      };
      tryLock();
    });
  }

  private release = () => {
    if (!this.locked) return;
    this.locked = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.waiting.shift();
    if (next) next();
  };

  private forceRelease() {
    this.locked = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.waiting.shift();
    if (next) next();
  }
}
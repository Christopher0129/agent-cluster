export class FakeProvider {
  constructor(queue) {
    this.queue = [...queue];
  }

  async invoke(options = {}) {
    if (!this.queue.length) {
      throw new Error("No more fake responses available.");
    }
    const next = this.queue.shift();
    if (typeof next === "function") {
      return next(options);
    }
    return { text: next };
  }
}

export function waitForDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      const error = new Error("aborted");
      error.name = "AbortError";
      error.cancelled = true;
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class DelayedJsonProvider {
  constructor(payload, delayMs, tracker = null) {
    this.payload = payload;
    this.delayMs = delayMs;
    this.tracker = tracker;
  }

  async invoke({ signal } = {}) {
    if (this.tracker) {
      this.tracker.current += 1;
      this.tracker.max = Math.max(this.tracker.max, this.tracker.current);
    }

    try {
      await waitForDelay(this.delayMs, signal);
      return {
        text: JSON.stringify(this.payload)
      };
    } finally {
      if (this.tracker) {
        this.tracker.current -= 1;
      }
    }
  }
}

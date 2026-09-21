/**
 * The buffer that keeps persistence off the response path.
 *
 * A database write is somebody else's disk, or somebody else's network. Doing
 * it inline would put crawlmeter's latency into every crawler response and,
 * worse, would put a database outage into the site's error rate. So `push` is
 * synchronous and returns immediately; the actual write happens on a later
 * turn, in batches, and a failure is reported to `onError` and then forgotten.
 *
 * Losing a batch of analytics is an acceptable failure. Delaying or breaking a
 * response is not. That is the same trade the rest of the package makes.
 */

import type { CrawlEvent } from "./types.js";

export interface WriteQueueOptions {
  /** Persist one batch. May reject; the queue keeps going either way. */
  readonly flush: (batch: readonly CrawlEvent[]) => Promise<void> | void;
  /** Events per write. Default 500. */
  readonly maxBatch?: number;
  /** Events held before the oldest are dropped. Default 10_000. */
  readonly maxPending?: number;
  /** Called with whatever `flush` threw. Default: silence. */
  readonly onError?: (error: unknown) => void;
}

export interface WriteQueue {
  /** Queue an event. Never blocks, never throws. */
  push(event: CrawlEvent): void;
  /** Wait until everything queued so far has been handed to `flush`. */
  drain(): Promise<void>;
  /** Events dropped because the queue was full. */
  readonly dropped: number;
  /** Events waiting to be written. */
  readonly size: number;
}

const DEFAULT_MAX_BATCH = 500;
const DEFAULT_MAX_PENDING = 10_000;

export function createWriteQueue(options: WriteQueueOptions): WriteQueue {
  const maxBatch = Math.max(1, options.maxBatch ?? DEFAULT_MAX_BATCH);
  const maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);

  let pending: CrawlEvent[] = [];
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    if (timer !== null || running !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, 0);
    // A queued analytics write must never be the reason a process stays alive.
    timer.unref?.();
  }

  function run(): Promise<void> {
    if (running !== null) return running;
    running = (async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, maxBatch);
        try {
          await options.flush(batch);
        } catch (error) {
          // Swallowed on purpose. The batch is gone; the site is fine.
          options.onError?.(error);
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    push(event: CrawlEvent): void {
      pending.push(event);
      if (pending.length > maxPending) {
        const overflow = pending.length - maxPending;
        pending = pending.slice(overflow);
        dropped += overflow;
      }
      schedule();
    },
    async drain(): Promise<void> {
      clearTimer();
      while (pending.length > 0 || running !== null) {
        await (running ?? run());
      }
    },
    get dropped(): number {
      return dropped;
    },
    get size(): number {
      return pending.length;
    },
  };
}

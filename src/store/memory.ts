/**
 * The default store: events in a bounded buffer in this process.
 *
 * It is the default because it is the one that costs nothing to try. No driver,
 * no file, no connection string — `npm i crawlmeter`, one line of config, and
 * the report works. That is the whole "see it in five minutes" promise, and a
 * persistent store is an upgrade for people who decide they want history.
 *
 * Bounded on purpose. This sits in a long-running server, so an unbounded array
 * is a memory leak with a delay fuse. When the buffer is full the oldest event
 * is dropped: losing the start of the window is a smaller lie than taking the
 * site down, and it matches the fail-open rule everywhere else.
 */

import {
  aggregate,
  type CrawlEvent,
  type Store,
  type Summary,
  type TimeRange,
} from "./types.js";

export interface MemoryStoreOptions {
  /** How many events to keep. Default 100_000, roughly 20 MB. */
  readonly maxEvents?: number;
}

export interface MemoryStore extends Store {
  /** Events currently held, oldest first. Mostly useful in tests. */
  readonly events: readonly CrawlEvent[];
  /** How many events were dropped to stay within `maxEvents`. */
  readonly dropped: number;
}

const DEFAULT_MAX_EVENTS = 100_000;

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
  let events: CrawlEvent[] = [];
  let dropped = 0;

  return {
    get events(): readonly CrawlEvent[] {
      return events;
    },
    get dropped(): number {
      return dropped;
    },
    record(event: CrawlEvent): void {
      events.push(event);
      if (events.length > maxEvents) {
        // Drop in one slice rather than shifting per write: shift() on a large
        // array is O(n) and this runs once per crawler request.
        const overflow = events.length - maxEvents;
        events = events.slice(overflow);
        dropped += overflow;
      }
    },
    summary(range?: TimeRange): Promise<Summary> {
      return Promise.resolve(aggregate(events, range));
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      events = [];
      return Promise.resolve();
    },
  };
}

/**
 * A store that is still opening.
 *
 * The persistent stores open asynchronously — a file, a connection — but the
 * places they are configured are not: a Next.js `proxy.ts` defines its export
 * at module top level, where `await` cannot be counted on. So the adapters
 * accept a `Promise<Store>` and wrap it here. The caller writes
 *
 *     store: createSqliteStore({ path: "crawlmeter.db" })
 *
 * and nothing has to wait for the file to open.
 *
 * Events recorded before the store is ready are held, briefly and boundedly,
 * and handed over once it is. If the store never opens, they are dropped and
 * the error goes to `onError` — recording is best-effort everywhere else in
 * crawlmeter, and a database that will not open must not become a site that
 * will not serve.
 */

import type { CrawlEvent, Store, Summary, TimeRange } from "./types.js";

/** How many early events to hold while the store opens. */
const MAX_EARLY_EVENTS = 10_000;

export function deferStore(pending: Promise<Store>, onError?: (error: unknown) => void): Store {
  let store: Store | null = null;
  let failed = false;
  let early: CrawlEvent[] = [];

  const opened = pending.then(
    (ready) => {
      store = ready;
      const held = early;
      early = [];
      for (const event of held) ready.record(event);
      return ready;
    },
    (error: unknown) => {
      failed = true;
      early = [];
      onError?.(error);
      throw error;
    },
  );
  // Handled here so an un-awaited failure cannot crash the process; callers of
  // `summary` still see the rejection.
  opened.catch(() => {});

  return {
    record(event: CrawlEvent): void {
      if (store !== null) {
        store.record(event);
        return;
      }
      if (failed) return;
      early.push(event);
      if (early.length > MAX_EARLY_EVENTS) early = early.slice(early.length - MAX_EARLY_EVENTS);
    },
    async summary(range?: TimeRange): Promise<Summary> {
      return (await opened).summary(range);
    },
    async flush(): Promise<void> {
      // Nothing to flush into a store that never opened, and `flush` is what
      // `waitUntil` awaits — it should not report an error the operator has
      // already been told about.
      const ready = await opened.catch(() => null);
      await ready?.flush();
    },
    async close(): Promise<void> {
      const ready = await opened.catch(() => null);
      await ready?.close();
    },
  };
}

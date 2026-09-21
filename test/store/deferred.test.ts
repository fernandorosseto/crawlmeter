import { describe, expect, it, vi } from "vitest";

import { deferStore } from "../../src/store/deferred.js";
import { createMemoryStore } from "../../src/store/memory.js";
import type { CrawlEvent, Store } from "../../src/store/types.js";

function event(at: number): CrawlEvent {
  return {
    at,
    agent: "gptbot",
    operator: "openai",
    confidence: "ip-range",
    method: "GET",
    path: "/",
    route: "*",
    action: "pass",
    reason: "observe-mode",
    priceMicros: 10_000,
    potentialMicros: 10_000,
    bytes: null,
  };
}

/** A promise the test resolves or rejects by hand. */
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("deferStore", () => {
  it("holds events recorded before the store opens, and hands them over", async () => {
    // The first crawler can arrive before the database file is open.
    const opening = pending<Store>();
    const store = deferStore(opening.promise);

    store.record(event(1));
    store.record(event(2));

    const real = createMemoryStore();
    opening.resolve(real);
    await store.flush();

    expect(real.events.map((each) => each.at)).toEqual([1, 2]);
  });

  it("writes straight through once open", async () => {
    const real = createMemoryStore();
    const store = deferStore(Promise.resolve(real));
    await store.flush();

    store.record(event(3));
    expect(real.events.map((each) => each.at)).toEqual([3]);
  });

  it("reads through to the real store", async () => {
    const real = createMemoryStore();
    const store = deferStore(Promise.resolve(real));
    store.record(event(1));

    expect((await store.summary()).totals.hits).toBe(1);
  });

  it("never throws from record when the store fails to open", async () => {
    // A database that will not open must not become a site that will not serve.
    const onError = vi.fn();
    const store = deferStore(Promise.reject(new Error("EACCES: crawlmeter.db")), onError);

    expect(() => store.record(event(1))).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    await expect(store.summary()).rejects.toThrow("EACCES");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(() => store.record(event(2))).not.toThrow();
  });

  it("does not crash the process when nobody awaits a failed open", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      deferStore(Promise.reject(new Error("no disk")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("bounds what it holds while waiting", async () => {
    const opening = pending<Store>();
    const store = deferStore(opening.promise);
    for (let i = 0; i < 10_050; i += 1) store.record(event(i));

    const real = createMemoryStore();
    opening.resolve(real);
    await store.flush();

    expect(real.events).toHaveLength(10_000);
    expect(real.events[0]?.at).toBe(50);
  });
});

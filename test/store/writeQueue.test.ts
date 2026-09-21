import { describe, expect, it, vi } from "vitest";

import { createWriteQueue } from "../../src/store/writeQueue.js";
import type { CrawlEvent } from "../../src/store/types.js";

function event(at: number): CrawlEvent {
  return {
    at,
    agent: "gptbot",
    operator: "openai",
    confidence: "ip-range",
    method: "GET",
    path: "/blog/hello",
    route: "/blog/*",
    action: "pass",
    reason: "observe-mode",
    priceMicros: 10_000,
    potentialMicros: 10_000,
    bytes: 1_000,
  };
}

describe("createWriteQueue", () => {
  it("returns from push before anything is written", async () => {
    // This is the whole point of the queue: the response goes out, the write
    // happens later.
    let written = 0;
    const queue = createWriteQueue({
      flush: (batch) => {
        written += batch.length;
      },
    });

    queue.push(event(1));
    expect(written).toBe(0);
    expect(queue.size).toBe(1);

    await queue.drain();
    expect(written).toBe(1);
  });

  it("batches what piled up into one write", async () => {
    const flush = vi.fn();
    const queue = createWriteQueue({ flush, maxBatch: 100 });

    for (let i = 0; i < 50; i += 1) queue.push(event(i));
    await queue.drain();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]?.[0]).toHaveLength(50);
  });

  it("splits a pile larger than maxBatch", async () => {
    const flush = vi.fn();
    const queue = createWriteQueue({ flush, maxBatch: 10 });

    for (let i = 0; i < 25; i += 1) queue.push(event(i));
    await queue.drain();

    expect(flush).toHaveBeenCalledTimes(3);
    expect(flush.mock.calls.map((call) => (call[0] as unknown[]).length)).toEqual([10, 10, 5]);
  });

  it("swallows a failed write and keeps going", async () => {
    // A database having a bad minute costs a batch of analytics. It must not
    // reject into the request path, and it must not stop later writes.
    const onError = vi.fn();
    let calls = 0;
    const queue = createWriteQueue({
      flush: () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
      },
      maxBatch: 1,
      onError,
    });

    queue.push(event(1));
    queue.push(event(2));
    await expect(queue.drain()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("swallows a rejected async write too", async () => {
    const onError = vi.fn();
    const queue = createWriteQueue({
      flush: () => Promise.reject(new Error("timeout")),
      onError,
    });

    queue.push(event(1));
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("survives a flush that fails without an onError handler", async () => {
    const queue = createWriteQueue({
      flush: () => {
        throw new Error("nobody is listening");
      },
    });

    queue.push(event(1));
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("drops the oldest when the backlog gets out of hand", async () => {
    // Back pressure has to go somewhere. Memory is not it.
    const flush = vi.fn();
    const queue = createWriteQueue({ flush, maxPending: 5, maxBatch: 100 });

    for (let i = 0; i < 20; i += 1) queue.push(event(i));
    expect(queue.dropped).toBe(15);

    await queue.drain();
    const batch = flush.mock.calls[0]?.[0] as readonly CrawlEvent[];
    expect(batch).toHaveLength(5);
    expect(batch[0]?.at).toBe(15);
  });

  it("drains events pushed while a write is in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: number[] = [];

    const queue = createWriteQueue({
      flush: async (batch) => {
        for (const each of batch) seen.push(each.at);
        if (seen.length === 1) await gate;
      },
      maxBatch: 1,
    });

    queue.push(event(1));
    const drained = queue.drain();
    queue.push(event(2));
    release();
    await drained;

    expect(seen).toEqual([1, 2]);
  });

  it("drains to nothing when empty", async () => {
    const queue = createWriteQueue({ flush: vi.fn() });
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(queue.size).toBe(0);
  });
});

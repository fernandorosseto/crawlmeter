import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server.js";

import {
  MEMORY_STORE_WARNING,
  NO_ADDRESS_WARNING,
  crawlmeter,
  type CrawlmeterProxyOptions,
} from "../../src/adapters/next.js";
import type { Detector } from "../../src/detect/index.js";
import { issueSessionToken, verifySessionToken } from "../../src/session.js";
import type { SettleOutcome } from "../../src/payment/gateway.js";
import { createMemoryStore, type MemoryStore } from "../../src/store/memory.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import { LEGACY_HEADERS } from "../../src/headers.js";
import type { Identification, Money } from "../../src/types.js";

/**
 * The Next.js proxy, driven with the real `NextRequest` and `NextResponse` from
 * `next/server` — the objects Next.js hands a proxy in production.
 *
 * Same battery as the Express adapter, plus what is specific to Next: no socket
 * (so the proxy header is the only address), no view of the rendered page (so
 * sizes are unmeasured, not zero), isolation from the app (so a memory store
 * earns a warning), and `waitUntil` (so writes survive the instance freezing).
 */

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const GPTBOT = "GPTBot/1.4";
const OPENAI_IP = "132.196.86.5";
const REAL_CLIENT = "203.0.113.9";

const ENFORCE = {
  mode: "enforce" as const,
  payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
  network: "eip155:8453",
  facilitator: "https://x402.org/facilitator",
  session: { secret: "test-secret" },
};

function identified(confidence: Identification["confidence"] = "ip-range"): Identification {
  return { agent: "gptbot", operator: "openai", confidence, evidence: ["ua:gptbot"] };
}

function fakeGateway(
  settle: SettleOutcome = { status: "settled", paymentResponse: "receipt-123", transaction: "0xabc" },
) {
  return {
    ready: vi.fn(() => Promise.resolve()),
    challenge: vi.fn((price: Money) => Promise.resolve(`challenge-for-${price.micros}`)),
    settle: vi.fn((_signature: string, _price: Money) => Promise.resolve(settle)),
  };
}

/** A NextFetchEvent whose waitUntil promises can be awaited. */
function fetchEvent() {
  const pending: Promise<unknown>[] = [];
  const event = { waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)) };
  return { event: event as unknown as NextFetchEvent, waitUntil: event.waitUntil, settled: () => Promise.all(pending) };
}

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://example.com${path}`, { headers });
}

/** A proxy with a memory store and a scripted detector, and no noise. */
function proxy(options: CrawlmeterProxyOptions = {}) {
  const store = (options.store ?? createMemoryStore()) as MemoryStore;
  const subject = crawlmeter({
    detector: () => Promise.resolve(identified()),
    onWarning: () => {},
    ...(options.mode === "enforce" && options.payment === undefined ? { payment: fakeGateway() } : {}),
    ...options,
    store,
  });
  return { subject, store };
}

/** True when the proxy told Next.js to carry on to the route. */
function continues(response: NextResponse | undefined): boolean {
  return response === undefined || response.headers.get("x-middleware-next") === "1";
}

/* -------------------------------------------------------------------------- */

describe("the fast path", () => {
  it("lets a browser through synchronously, without detecting or recording", () => {
    const detector = vi.fn<Detector>(() => Promise.resolve(identified()));
    const { subject, store } = proxy({ detector });

    const result = subject(request("/blog/hello", { "user-agent": CHROME }));

    // Not a promise: a human visitor does not pay even a microtask.
    expect(result).toBeUndefined();
    expect(detector).not.toHaveBeenCalled();
    expect(store.events).toHaveLength(0);
  });
});

describe("observe mode", () => {
  it("lets the crawler through and books the potential revenue", async () => {
    const { subject, store } = proxy({ price: "$0.01" });
    const response = await subject(request("/blog/hello", { "user-agent": GPTBOT }));

    expect(continues(response)).toBe(true);
    expect(store.events[0]?.reason).toBe("observe-mode");
    expect(store.events[0]?.potentialMicros).toBe(10_000);
  });

  it("records the size as unmeasured, because the proxy never sees the page", async () => {
    // Zero would tell the operator the crawlers cost them nothing.
    const { subject, store } = proxy({ price: "$0.01" });
    await subject(request("/blog/hello", { "user-agent": GPTBOT }));

    expect(store.events[0]?.bytes).toBeNull();
  });

  it("prices by path and ignores the query string", async () => {
    const { subject, store } = proxy({ routes: { "/blog/*": "$0.05" }, price: "$0.01" });
    await subject(request("/blog/hello?utm_source=x", { "user-agent": GPTBOT }));

    expect(store.events[0]?.path).toBe("/blog/hello");
    expect(store.events[0]?.potentialMicros).toBe(50_000);
  });

  it("passes robots.txt free", async () => {
    const { subject, store } = proxy({ price: "$0.01" });
    await subject(request("/robots.txt", { "user-agent": GPTBOT }));

    expect(store.events[0]?.reason).toBe("free-path");
  });
});

describe("the client address", () => {
  it("trusts one proxy by default, because there is no socket to fall back on", async () => {
    const seen: Array<string | null | undefined> = [];
    const { subject } = proxy({
      price: "$0.01",
      detector: (input) => {
        seen.push(input.ip);
        return Promise.resolve(identified());
      },
    });

    await subject(request("/blog/hello", { "user-agent": GPTBOT, "x-forwarded-for": REAL_CLIENT }));

    expect(seen).toEqual([REAL_CLIENT]);
  });

  it("reads the entry the proxy appended, not the one the client forged", async () => {
    // Behind nginx or a load balancer, the forged value is on the left.
    const seen: Array<string | null | undefined> = [];
    const { subject } = proxy({
      price: "$0.01",
      detector: (input) => {
        seen.push(input.ip);
        return Promise.resolve(identified());
      },
    });

    await subject(
      request("/blog/hello", {
        "user-agent": GPTBOT,
        "x-forwarded-for": `${OPENAI_IP}, ${REAL_CLIENT}`,
      }),
    );

    expect(seen).toEqual([REAL_CLIENT]);
  });

  it("warns at startup when told to trust no proxy, since that leaves no address at all", () => {
    const onWarning = vi.fn();
    crawlmeter({ trustProxy: false, store: createMemoryStore(), onWarning });
    expect(onWarning).toHaveBeenCalledWith(NO_ADDRESS_WARNING);
  });
});

describe("the store", () => {
  it("warns at startup when no store is given", () => {
    // The proxy is isolated from the app: an in-memory store there is a report
    // nobody can read.
    const onWarning = vi.fn();
    crawlmeter({ onWarning });
    expect(onWarning).toHaveBeenCalledWith(MEMORY_STORE_WARNING);
  });

  it("stays quiet when a store is given", () => {
    const onWarning = vi.fn();
    crawlmeter({ store: createMemoryStore(), onWarning });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("keeps the instance alive until the write has landed", async () => {
    // Serverless platforms may freeze the proxy as soon as it returns. The
    // write is handed to waitUntil, and once that settles it is on disk.
    const store = await createSqliteStore({ path: ":memory:" });
    try {
      const subject = crawlmeter({
        price: "$0.01",
        store,
        detector: () => Promise.resolve(identified()),
        onWarning: () => {},
      });
      const { event, waitUntil, settled } = fetchEvent();

      await subject(request("/blog/hello", { "user-agent": GPTBOT }), event);
      expect(waitUntil).toHaveBeenCalledTimes(1);

      await settled();
      expect((await store.summary()).totals.hits).toBe(1);
    } finally {
      await store.close();
    }
  });
});

describe("enforce mode", () => {
  it("answers 402 with the price and the x402 challenge", async () => {
    const { subject } = proxy({ ...ENFORCE, price: "$0.01" });
    const response = await subject(request("/blog/hello", { "user-agent": GPTBOT }));

    expect(response?.status).toBe(402);
    expect(response?.headers.get("crawler-price")).toBe("USD 0.01");
    expect(response?.headers.get("payment-required")).toBe("challenge-for-10000");
    for (const legacy of LEGACY_HEADERS) expect(response?.headers.get(legacy)).toBeNull();
  });

  it("measures the 402, which it wrote itself", async () => {
    const { subject, store } = proxy({ ...ENFORCE, price: "$0.01" });
    const response = await subject(request("/blog/hello", { "user-agent": GPTBOT }));
    const body = await response!.text();

    expect(store.events[0]?.bytes).toBe(new TextEncoder().encode(body).length);
  });

  it("serves a settled payment with every receipt on the response", async () => {
    const { subject, store } = proxy({ ...ENFORCE, price: "$0.01" });
    const response = await subject(
      request("/blog/hello", { "user-agent": GPTBOT, "payment-signature": "signed" }),
    );

    expect(continues(response)).toBe(true);
    expect(response?.headers.get("crawler-charged")).toBe("USD 0.01");
    expect(response?.headers.get("payment-response")).toBe("receipt-123");
    const session = await verifySessionToken(response?.headers.get("crawlmeter-session"), {
      secret: ENFORCE.session.secret,
    });
    expect(session?.agent).toBe("gptbot");
    expect(store.events[0]?.action).toBe("accept-payment");
  });

  it("answers a rejected payment with the price again", async () => {
    const payment = fakeGateway({ status: "rejected", reason: "insufficient_funds" });
    const { subject } = proxy({ ...ENFORCE, price: "$0.01", payment });
    const response = await subject(
      request("/blog/hello", { "user-agent": GPTBOT, "payment-signature": "signed" }),
    );

    expect(response?.status).toBe(402);
    expect(((await response!.json()) as { reason: string }).reason).toBe("insufficient_funds");
  });

  it("fails open when the facilitator is unavailable", async () => {
    const payment = fakeGateway({ status: "unavailable", error: new Error("down") });
    const { subject, store } = proxy({ ...ENFORCE, price: "$0.01", payment, onError: vi.fn() });
    const response = await subject(
      request("/blog/hello", { "user-agent": GPTBOT, "payment-signature": "signed" }),
    );

    expect(continues(response)).toBe(true);
    expect(response?.headers.get("crawler-charged") ?? null).toBeNull();
    expect(store.events[0]?.reason).toBe("fail-open");
  });

  it("honours a session issued for this agent", async () => {
    const { subject, store } = proxy({ ...ENFORCE, price: "$0.01" });
    const token = await issueSessionToken("gptbot", { secret: ENFORCE.session.secret, ttlSeconds: 600 });
    const response = await subject(
      request("/blog/hello", { "user-agent": GPTBOT, "crawlmeter-session": token }),
    );

    expect(continues(response)).toBe(true);
    expect(store.events[0]?.reason).toBe("valid-session");
  });
});

describe("fail-open", () => {
  it("lets the request through when detection throws", async () => {
    const onError = vi.fn();
    const { subject, store } = proxy({
      price: "$0.01",
      detector: () => Promise.reject(new Error("dns exploded")),
      onError,
    });

    const response = await subject(request("/blog/hello", { "user-agent": GPTBOT }));

    expect(continues(response)).toBe(true);
    expect(store.events[0]?.reason).toBe("fail-open");
    expect(onError).toHaveBeenCalled();
  });

  it("lets the request through when the store throws", async () => {
    const onError = vi.fn();
    const subject = crawlmeter({
      price: "$0.01",
      detector: () => Promise.resolve(identified()),
      onWarning: () => {},
      onError,
      store: {
        record() {
          throw new Error("disk full");
        },
        summary: () => Promise.reject(new Error("disk full")),
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
    });

    const response = await subject(request("/blog/hello", { "user-agent": GPTBOT }));
    expect(continues(response)).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it("refuses a broken config at startup, not at request time", () => {
    expect(() => crawlmeter({ price: "not a price" })).toThrow();
  });
});

describe("the default detector, with a real NextRequest", () => {
  it("identifies from the real headers object", async () => {
    // No injected detector: the real UA layer reads the real Fetch headers.
    // Range fetching and DNS are switched off so nothing leaves the machine.
    const store = createMemoryStore();
    const { createDetector } = await import("../../src/detect/index.js");
    const subject = crawlmeter({
      price: "$0.01",
      store,
      detector: createDetector({ ipRanges: null, resolver: null }),
      onWarning: () => {},
    });

    await subject(request("/blog/hello", { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" }));

    expect(store.events[0]?.agent).toBe("claudebot");
    expect(store.events[0]?.confidence).toBe("ua-only");
  });
});

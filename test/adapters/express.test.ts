import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  crawlmeter,
  PROXY_WARNING,
  urlOf,
  type CrawlmeterOptions,
} from "../../src/adapters/express.js";
import type { Detector } from "../../src/detect/index.js";
import { issueSessionToken } from "../../src/session.js";
import { createMemoryStore, type MemoryStore } from "../../src/store/memory.js";
import { LEGACY_HEADERS } from "../../src/headers.js";
import {
  PaymentUnavailableError,
  createPaymentGateway,
  type PaymentGateway,
  type SettleOutcome,
} from "../../src/payment/gateway.js";
import { PaymentLibraryMissingError } from "../../src/payment/x402.js";
import { verifySessionToken } from "../../src/session.js";
import type { Identification, Money } from "../../src/types.js";

/**
 * Integration tests against a real Express app on a real socket.
 *
 * Detection is injected — the point here is the middleware's behaviour, not the
 * catalog's, and no test may touch DNS or the network.
 */

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const GPTBOT = "GPTBot/1.4";

const ENFORCE = {
  mode: "enforce" as const,
  payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
  network: "eip155:8453",
  facilitator: "https://x402.org/facilitator",
  session: { secret: "test-secret" },
};

function identified(confidence: Identification["confidence"] = "ip-range"): Identification {
  return {
    agent: "gptbot",
    operator: "openai",
    confidence,
    evidence: ["ua:gptbot", "ip:20.171.0.0/16"],
  };
}

/**
 * A payment gateway with no network behind it.
 *
 * The real one talks to x402 and a facilitator; here the point is what the
 * middleware does with each answer, so the answers are scripted.
 */
function fakeGateway(
  settle: SettleOutcome = { status: "settled", paymentResponse: "receipt-123", transaction: "0xabc" },
  overrides: Partial<PaymentGateway> = {},
) {
  return {
    ready: vi.fn(() => Promise.resolve()),
    challenge: vi.fn((price: Money) => Promise.resolve(`challenge-for-${price.micros}`)),
    settle: vi.fn((_signature: string, _price: Money) => Promise.resolve(settle)),
    ...overrides,
  };
}

/** A detector that always returns the same identification, without any I/O. */
function fixedDetector(identification: Identification): Detector {
  return () => Promise.resolve(identification);
}

interface Harness {
  readonly url: string;
  readonly store: MemoryStore;
  close(): Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  options: CrawlmeterOptions = {},
  mount: (app: express.Express) => void = defaultRoutes,
): Promise<Harness> {
  const store = createMemoryStore();
  const app = express();
  app.use(
    crawlmeter({
      detector: fixedDetector(identified()),
      store,
      // Enforce mode builds a real gateway unless one is given, and a real one
      // would call a real facilitator. No test may do that.
      ...(options.mode === "enforce" && options.payment === undefined
        ? { payment: fakeGateway() }
        : {}),
      ...options,
    }),
  );
  mount(app);

  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function defaultRoutes(app: express.Express): void {
  app.get("/robots.txt", (_request, response) => {
    response.type("text/plain").send("User-agent: *\nAllow: /\n");
  });
  app.get("/blog/hello", (_request, response) => {
    response.type("text/plain").send("hello from the blog");
  });
  app.get("/blog/streamed", (_request, response) => {
    // No content-length: this is the case a header-based byte count would
    // report as zero.
    response.type("text/plain");
    response.write("part one ");
    response.write("part two");
    response.end();
  });
  app.get("/", (_request, response) => {
    response.type("text/plain").send("home");
  });
}

/** Wait for the response to be fully recorded. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/* -------------------------------------------------------------------------- */

describe("the fast path", () => {
  it("serves a browser request untouched", async () => {
    const harness = await serve();
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": CHROME },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");
  });

  it("does not identify, record or delay a browser request", async () => {
    // Almost all traffic takes this path. Anything done here is paid by every
    // visitor of every site that installs crawlmeter.
    const detector = vi.fn(fixedDetector(identified()));
    const harness = await serve({ detector });

    await fetch(`${harness.url}/blog/hello`, { headers: { "user-agent": CHROME } });
    await settle();

    expect(detector).not.toHaveBeenCalled();
    expect(harness.store.events).toHaveLength(0);
  });
});

describe("observe mode", () => {
  it("serves the content and books the potential revenue", async () => {
    const harness = await serve({ price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });
    await settle();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");

    const [event] = harness.store.events;
    expect(event?.agent).toBe("gptbot");
    expect(event?.reason).toBe("observe-mode");
    expect(event?.potentialMicros).toBe(10_000);
  });

  it("never sends a price header when nothing is being charged", async () => {
    const harness = await serve({ price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });

    expect(response.headers.get("crawler-price")).toBeNull();
  });

  it("counts the bytes of a response that has no content-length", async () => {
    const harness = await serve({ price: "$0.01" });
    await fetch(`${harness.url}/blog/streamed`, { headers: { "user-agent": GPTBOT } });
    await settle();

    expect(harness.store.events[0]?.bytes).toBe("part one part two".length);
  });

  it("passes robots.txt free and says why", async () => {
    // A toll on the file that declares your crawling policy is self-defeating.
    const harness = await serve({ price: "$0.01" });
    const response = await fetch(`${harness.url}/robots.txt`, {
      headers: { "user-agent": GPTBOT },
    });
    await settle();

    expect(response.status).toBe(200);
    expect(harness.store.events[0]?.reason).toBe("free-path");
    expect(harness.store.events[0]?.potentialMicros).toBeNull();
  });

  it("books nothing for an identification too weak to bill", async () => {
    const harness = await serve({
      price: "$0.01",
      detector: fixedDetector(identified("ua-only")),
    });
    await fetch(`${harness.url}/blog/hello`, { headers: { "user-agent": GPTBOT } });
    await settle();

    expect(harness.store.events[0]?.reason).toBe("below-min-confidence");
    expect(harness.store.events[0]?.potentialMicros).toBeNull();
  });
});

describe("enforce mode", () => {
  it("answers 402 with the price on the response", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });

    expect(response.status).toBe(402);
    // Not optional: a 402 with no price is a closed door with no price tag.
    expect(response.headers.get("crawler-price")).toBe("USD 0.01");

    const body = (await response.json()) as { price: { amount: string; decimals: number } };
    expect(body.price.amount).toBe("10000");
    expect(body.price.decimals).toBe(6);
  });

  it("records the 402 as require-payment", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    await fetch(`${harness.url}/blog/hello`, { headers: { "user-agent": GPTBOT } });
    await settle();

    expect(harness.store.events[0]?.action).toBe("require-payment");
    expect(harness.store.events[0]?.potentialMicros).toBe(10_000);
  });

  it("carries the x402 challenge from the gateway", async () => {
    const payment = fakeGateway();
    const harness = await serve({ ...ENFORCE, price: "$0.01", payment });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });

    expect(response.headers.get("payment-required")).toBe("challenge-for-10000");
    // The challenge names the resource being paid for. (fetch will not let a
    // test set Host, so the host here is the real socket's; urlOf has its own
    // unit tests for the header cases.)
    expect(payment.challenge).toHaveBeenCalledWith(
      expect.objectContaining({ micros: 10_000 }),
      { url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/blog\/hello$/) },
    );
  });

  it("never emits x402 v1 headers", async () => {
    // One wire format, documented. Nobody should have to guess which version a
    // crawlmeter site speaks.
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });

    for (const name of LEGACY_HEADERS) {
      expect(response.headers.get(name), name).toBeNull();
    }
  });

  it("serves a request whose session is still valid", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const token = await issueSessionToken("gptbot", {
      secret: ENFORCE.session.secret,
      ttlSeconds: 600,
    });

    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "crawlmeter-session": token },
    });
    await settle();

    expect(response.status).toBe(200);
    expect(harness.store.events[0]?.reason).toBe("valid-session");
  });

  it("refuses a session issued to a different agent", async () => {
    // A receipt is not bearer currency: ClaudeBot cannot spend GPTBot's.
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const token = await issueSessionToken("claudebot", {
      secret: ENFORCE.session.secret,
      ttlSeconds: 600,
    });

    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "crawlmeter-session": token },
    });

    expect(response.status).toBe(402);
  });

  it("refuses a forged session", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "crawlmeter-session": "cm1.forged.signature" },
    });

    expect(response.status).toBe(402);
  });
});

describe("declared budgets are not payments", () => {
  it("does not open the gate for crawler-max-price", async () => {
    // Cloudflare can serve on this header because their network is merchant of
    // record. crawlmeter holds no such position.
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "crawler-max-price": "USD 1.00" },
    });

    expect(response.status).toBe(402);
  });

  it("does not open the gate for crawler-exact-price", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "crawler-exact-price": "USD 0.01" },
    });

    expect(response.status).toBe(402);
  });

  it("ignores a malformed budget instead of failing the request", async () => {
    const harness = await serve({ price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "crawler-max-price": "a bag of marbles" },
    });

    expect(response.status).toBe(200);
  });
});

describe("routing", () => {
  it("prices by path and ignores the query string", async () => {
    // Otherwise a crawler dodges a rule by appending a parameter, and every
    // distinct query shows up as its own route in the report.
    const harness = await serve({
      routes: { "/blog/*": "$0.05" },
      price: "$0.01",
    });
    await fetch(`${harness.url}/blog/hello?utm_source=x&page=2`, {
      headers: { "user-agent": GPTBOT },
    });
    await settle();

    expect(harness.store.events[0]?.route).toBe("/blog/*");
    expect(harness.store.events[0]?.path).toBe("/blog/hello");
    expect(harness.store.events[0]?.potentialMicros).toBe(50_000);
  });
});

describe("fail-open", () => {
  it("serves the content when detection throws", async () => {
    const harness = await serve({
      price: "$0.01",
      detector: () => Promise.reject(new Error("dns exploded")),
      onError: vi.fn(),
    });

    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");
  });

  it("serves the content in enforce mode when detection throws", async () => {
    // The dangerous case: a broken dependency must not start handing out 402s
    // to everybody, and must not withhold content either.
    const harness = await serve({
      ...ENFORCE,
      price: "$0.01",
      detector: () => Promise.reject(new Error("dns exploded")),
      onError: vi.fn(),
    });

    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });

    expect(response.status).toBe(200);
  });

  it("records the failure as fail-open and reports it", async () => {
    const onError = vi.fn();
    const harness = await serve({
      price: "$0.01",
      detector: () => Promise.reject(new Error("dns exploded")),
      onError,
    });

    await fetch(`${harness.url}/blog/hello`, { headers: { "user-agent": GPTBOT } });
    await settle();

    expect(harness.store.events[0]?.reason).toBe("fail-open");
    expect(harness.store.events[0]?.potentialMicros).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("serves the content when the store throws", async () => {
    const onError = vi.fn();
    const broken = {
      record(): void {
        throw new Error("disk full");
      },
      summary: () => Promise.reject(new Error("disk full")),
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const harness = await serve({ price: "$0.01", store: broken, onError });
    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT },
    });
    await settle();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");
    expect(onError).toHaveBeenCalled();
  });
});

describe("payments", () => {
  const PAID = { "user-agent": GPTBOT, "payment-signature": "signed-payment-abc" };

  it("serves a settled payment and says what was charged", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, { headers: PAID });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");
    // Decision 3: crawler-charged on the 200. It is only true because
    // settlement happened before the headers went out.
    expect(response.headers.get("crawler-charged")).toBe("USD 0.01");
    expect(response.headers.get("payment-response")).toBe("receipt-123");
  });

  it("hands the gateway the payment exactly as sent, with the price evaluate chose", async () => {
    const payment = fakeGateway();
    const harness = await serve({ ...ENFORCE, routes: { "/blog/*": "$0.05" }, payment });
    await fetch(`${harness.url}/blog/hello`, { headers: PAID });

    expect(payment.settle).toHaveBeenCalledWith(
      "signed-payment-abc",
      expect.objectContaining({ micros: 50_000 }),
    );
  });

  it("issues a session with a settled payment, bound to the paying agent", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    const response = await fetch(`${harness.url}/blog/hello`, { headers: PAID });

    const token = response.headers.get("crawlmeter-session");
    const session = await verifySessionToken(token, { secret: ENFORCE.session.secret });
    expect(session?.agent).toBe("gptbot");
  });

  it("lets the next asset through on that session without charging again", async () => {
    // Paying for a page must not mean paying again for its stylesheet.
    const payment = fakeGateway();
    const harness = await serve({ ...ENFORCE, price: "$0.01", payment });
    const first = await fetch(`${harness.url}/blog/hello`, { headers: PAID });
    const token = first.headers.get("crawlmeter-session")!;

    const second = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "crawlmeter-session": token },
    });
    await settle();

    expect(second.status).toBe(200);
    expect(payment.settle).toHaveBeenCalledTimes(1);
    expect(harness.store.events.map((event) => event.reason)).toEqual([null, "valid-session"]);
  });

  it("records a settled payment as charged, at the price charged", async () => {
    const harness = await serve({ ...ENFORCE, price: "$0.01" });
    await fetch(`${harness.url}/blog/hello`, { headers: PAID });
    await settle();

    expect(harness.store.events[0]?.action).toBe("accept-payment");
    expect(harness.store.events[0]?.priceMicros).toBe(10_000);
  });

  it("answers a rejected payment with the price again, never the content", async () => {
    const payment = fakeGateway({ status: "rejected", reason: "insufficient_funds" });
    const harness = await serve({ ...ENFORCE, price: "$0.01", payment });
    const response = await fetch(`${harness.url}/blog/hello`, { headers: PAID });
    await settle();

    expect(response.status).toBe(402);
    expect(response.headers.get("crawler-price")).toBe("USD 0.01");
    expect(response.headers.get("payment-required")).toBe("challenge-for-10000");
    expect(response.headers.get("crawler-charged")).toBeNull();

    const body = (await response.json()) as { error: string; reason: string };
    expect(body.error).toBe("payment rejected");
    expect(body.reason).toBe("insufficient_funds");
    expect(harness.store.events[0]?.action).toBe("require-payment");
  });

  it("fails open when the facilitator cannot be reached, and charges nothing", async () => {
    // Decision 7. A billing dependency having a bad day serves the content.
    const onError = vi.fn();
    const outage = new Error("facilitator timed out");
    const payment = fakeGateway({ status: "unavailable", error: outage });
    const harness = await serve({ ...ENFORCE, price: "$0.01", payment, onError });

    const response = await fetch(`${harness.url}/blog/hello`, { headers: PAID });
    await settle();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");
    expect(response.headers.get("crawler-charged")).toBeNull();
    expect(response.headers.get("crawlmeter-session")).toBeNull();
    expect(harness.store.events[0]?.reason).toBe("fail-open");
    expect(onError).toHaveBeenCalledWith(outage);
  });

  it("fails open when no challenge can be built", async () => {
    // A 402 without payment-required is a door nobody can open. The only
    // honest answers are "pay" or "come in".
    const onError = vi.fn();
    const payment = fakeGateway(undefined, {
      challenge: vi.fn(() => Promise.reject(new PaymentUnavailableError("facilitator down"))),
    });
    const harness = await serve({ ...ENFORCE, price: "$0.01", payment, onError });

    const response = await fetch(`${harness.url}/blog/hello`, { headers: { "user-agent": GPTBOT } });
    await settle();

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-required")).toBeNull();
    expect(harness.store.events[0]?.reason).toBe("fail-open");
    expect(onError).toHaveBeenCalled();
  });

  it("never reaches the gateway in observe mode, even with a payment attached", async () => {
    // Observe is a dry run. Nothing is charged, whatever the crawler sends.
    const payment = fakeGateway();
    const harness = await serve({ price: "$0.01", payment });

    const response = await fetch(`${harness.url}/blog/hello`, { headers: PAID });

    expect(response.status).toBe(200);
    expect(payment.settle).not.toHaveBeenCalled();
    expect(payment.challenge).not.toHaveBeenCalled();
    expect(payment.ready).not.toHaveBeenCalled();
  });
});

describe("readiness", () => {
  it("is ready at once in observe mode", async () => {
    await expect(crawlmeter({ price: "$0.01" }).ready).resolves.toBeUndefined();
  });

  it("names the install command when enforce mode cannot load x402", async () => {
    // Built the way a user without x402 would get it: a real gateway whose
    // loader cannot find the package.
    const onWarning = vi.fn();
    const payment = createPaymentGateway({
      payTo: ENFORCE.payTo,
      network: ENFORCE.network,
      facilitator: ENFORCE.facilitator,
      loader: () =>
        Promise.reject(
          new PaymentLibraryMissingError(
            "crawlmeter: enforce mode needs the x402 packages, which are not installed. Install them with `npm i @x402/core @x402/evm`.",
          ),
        ),
    });

    const meter = crawlmeter({ ...ENFORCE, price: "$0.01", payment, onWarning });

    await expect(meter.ready).rejects.toThrow("npm i @x402/core @x402/evm");
    // Said out loud without anyone awaiting it, because otherwise enforce mode
    // with no x402 quietly serves everything free and looks exactly like observe.
    await settle();
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("npm i @x402/core @x402/evm"));
  });

  it("still serves every request when x402 is missing", async () => {
    const payment = createPaymentGateway({
      payTo: ENFORCE.payTo,
      network: ENFORCE.network,
      facilitator: ENFORCE.facilitator,
      loader: () => Promise.reject(new PaymentLibraryMissingError("not installed")),
    });
    const harness = await serve({
      ...ENFORCE,
      price: "$0.01",
      payment,
      onWarning: vi.fn(),
      onError: vi.fn(),
    });

    const response = await fetch(`${harness.url}/blog/hello`, { headers: { "user-agent": GPTBOT } });
    expect(response.status).toBe(200);
  });

  it("does not crash the process when nobody awaits a failed ready", async () => {
    // An unhandled rejection kills a Node process by default. A missing
    // optional dependency must not do that to somebody's site.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      crawlmeter({
        ...ENFORCE,
        price: "$0.01",
        onWarning: vi.fn(),
        payment: fakeGateway(undefined, {
          ready: () => Promise.reject(new Error("facilitator unreachable")),
        }),
      });
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("the proxy warning", () => {
  /**
   * The failure this guards against is silent, not loud.
   *
   * Behind a proxy the socket address is the proxy's, so no published CIDR ever
   * matches, every crawler stalls at ua-only, and the report shows zero. Nothing
   * throws. The operator reads the zero as "no AI crawler traffic worth
   * anything" — the opposite of what the product is for.
   */

  it("warns when requests carry x-forwarded-for and the header is not trusted", async () => {
    const onWarning = vi.fn();
    const harness = await serve({ price: "$0.01", onWarning });

    await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "x-forwarded-for": "132.196.86.5" },
    });
    await settle();

    expect(onWarning).toHaveBeenCalledWith(PROXY_WARNING);
  });

  it("names the option and the consequence, so the message is actionable", () => {
    expect(PROXY_WARNING).toContain("trustProxy: true");
    expect(PROXY_WARNING).toContain("potential revenue will stay at zero");
    // The two switches are independent, and that trips people up.
    expect(PROXY_WARNING).toContain("does not read Express's own");
  });

  it("warns once per middleware, not once per request", async () => {
    const onWarning = vi.fn();
    const harness = await serve({ price: "$0.01", onWarning });

    for (let i = 0; i < 5; i += 1) {
      await fetch(`${harness.url}/blog/hello`, {
        headers: { "user-agent": GPTBOT, "x-forwarded-for": "132.196.86.5" },
      });
    }
    await settle();

    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the header is trusted", async () => {
    const onWarning = vi.fn();
    const harness = await serve({ price: "$0.01", trustProxy: true, onWarning });

    await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "x-forwarded-for": "132.196.86.5" },
    });
    await settle();

    expect(onWarning).not.toHaveBeenCalled();
  });

  it("stays quiet when there is no proxy header", async () => {
    const onWarning = vi.fn();
    const harness = await serve({ price: "$0.01", onWarning });

    await fetch(`${harness.url}/blog/hello`, { headers: { "user-agent": GPTBOT } });
    await settle();

    expect(onWarning).not.toHaveBeenCalled();
  });

  it("stays quiet for ordinary visitors behind the same proxy", async () => {
    // Otherwise every site behind a load balancer warns on its first pageview.
    const onWarning = vi.fn();
    const harness = await serve({ price: "$0.01", onWarning });

    await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": CHROME, "x-forwarded-for": "203.0.113.9" },
    });
    await settle();

    expect(onWarning).not.toHaveBeenCalled();
  });

  it("prints by default, because a silenced warning is the bug", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = await serve({ price: "$0.01" });
      await fetch(`${harness.url}/blog/hello`, {
        headers: { "user-agent": GPTBOT, "x-forwarded-for": "132.196.86.5" },
      });
      await settle();

      expect(warn).toHaveBeenCalledWith(PROXY_WARNING);
    } finally {
      warn.mockRestore();
    }
  });

  it("serves the request normally even if the warning handler throws", async () => {
    const onError = vi.fn();
    const harness = await serve({
      price: "$0.01",
      onWarning: () => {
        throw new Error("logger is on fire");
      },
      onError,
    });

    const response = await fetch(`${harness.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "x-forwarded-for": "132.196.86.5" },
    });

    expect(response.status).toBe(200);
    expect(onError).toHaveBeenCalled();
  });

  it("reaches ip-range once the header is trusted", async () => {
    // The whole point of the warning: this is the difference between a report
    // that says zero and one that says what the traffic is worth.
    const seen: Array<string | null | undefined> = [];
    const detector: Detector = (input) => {
      seen.push(input.ip);
      return Promise.resolve(
        input.ip === "132.196.86.5" ? identified("ip-range") : identified("ua-only"),
      );
    };

    const withoutTrust = await serve({ price: "$0.01", detector, onWarning: vi.fn() });
    await fetch(`${withoutTrust.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "x-forwarded-for": "132.196.86.5" },
    });
    await settle();

    const withTrust = await serve({ price: "$0.01", detector, trustProxy: true });
    await fetch(`${withTrust.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "x-forwarded-for": "132.196.86.5" },
    });
    await settle();

    expect(withoutTrust.store.events[0]?.reason).toBe("below-min-confidence");
    expect(withoutTrust.store.events[0]?.potentialMicros).toBeNull();

    expect(withTrust.store.events[0]?.reason).toBe("observe-mode");
    expect(withTrust.store.events[0]?.potentialMicros).toBe(10_000);
  });
});

describe("configuration", () => {
  it("refuses to start with a broken config instead of failing at request time", () => {
    // Discovering the price is unparseable while a crawler waits is too late.
    expect(() => crawlmeter({ price: "not a price" })).toThrow();
  });

  it("exposes the store so the report can read it", async () => {
    const store = createMemoryStore();
    const middleware = crawlmeter({ store });
    expect(middleware.store).toBe(store);
    expect(middleware.config.mode).toBe("observe");
  });
});

describe("urlOf", () => {
  it("builds the resource url from the host header and path", () => {
    expect(
      urlOf({ headers: { host: "example.com" }, url: "/blog/hello?x=1", protocol: "https" }, false),
    ).toBe("https://example.com/blog/hello");
  });

  it("ignores x-forwarded-proto unless the proxy is trusted", () => {
    // Same rule as the address: a header anyone can set counts only when a
    // proxy you control wrote it.
    const request = {
      headers: { host: "example.com", "x-forwarded-proto": "https" },
      url: "/a",
      protocol: "http",
    };
    expect(urlOf(request, false)).toBe("http://example.com/a");
    expect(urlOf(request, true)).toBe("https://example.com/a");
  });

  it("falls back to something usable when headers are missing", () => {
    expect(urlOf({ headers: {}, url: "/a" }, false)).toBe("http://localhost/a");
  });
});

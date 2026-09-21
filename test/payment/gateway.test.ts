import { describe, expect, it, vi } from "vitest";

import {
  PaymentUnavailableError,
  createPaymentGateway,
  type PaymentGatewayOptions,
} from "../../src/payment/gateway.js";
import { PaymentLibraryMissingError, type X402, type X402ResourceServer } from "../../src/payment/x402.js";
import { money } from "../../src/types.js";

/**
 * The gateway's job is one classification: settled, rejected or unavailable.
 *
 * "Rejected" answers 402 again. "Unavailable" fails open and serves the page
 * free. So the line between them is the security boundary of enforce mode —
 * if anything the crawler controls can land on the "unavailable" side, then
 * fail-open is not a safety net any more, it is a way to read paid content for
 * the price of a malformed header. Every branch is pinned here.
 */

const PRICE = money(10_000);
const REQUIREMENT = { scheme: "exact", amount: "10000" };
const PAYLOAD = { accepted: REQUIREMENT };

/** Stand-in for an x402 error that carries the facilitator's verdict. */
class VerdictError extends Error {
  constructor(readonly invalidReason: string) {
    super(invalidReason);
  }
}

interface Script {
  initialize?: () => Promise<void>;
  build?: () => Promise<unknown[]>;
  decode?: (header: string) => unknown;
  match?: () => unknown;
  verify?: () => Promise<{ isValid: boolean; invalidReason?: string }>;
  settle?: () => Promise<{ success: boolean; errorReason?: string; transaction: string; network: string }>;
  encodeReceipt?: () => string;
  /** The payment-free health check. Resolves (facilitator up) unless scripted. */
  probe?: () => Promise<void>;
}

/** A scripted x402: every call succeeds unless the script says otherwise. */
function fakeX402(script: Script = {}) {
  const server = {
    initialize: vi.fn(script.initialize ?? (() => Promise.resolve())),
    buildPaymentRequirements: vi.fn(script.build ?? (() => Promise.resolve([REQUIREMENT]))),
    createPaymentRequiredResponse: vi.fn(() => Promise.resolve({ x402Version: 2 })),
    findMatchingRequirements: vi.fn(script.match ?? (() => REQUIREMENT)),
    verifyPayment: vi.fn(script.verify ?? (() => Promise.resolve({ isValid: true }))),
    settlePayment: vi.fn(
      script.settle ??
        (() => Promise.resolve({ success: true, transaction: "0xabc", network: "eip155:8453" })),
    ),
  };
  const probe = vi.fn(script.probe ?? (() => Promise.resolve()));
  const x402 = {
    server,
    probe,
    createResourceServer: vi.fn(() => server as unknown as X402ResourceServer),
    createProbe: vi.fn(() => probe),
    encodePaymentRequiredHeader: vi.fn(() => "encoded-challenge"),
    decodePaymentSignatureHeader: vi.fn(script.decode ?? (() => PAYLOAD)),
    encodePaymentResponseHeader: vi.fn(script.encodeReceipt ?? (() => "encoded-receipt")),
    isVerdict: (error: unknown) => error instanceof VerdictError,
  };
  return x402;
}

function gateway(x402: ReturnType<typeof fakeX402>, overrides: Partial<PaymentGatewayOptions> = {}) {
  return createPaymentGateway({
    payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    network: "eip155:8453",
    facilitator: "https://facilitator.example",
    loader: () => Promise.resolve(x402 as unknown as X402),
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */

describe("challenge", () => {
  it("asks x402 for the requirements at crawlmeter's price, as an exact decimal", async () => {
    const x402 = fakeX402();
    const header = await gateway(x402).challenge(PRICE, { url: "https://example.com/a" });

    expect(header).toBe("encoded-challenge");
    expect(x402.server.buildPaymentRequirements).toHaveBeenCalledWith({
      scheme: "exact",
      payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      price: "0.010000",
      network: "eip155:8453",
    });
    expect(x402.server.createPaymentRequiredResponse).toHaveBeenCalledWith([REQUIREMENT], {
      url: "https://example.com/a",
    });
  });

  it("reports an unreachable facilitator as unavailable", async () => {
    const x402 = fakeX402({ initialize: () => Promise.reject(new Error("ECONNREFUSED")) });
    await expect(gateway(x402).challenge(PRICE, { url: "https://example.com/a" })).rejects.toBeInstanceOf(
      PaymentUnavailableError,
    );
  });
});

describe("settle: a good payment", () => {
  it("settles and returns the receipt", async () => {
    const x402 = fakeX402();
    const outcome = await gateway(x402).settle("signed", PRICE);

    expect(outcome).toEqual({
      status: "settled",
      paymentResponse: "encoded-receipt",
      transaction: "0xabc",
    });
  });

  it("verifies before it settles", async () => {
    const x402 = fakeX402();
    await gateway(x402).settle("signed", PRICE);

    const verifyOrder = x402.server.verifyPayment.mock.invocationCallOrder[0]!;
    const settleOrder = x402.server.settlePayment.mock.invocationCallOrder[0]!;
    expect(verifyOrder).toBeLessThan(settleOrder);
  });

  it("stays settled when the receipt cannot be encoded, because money has moved", async () => {
    const x402 = fakeX402({
      encodeReceipt: () => {
        throw new Error("encoder broke");
      },
    });
    const outcome = await gateway(x402).settle("signed", PRICE);

    expect(outcome).toEqual({ status: "settled", paymentResponse: null, transaction: "0xabc" });
  });
});

describe("settle: things the crawler controls are always rejected", () => {
  it("rejects a header that will not decode, without calling the facilitator", async () => {
    const x402 = fakeX402({
      decode: () => {
        throw new Error("not base64");
      },
    });
    const outcome = await gateway(x402).settle("!!garbage!!", PRICE);

    expect(outcome.status).toBe("rejected");
    expect(x402.server.verifyPayment).not.toHaveBeenCalled();
    expect(x402.server.settlePayment).not.toHaveBeenCalled();
  });

  it("rejects a payment for a different price before the facilitator is asked", async () => {
    // $0.001 offered for a $0.01 page.
    const x402 = fakeX402({ match: () => undefined });
    const outcome = await gateway(x402).settle("underpaid", PRICE);

    expect(outcome).toEqual({
      status: "rejected",
      reason: "payment does not match the price of this resource",
    });
    expect(x402.server.verifyPayment).not.toHaveBeenCalled();
  });

  it("rejects a payload x402 cannot even compare", async () => {
    const x402 = fakeX402({
      match: () => {
        throw new TypeError("cannot read properties of undefined");
      },
    });
    const outcome = await gateway(x402).settle("weird-shape", PRICE);

    expect(outcome.status).toBe("rejected");
  });

  it("can never produce 'unavailable' from the header alone", async () => {
    // The property the whole boundary rests on. With a healthy dependency, no
    // header value — however hostile — may open the fail-open path.
    const hostile = [
      "",
      "null",
      "{}",
      "a".repeat(100_000),
      "eyJ4NDAyVmVyc2lvbiI6OTl9", // base64 of {"x402Version":99}
      "\u0000\u0001\u0002",
      "undefined",
      "[]",
    ];
    for (const header of hostile) {
      const x402 = fakeX402({
        decode: (value) => {
          if (value.length > 50_000) throw new RangeError("too long");
          return JSON.parse(value === "" ? "x" : value);
        },
        match: () => {
          throw new TypeError("bad payload");
        },
      });
      const outcome = await gateway(x402).settle(header, PRICE);
      expect(outcome.status, JSON.stringify(header.slice(0, 20))).toBe("rejected");
    }
  });
});

describe("settle: the facilitator's verdict is a rejection", () => {
  it("rejects when verify says invalid", async () => {
    const x402 = fakeX402({
      verify: () => Promise.resolve({ isValid: false, invalidReason: "invalid_signature" }),
    });
    expect(await gateway(x402).settle("signed", PRICE)).toEqual({
      status: "rejected",
      reason: "invalid_signature",
    });
    expect(x402.server.settlePayment).not.toHaveBeenCalled();
  });

  it("rejects when verify throws a verdict", async () => {
    const x402 = fakeX402({ verify: () => Promise.reject(new VerdictError("expired")) });
    expect(await gateway(x402).settle("signed", PRICE)).toEqual({
      status: "rejected",
      reason: "expired",
    });
  });

  it("rejects when settlement is refused", async () => {
    // A replayed payment lands here: the nonce is already spent.
    const x402 = fakeX402({
      settle: () =>
        Promise.resolve({
          success: false,
          errorReason: "nonce_already_used",
          transaction: "",
          network: "eip155:8453",
        }),
    });
    expect(await gateway(x402).settle("signed", PRICE)).toEqual({
      status: "rejected",
      reason: "nonce_already_used",
    });
  });

  it("rejects when settle throws a verdict", async () => {
    const x402 = fakeX402({ settle: () => Promise.reject(new VerdictError("insufficient_funds")) });
    expect(await gateway(x402).settle("signed", PRICE)).toEqual({
      status: "rejected",
      reason: "insufficient_funds",
    });
  });
});

describe("settle: a failing dependency is unavailable", () => {
  it("when x402 is not installed", async () => {
    const outcome = await gateway(fakeX402(), {
      loader: () => Promise.reject(new PaymentLibraryMissingError("not installed")),
    }).settle("signed", PRICE);
    expect(outcome.status).toBe("unavailable");
  });

  it("when the facilitator cannot be reached at startup", async () => {
    const x402 = fakeX402({ initialize: () => Promise.reject(new TypeError("fetch failed")) });
    expect((await gateway(x402).settle("signed", PRICE)).status).toBe("unavailable");
  });

  it("when requirements cannot be built", async () => {
    const x402 = fakeX402({ build: () => Promise.reject(new Error("no supported kind")) });
    expect((await gateway(x402).settle("signed", PRICE)).status).toBe("unavailable");
  });

  it("when verify times out and the facilitator does not answer a health check either", async () => {
    const x402 = fakeX402({
      verify: () => Promise.reject(new Error("verify timed out after 5000ms")),
      probe: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect((await gateway(x402).settle("signed", PRICE)).status).toBe("unavailable");
  });

  it("when settle fails with no verdict, without probing, because money may have moved", async () => {
    // e.g. the facilitator's load balancer answering 502 with an HTML page.
    // The facilitator already called this payment valid. If settle failed
    // with the answer lost in transit, the transfer may have gone through, and
    // a 402 would take a genuine crawler's money and withhold the page.
    const x402 = fakeX402({
      settle: () => Promise.reject(new Error("Facilitator settle failed (502): <html>")),
    });
    expect((await gateway(x402).settle("signed", PRICE)).status).toBe("unavailable");
    expect(x402.probe).not.toHaveBeenCalled();
  });
});

describe("telling an outage from a payment built to break the facilitator", () => {
  const CRASH = () => Promise.reject(new Error("Facilitator verify failed (500): Internal Server Error"));

  it("rejects when verify fails but the facilitator answers a payment-free probe", async () => {
    // The facilitator is up. Whatever went wrong went wrong with THIS payment,
    // and nothing has been charged yet, so a 402 costs a genuine crawler
    // nothing but a retry.
    const x402 = fakeX402({ verify: CRASH });
    const outcome = await gateway(x402).settle("signed", PRICE);

    expect(outcome).toEqual({
      status: "rejected",
      reason: "the facilitator could not process this payment",
    });
    expect(x402.probe).toHaveBeenCalledTimes(1);
  });

  it("cannot be tripped into failing open by repeating a crafted payment", async () => {
    // The attack a failure counter would allow: send the same facilitator-
    // crashing payment a few times, trip the breaker, and read everything free
    // for the back-off window. The probe carries no payment, so the attacker
    // cannot make it fail.
    const x402 = fakeX402({ verify: CRASH });
    const subject = gateway(x402);

    for (let i = 0; i < 10; i += 1) {
      expect((await subject.settle(`crafted-${i}`, PRICE)).status).toBe("rejected");
    }
    // Never marked down: every attempt still went to the facilitator.
    expect(x402.server.verifyPayment).toHaveBeenCalledTimes(10);

    // And an honest payment right after goes straight through.
    x402.server.verifyPayment.mockImplementation(() => Promise.resolve({ isValid: true }));
    expect((await subject.settle("honest", PRICE)).status).toBe("settled");
  });

  it("fails open only when the probe fails too", async () => {
    const x402 = fakeX402({ verify: CRASH, probe: () => Promise.reject(new TypeError("fetch failed")) });
    expect((await gateway(x402).settle("signed", PRICE)).status).toBe("unavailable");
  });

  it("skips the round trip while the facilitator is known to be down", async () => {
    // Otherwise every crawler hit during an outage waits out a full timeout
    // before being served.
    let now = 1_000;
    const x402 = fakeX402({ verify: CRASH, probe: () => Promise.reject(new Error("down")) });
    const subject = gateway(x402, { retryAfterMs: 30_000, now: () => now });

    await subject.settle("a", PRICE);
    now += 5_000;
    const second = await subject.settle("b", PRICE);

    expect(second.status).toBe("unavailable");
    expect(x402.server.verifyPayment).toHaveBeenCalledTimes(1);
  });

  it("still rejects junk while the facilitator is down", async () => {
    // The outage short-cut sits after the crawler-controlled checks, so an
    // outage is never a window in which malformed payments are waved through.
    let now = 1_000;
    let decodable = true;
    const x402 = fakeX402({
      verify: CRASH,
      probe: () => Promise.reject(new Error("down")),
      decode: () => {
        if (!decodable) throw new Error("not base64");
        return PAYLOAD;
      },
    });
    const subject = gateway(x402, { now: () => now });

    expect((await subject.settle("a", PRICE)).status).toBe("unavailable");
    decodable = false;
    now += 1_000;
    expect((await subject.settle("!!junk!!", PRICE)).status).toBe("rejected");
  });

  it("still rejects an underpayment while the facilitator is down", async () => {
    let now = 1_000;
    let matches = true;
    const x402 = fakeX402({
      verify: CRASH,
      probe: () => Promise.reject(new Error("down")),
      match: () => (matches ? REQUIREMENT : undefined),
    });
    const subject = gateway(x402, { now: () => now });

    await subject.settle("a", PRICE);
    matches = false;
    now += 1_000;
    expect((await subject.settle("underpaid", PRICE)).status).toBe("rejected");
  });

  it("tries the facilitator again once the back-off has passed", async () => {
    let now = 1_000;
    let down = true;
    const x402 = fakeX402({
      verify: () => (down ? CRASH() : Promise.resolve({ isValid: true })),
      probe: () => (down ? Promise.reject(new Error("down")) : Promise.resolve()),
    });
    const subject = gateway(x402, { retryAfterMs: 30_000, now: () => now });

    expect((await subject.settle("a", PRICE)).status).toBe("unavailable");
    down = false;
    now += 31_000;
    expect((await subject.settle("b", PRICE)).status).toBe("settled");
  });
});

describe("connection", () => {
  it("loads x402 and initializes once, however many requests arrive", async () => {
    const x402 = fakeX402();
    const loader = vi.fn(() => Promise.resolve(x402 as unknown as X402));
    const subject = gateway(x402, { loader });

    await Promise.all([
      subject.settle("a", PRICE),
      subject.settle("b", PRICE),
      subject.challenge(PRICE, { url: "https://example.com" }),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(x402.server.initialize).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failure instead of timing out on every request", async () => {
    // A facilitator that is down must not cost each crawler hit a full timeout.
    let now = 1_000;
    const loader = vi.fn(() => Promise.reject(new Error("facilitator down")));
    const subject = gateway(fakeX402(), { loader, retryAfterMs: 30_000, now: () => now });

    await subject.settle("a", PRICE);
    now += 10_000;
    await subject.settle("b", PRICE);
    expect(loader).toHaveBeenCalledTimes(1);

    now += 30_000;
    await subject.settle("c", PRICE);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("recovers once the facilitator comes back", async () => {
    let now = 1_000;
    let up = false;
    const x402 = fakeX402({
      initialize: () => (up ? Promise.resolve() : Promise.reject(new Error("down"))),
    });
    const subject = gateway(x402, { retryAfterMs: 1_000, now: () => now });

    expect((await subject.settle("a", PRICE)).status).toBe("unavailable");
    up = true;
    now += 2_000;
    expect((await subject.settle("b", PRICE)).status).toBe("settled");
  });
});

describe("ready", () => {
  it("resolves once x402 is loaded and the facilitator answers", async () => {
    await expect(gateway(fakeX402()).ready()).resolves.toBeUndefined();
  });

  it("rejects with the real cause, so it can fail a deploy", async () => {
    const subject = gateway(fakeX402(), {
      loader: () =>
        Promise.reject(new PaymentLibraryMissingError("Install them with `npm i @x402/core @x402/evm`")),
    });
    await expect(subject.ready()).rejects.toThrow("npm i @x402/core @x402/evm");
  });
});

describe("configuration", () => {
  it("refuses a network that is not a CAIP-2 id", () => {
    expect(() => gateway(fakeX402(), { network: "base" })).toThrow(/CAIP-2/);
  });
});

/**
 * The payment gateway: crawlmeter decides, x402 executes.
 *
 * `evaluate()` has already decided whether this request is charged and at what
 * price. The gateway never re-decides that. It does three protocol jobs and
 * delegates each of them to x402:
 *
 * - **challenge** — build the `payment-required` header for a price;
 * - **settle** — check a presented payment against that price and execute it;
 * - **receipt** — encode the `payment-response` header for a settled payment.
 *
 * ## Rejected versus unavailable
 *
 * `settle` answers one of three ways, and the line between the last two is the
 * security boundary of enforce mode:
 *
 * - **settled** — money moved. Serve, and say so.
 * - **rejected** — the payment was looked at and found wanting: it would not
 *   decode, it paid for a different price or asset, the facilitator said it was
 *   invalid, or settlement was refused. Answer 402 again.
 * - **unavailable** — nobody could look at it: x402 is not installed, or the
 *   facilitator is down. Fail open: serve, charge nothing, log.
 *
 * Failing open on "unavailable" is decision 7 — a billing dependency having a
 * bad day must never take somebody else's content offline. But fail-open must
 * never be reachable from the request itself, or it stops being a safety net
 * and becomes a bypass: send a crafted `payment-signature`, get the page free.
 * Two layers keep it out of reach:
 *
 * 1. Everything the crawler controls locally — decoding its header, matching
 *    its payment to the price — is **rejected** before any network call.
 * 2. A payment that survives that and then makes the facilitator fail during
 *    verify does NOT count as an outage on its own. The gateway asks the
 *    facilitator a question that carries no payment (`GET /supported`). If that
 *    answers, the facilitator is up and the failure was specific to this
 *    payment: **rejected**. Only if the probe fails too is the facilitator down:
 *    **unavailable**, and it stays marked down for the back-off window so every
 *    crawler is not made to wait out a timeout.
 *
 * Counting consecutive failures would not do: three crafted payments would trip
 * the counter and open the gate for everyone. A probe the request cannot touch
 * can only be failed by the facilitator actually being down.
 *
 * `test/payment/gateway.test.ts` pins every branch.
 *
 * ## Settlement happens before the content is served
 *
 * x402 can also verify first and settle after the handler runs. crawlmeter
 * settles first, for one reason: decision 3 requires `crawler-charged` on the
 * 200, and a header saying "you were charged" can only be true if the charge
 * already happened when headers go out. The trade-off is that a crawler pays
 * for the request, not for a successful response — acceptable for reading
 * content, and honest.
 */

import { toDecimalAmount, type Money } from "../types.js";
import {
  loadX402,
  type X402,
  type X402ResourceInfo,
  type X402ResourceServer,
} from "./x402.js";

export interface PaymentGatewayOptions {
  /** Wallet that receives payments. */
  readonly payTo: string;
  /** CAIP-2 network, e.g. `"eip155:8453"` for Base. */
  readonly network: string;
  /** Facilitator URL. The only outbound host enforce mode talks to. */
  readonly facilitator: string;
  /** Per-call facilitator timeout. Default 5 s. */
  readonly timeoutMs?: number;
  /** After the facilitator is found down, how long to answer "unavailable" before trying again. Default 30 s. */
  readonly retryAfterMs?: number;
  /** Timeout for the payment-free health probe. Default 2 s. */
  readonly probeTimeoutMs?: number;
  /** Where x402 comes from. Injected in tests; defaults to the real packages. */
  readonly loader?: () => Promise<X402>;
  readonly now?: () => number;
}

export type SettleOutcome =
  | {
      readonly status: "settled";
      /** Value for the `payment-response` header, or null if x402 could not encode one. */
      readonly paymentResponse: string | null;
      readonly transaction: string;
    }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "unavailable"; readonly error: unknown };

export interface PaymentGateway {
  /**
   * Load x402 and reach the facilitator. Rejects with the real cause — most
   * usefully, the install command when x402 is missing. `await` it at startup
   * to make a broken enforce setup fail the deploy instead of the traffic.
   */
  ready(): Promise<void>;
  /** The `payment-required` header for a price. Throws `PaymentUnavailableError`. */
  challenge(price: Money, resource: X402ResourceInfo): Promise<string>;
  /** Check a presented payment and execute it. Never throws. */
  settle(paymentSignature: string, price: Money): Promise<SettleOutcome>;
}

/** The facilitator or the payment library could not be reached. */
export class PaymentUnavailableError extends Error {
  override readonly name = "PaymentUnavailableError";
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

interface Connection {
  readonly x402: X402;
  readonly server: X402ResourceServer;
  readonly probe: () => Promise<void>;
}

export function createPaymentGateway(options: PaymentGatewayOptions): PaymentGateway {
  const loader = options.loader ?? loadX402;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const network = asNetwork(options.network);

  let connection: Promise<Connection> | null = null;
  let lastFailure: { readonly at: number; readonly error: unknown } | null = null;
  /** Set when a payment-free probe confirmed the facilitator is down. */
  let outage: { readonly until: number; readonly error: unknown } | null = null;

  /**
   * Connect once, share the result, and back off after a failure.
   *
   * Without the back-off, a facilitator that is down would cost every crawler
   * request a full timeout before failing open — the site would stay up, but
   * every crawler hit would be five seconds slow.
   */
  function connect(): Promise<Connection> {
    if (connection !== null) return connection;
    if (lastFailure !== null && now() - lastFailure.at < retryAfterMs) {
      return Promise.reject(lastFailure.error);
    }

    const attempt = (async (): Promise<Connection> => {
      const x402 = await loader();
      const server = x402.createResourceServer({ facilitator: options.facilitator, timeoutMs });
      const probe = x402.createProbe({ facilitator: options.facilitator, timeoutMs: probeTimeoutMs });
      await server.initialize();
      return { x402, server, probe };
    })();

    connection = attempt;
    attempt.then(
      () => {
        lastFailure = null;
      },
      (error: unknown) => {
        connection = null;
        lastFailure = { at: now(), error };
      },
    );
    return attempt;
  }

  function requirementsFor(server: X402ResourceServer, price: Money): Promise<unknown[]> {
    return server.buildPaymentRequirements({
      scheme: "exact",
      payTo: options.payTo,
      // Exact decimal built from integer micros. x402 converts it back to
      // token units with string arithmetic, so the amount is exact both ways.
      price: toDecimalAmount(price),
      network,
    });
  }

  /**
   * A verify call failed without a verdict. Ask the facilitator something that
   * carries no payment: if it answers, it is up, and the failure belongs to
   * this payment. Nothing has been charged yet, so a genuine crawler that hit
   * a transient fault just pays again.
   */
  async function classifyVerifyFailure(
    error: unknown,
    probe: () => Promise<void>,
  ): Promise<SettleOutcome> {
    let up: boolean;
    try {
      await probe();
      up = true;
    } catch {
      up = false;
    }
    if (up) {
      return { status: "rejected", reason: "the facilitator could not process this payment" };
    }
    outage = { until: now() + retryAfterMs, error };
    return { status: "unavailable", error };
  }

  return {
    async ready(): Promise<void> {
      await connect();
    },

    async challenge(price, resource): Promise<string> {
      try {
        const { x402, server } = await connect();
        const requirements = await requirementsFor(server, price);
        const paymentRequired = await server.createPaymentRequiredResponse(
          requirements as never[],
          resource,
        );
        return x402.encodePaymentRequiredHeader(paymentRequired as never);
      } catch (error) {
        // Nothing the crawler sent is involved in building a challenge, so any
        // failure here is ours or the facilitator's.
        throw new PaymentUnavailableError("could not build the x402 challenge", { cause: error });
      }
    },

    async settle(paymentSignature, price): Promise<SettleOutcome> {
      let x402: X402;
      let server: X402ResourceServer;
      let probe: () => Promise<void>;
      try {
        ({ x402, server, probe } = await connect());
      } catch (error) {
        return { status: "unavailable", error };
      }

      // 1. Decode. The crawler wrote this header, so a failure here is the
      //    crawler's problem — never grounds to fail open.
      let payload: unknown;
      try {
        payload = x402.decodePaymentSignatureHeader(paymentSignature);
      } catch {
        return { status: "rejected", reason: "malformed payment-signature header" };
      }

      // 2. What this resource costs. Built by us, so a failure is ours.
      let requirements: unknown[];
      try {
        requirements = await requirementsFor(server, price);
      } catch (error) {
        return { status: "unavailable", error };
      }

      // 3. Does the payment pay for THIS price, asset and network? A crawler
      //    paying $0.001 for a $0.01 page stops here, before the facilitator is
      //    even asked. The crawler controls the payload, so any failure —
      //    including x402 choking on a payload of the wrong shape — is a
      //    rejection.
      let matched: unknown;
      try {
        matched = server.findMatchingRequirements(requirements as never[], payload as never);
      } catch {
        return { status: "rejected", reason: "payment does not match this resource" };
      }
      if (matched === undefined || matched === null) {
        return { status: "rejected", reason: "payment does not match the price of this resource" };
      }

      // A confirmed outage skips the round trip. It is checked only now, after
      // the crawler-controlled steps, so a malformed or underpaid payment is
      // still rejected while the facilitator is down.
      if (outage !== null) {
        if (now() < outage.until) return { status: "unavailable", error: outage.error };
        outage = null;
      }

      // 4. Verify with the facilitator.
      try {
        const verdict = await server.verifyPayment(payload as never, matched as never);
        if (!verdict.isValid) {
          return { status: "rejected", reason: verdict.invalidReason ?? "invalid payment" };
        }
      } catch (error) {
        if (x402.isVerdict(error)) return { status: "rejected", reason: reasonOf(error) };
        // The facilitator failed on THIS payment. Whether that is an outage or
        // a payment built to break it is decided by a call the payment cannot
        // reach.
        return classifyVerifyFailure(error, probe);
      }

      // 5. Execute it.
      let settled: Awaited<ReturnType<X402ResourceServer["settlePayment"]>>;
      try {
        settled = await server.settlePayment(payload as never, matched as never);
      } catch (error) {
        // Deliberately NOT probed. By now the facilitator has already called
        // this payment valid, and a failure here may mean the transfer went
        // through with the answer lost in transit. Answering 402 could take a
        // legitimate crawler's money and withhold the page. Serving without
        // claiming a charge is right either way.
        return x402.isVerdict(error)
          ? { status: "rejected", reason: reasonOf(error) }
          : { status: "unavailable", error };
      }
      if (!settled.success) {
        return { status: "rejected", reason: settled.errorReason ?? "settlement failed" };
      }

      // 6. Receipt. Money has moved by now, so the content is served even if
      //    the header cannot be encoded.
      let paymentResponse: string | null;
      try {
        paymentResponse = x402.encodePaymentResponseHeader(settled as never);
      } catch {
        paymentResponse = null;
      }
      return { status: "settled", paymentResponse, transaction: settled.transaction };
    },
  };
}

/** The most specific reason an x402 verdict error carries. */
function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { invalidReason, errorReason, message } = error as {
      invalidReason?: unknown;
      errorReason?: unknown;
      message?: unknown;
    };
    for (const candidate of [invalidReason, errorReason, message]) {
      if (typeof candidate === "string" && candidate !== "") return candidate;
    }
  }
  return "payment refused";
}

/** CAIP-2 networks look like `namespace:reference`. Config already validated it. */
function asNetwork(value: string): `${string}:${string}` {
  if (!/^[^:]+:[^:]+$/.test(value)) {
    throw new TypeError(`crawlmeter: network must be a CAIP-2 id such as "eip155:8453", got "${value}"`);
  }
  return value as `${string}:${string}`;
}

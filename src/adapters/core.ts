/**
 * The framework-neutral engine every adapter drives.
 *
 * Identify, decide, pay, record — once, here. The Express middleware and the
 * Next.js proxy are thin translators around this: they turn their framework's
 * request into an `EngineRequest`, and the engine's `Answer` back into their
 * framework's response.
 *
 * It lives in one place because the logic in it is security logic. Which
 * failures fail open, which payments are rejected, when a session counts, how a
 * client address is chosen — if two adapters each had a copy, they would drift,
 * and the drift would be a hole in whichever one fell behind.
 *
 * Three properties the engine guarantees:
 *
 * 1. **`handle` never throws.** Every failure — detection, sessions, the store,
 *    the payment facilitator — ends in a pass with a `fail-open` record. This
 *    code sits in the request path of somebody else's site.
 * 2. **`isCrawler` is synchronous.** Adapters call it first and leave at once
 *    when it says no, which is almost every request. Nothing about a human
 *    visitor is detected, awaited or recorded.
 * 3. **The client address is chosen the way a trusted proxy wrote it.** See
 *    `clientAddress`.
 */

import {
  ConfigError,
  normalizeConfig,
  type CrawlmeterConfig,
  type NormalizedConfig,
} from "../config.js";
import { createDetector, type Detector } from "../detect/index.js";
import { matchUserAgent } from "../detect/ua.js";
import { evaluate, failOpen } from "../evaluate.js";
import {
  CRAWLER_CHARGED,
  CRAWLER_PRICE,
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  SESSION,
  header,
  readCrawlerHeaders,
  type HeaderBag,
} from "../headers.js";
import { createPaymentGateway, type PaymentGateway } from "../payment/gateway.js";
import { fromModules, type X402Modules } from "../payment/x402.js";
import { issueSessionToken, verifySessionToken } from "../session.js";
import { deferStore } from "../store/deferred.js";
import { createMemoryStore } from "../store/memory.js";
import { eventFromDecision, type Store } from "../store/types.js";
import {
  NOT_A_CRAWLER,
  toCrawlerPrice,
  type Decision,
  type EvaluatedRequest,
  type Identification,
  type Money,
} from "../types.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface EngineOptions extends CrawlmeterConfig {
  /**
   * Where decisions are recorded. Defaults to an in-process memory store.
   *
   * A promise is accepted, so a persistent store can be configured where
   * `await` is not available: `store: createSqliteStore({ path: "crawlmeter.db" })`.
   */
  readonly store?: Store | Promise<Store>;
  /** Identification. Defaults to the built-in detector. */
  readonly detector?: Detector;
  /**
   * How many proxies in front of the app to trust for `X-Forwarded-For`.
   *
   * - `false` / `0`: trust none; use the socket address.
   * - `true` / `1`: one proxy you control sits in front — nginx, a load
   *   balancer, Vercel, Cloudflare. The client is the entry that proxy added.
   * - `n`: `n` proxies you control, chained.
   *
   * Note that `true` means ONE trusted proxy, not "trust the header". Express
   * reads `true` as "take the leftmost entry", which is whatever the client
   * wrote; see `clientAddress` for why crawlmeter does not.
   */
  readonly trustProxy?: boolean | number;
  /** Called with anything that went wrong. The request is served regardless. */
  readonly onError?: (error: unknown) => void;
  /**
   * Called with a one-off setup warning. Defaults to `console.warn`.
   *
   * It prints by default on purpose: the conditions it reports make crawlmeter
   * record zero without failing, and a silent zero reads as "no crawlers came".
   * Pass `() => {}` to silence it.
   */
  readonly onWarning?: (message: string) => void;
  /**
   * The x402 gateway. In enforce mode one is built from `payTo`, `network` and
   * `facilitator` if none is given. Never built, and x402 never loaded, in
   * observe mode.
   */
  readonly payment?: PaymentGateway;
  /**
   * The x402 modules, from `crawlmeter/x402`. Needed in enforce mode when the
   * app is bundled for deployment (Vercel, Next.js `output: "standalone"`,
   * serverless bundlers): the default lazy import is invisible to the bundler,
   * which then leaves x402 out. Ignored in observe mode.
   */
  readonly x402?: X402Modules;
}

/**
 * Emitted once when requests carry `X-Forwarded-For` but no proxy is trusted.
 *
 * The one misconfiguration that breaks crawlmeter quietly. Behind any proxy the
 * socket address is the proxy's, so no published CIDR ever matches, every
 * crawler stalls at `ua-only`, falls under the default `minConfidenceToCharge`,
 * and the report shows zero potential revenue. Nothing errors. The operator
 * reads the zero as "no AI crawler traffic worth anything" and uninstalls.
 */
export const PROXY_WARNING =
  "crawlmeter: crawler requests are arriving with an X-Forwarded-For header, but trustProxy is off. " +
  "Identification is using the socket address (your proxy), so it cannot rise above \"ua-only\" and " +
  "reported potential revenue will stay at zero. If a proxy you control sets that header, pass " +
  "{ trustProxy: true }. Note that crawlmeter does not read Express's own \"trust proxy\" setting.";

/* -------------------------------------------------------------------------- */
/* The contract with adapters                                                  */
/* -------------------------------------------------------------------------- */

/** A request, as every adapter can describe it. */
export interface EngineRequest {
  readonly method: string;
  /** Path, optionally with a query string. The engine drops the query. */
  readonly url: string;
  /** Header names lowercased, as Node and Fetch both provide them. */
  readonly headers: HeaderBag;
  /** The TCP peer, when the framework exposes one. The Next.js proxy does not. */
  readonly socketAddress: string | null;
  /** `"http"` or `"https"` as the framework resolved it, if it did. */
  readonly protocol: string | null;
}

/** What the adapter should do with the request. */
export type Answer =
  | {
      /** Hand the request to the app, adding these headers to its response. */
      readonly kind: "pass";
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      /** Answer here and now. The app never sees the request. */
      readonly kind: "respond";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    };

export interface Handled {
  readonly answer: Answer;
  /**
   * Record the exchange, once its size is known. Pass null when the adapter
   * cannot see the response. Never throws.
   */
  record(bytes: number | null): void;
}

export interface Engine {
  readonly store: Store;
  readonly config: NormalizedConfig;
  /** See `CrawlmeterMiddleware.ready`. */
  readonly ready: Promise<void>;
  /** Trusted proxy hops, after normalising `true`/`false`. */
  readonly trustProxy: number;
  readonly onError: ((error: unknown) => void) | undefined;
  readonly onWarning: (message: string) => void;
  /** Synchronous fast path. False for anything that is not a known crawler, and on any error. */
  isCrawler(userAgent: string | null): boolean;
  /** Decide what to do with a crawler request. Never throws. */
  handle(request: EngineRequest): Promise<Handled>;
}

const PASS: Answer = { kind: "pass", headers: {} };

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

export function createEngine(
  options: EngineOptions,
  defaults: { readonly trustProxy: boolean | number },
): Engine {
  // Validate at boot. A misconfigured toll should break the deploy, not the
  // traffic.
  const config = normalizeConfig(options);
  const trustProxy = normalizeTrustProxy(options.trustProxy ?? defaults.trustProxy);
  const onErrorOption = options.onError;
  const store: Store =
    options.store === undefined
      ? createMemoryStore()
      : options.store instanceof Promise
        ? deferStore(options.store, onErrorOption)
        : options.store;
  const detector = options.detector ?? createDetector();
  const onError = options.onError;
  const onWarning = options.onWarning ?? ((message: string) => console.warn(message));

  // x402 exists only in enforce mode. In observe mode this stays null, and
  // nothing below can reach a payment library — the product's central promise,
  // held by test/observe-no-crypto.test.ts.
  const gateway: PaymentGateway | null =
    config.mode === "enforce"
      ? options.payment ??
        createPaymentGateway({
          // normalizeConfig refuses enforce without these three.
          payTo: config.payTo ?? "",
          network: config.network ?? "",
          facilitator: config.facilitator ?? "",
          ...(options.x402 !== undefined ? { loader: modulesLoader(options.x402) } : {}),
        })
      : null;

  const ready: Promise<void> = gateway === null ? Promise.resolve() : gateway.ready();
  // Reported now, not at the first crawler. Enforce mode that cannot load x402
  // fails open on every request — correct, and indistinguishable from observe
  // mode unless somebody says so. The handler also keeps an un-awaited
  // rejection from crashing the process.
  ready.catch((error: unknown) => {
    onError?.(error);
    warn(error instanceof Error ? error.message : String(error));
  });

  function warn(message: string): void {
    try {
      onWarning(message);
    } catch (error) {
      // A broken logger must not become a broken request.
      onError?.(error);
    }
  }

  // Once per engine, not once per request: this is a setup mistake, and
  // repeating it on every crawler hit would be its own kind of noise.
  let warnedAboutProxy = false;

  function isCrawler(userAgent: string | null): boolean {
    try {
      return matchUserAgent(userAgent) !== null;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }

  async function handle(request: EngineRequest): Promise<Handled> {
    if (trustProxy === 0 && !warnedAboutProxy && header(request.headers, "x-forwarded-for") !== null) {
      warnedAboutProxy = true;
      warn(PROXY_WARNING);
    }

    const method = request.method || "GET";
    const path = pathOf(request.url);
    let identification: Identification = NOT_A_CRAWLER;
    let decision: Decision;
    let paymentSignature: string | null = null;

    try {
      const headers = readCrawlerHeaders(request.headers);
      paymentSignature = headers.paymentSignature;
      identification = await detector({
        userAgent: header(request.headers, "user-agent"),
        ip: clientAddress(request.headers, request.socketAddress, trustProxy),
        signature: headers.signature,
      });

      const session = await verifySessionToken(headers.sessionToken, {
        secret: config.session.secret,
      });

      const evaluated: EvaluatedRequest = {
        method,
        path,
        identification,
        hasPaymentSignature: headers.hasPaymentSignature,
        // A session is a receipt for one agent. Presenting GPTBot's receipt
        // while claiming to be ClaudeBot is not a valid session.
        hasValidSession: session !== null && session.agent === identification.agent,
        maxPriceMicros: headers.maxPriceMicros,
      };

      decision = evaluate(evaluated, config);
    } catch (error) {
      onError?.(error);
      decision = failOpen();
    }

    // What gets recorded is what actually happened, which the payment step can
    // still change: a rejected payment ends as a 402, an outage as a fail-open.
    let outcome: { readonly decision: Decision; readonly answer: Answer };
    try {
      outcome = await act(decision, request, identification, paymentSignature);
    } catch (error) {
      onError?.(error);
      outcome = { decision: failOpen(), answer: PASS };
    }

    return {
      answer: outcome.answer,
      record(bytes) {
        try {
          store.record(
            eventFromDecision(outcome.decision, {
              method,
              path,
              agent: identification.agent,
              operator: identification.operator,
              confidence: identification.confidence,
              bytes,
            }),
          );
        } catch (error) {
          onError?.(error);
        }
      },
    };
  }

  async function act(
    decision: Decision,
    request: EngineRequest,
    identification: Identification,
    paymentSignature: string | null,
  ): Promise<{ decision: Decision; answer: Answer }> {
    const { price } = decision;
    if (decision.action === "require-payment" && price !== null) {
      return challengeOrServe(decision, price, request, null);
    }
    if (decision.action === "accept-payment" && price !== null) {
      return settleOrChallenge(decision, price, request, identification, paymentSignature);
    }
    return { decision, answer: PASS };
  }

  /**
   * Answer 402 with an x402 challenge — or, if one cannot be built, serve.
   *
   * A 402 with no `payment-required` header is a door no crawler can open, so
   * when the facilitator cannot be reached the only honest answers are "pay"
   * or "come in". Decision 7 picks "come in".
   */
  async function challengeOrServe(
    decision: Decision,
    price: Money,
    request: EngineRequest,
    rejection: string | null,
  ): Promise<{ decision: Decision; answer: Answer }> {
    let challenge: string;
    try {
      if (gateway === null) throw new Error("crawlmeter: no payment gateway in enforce mode");
      challenge = await gateway.challenge(price, { url: resourceUrl(request, trustProxy) });
    } catch (error) {
      onError?.(error);
      return { decision: failOpen(), answer: PASS };
    }

    const body = JSON.stringify({
      error: rejection === null ? "payment required" : "payment rejected",
      ...(rejection === null ? {} : { reason: rejection }),
      price: { amount: String(price.micros), currency: price.currency, decimals: 6 },
      route: decision.route ?? "*",
    });
    return {
      decision: { ...decision, action: "require-payment", reason: null },
      answer: {
        kind: "respond",
        status: 402,
        headers: {
          // Not optional. A 402 without a price is a closed door with no price tag.
          [CRAWLER_PRICE]: toCrawlerPrice(price),
          [PAYMENT_REQUIRED]: challenge,
          "content-type": "application/json; charset=utf-8",
        },
        body,
      },
    };
  }

  /**
   * A payment is attached: check it, execute it, and only then serve.
   *
   * Settlement happens before the app runs so that `crawler-charged` on the 200
   * is a statement of fact — see `src/payment/gateway.ts`.
   */
  async function settleOrChallenge(
    decision: Decision,
    price: Money,
    request: EngineRequest,
    identification: Identification,
    paymentSignature: string | null,
  ): Promise<{ decision: Decision; answer: Answer }> {
    if (gateway === null || paymentSignature === null) {
      return { decision: failOpen(), answer: PASS };
    }

    const result = await gateway.settle(paymentSignature, price);

    if (result.status === "rejected") {
      // A bad payment gets the price again, never the content.
      return challengeOrServe(decision, price, request, result.reason);
    }

    if (result.status === "unavailable") {
      onError?.(result.error);
      return { decision: failOpen(), answer: PASS };
    }

    // Settled. Say what was charged, hand over the receipts, serve.
    const headers: Record<string, string> = { [CRAWLER_CHARGED]: toCrawlerPrice(price) };
    if (result.paymentResponse !== null) headers[PAYMENT_RESPONSE] = result.paymentResponse;
    if (config.session.secret !== null && identification.agent !== null) {
      try {
        headers[SESSION] = await issueSessionToken(identification.agent, {
          secret: config.session.secret,
          ttlSeconds: config.session.ttlSeconds,
        });
      } catch (error) {
        // The payment went through; a missing session only costs the crawler a
        // second payment for the next asset. Serve regardless.
        onError?.(error);
      }
    }
    return { decision, answer: { kind: "pass", headers } };
  }

  return { store, config, ready, trustProxy, onError, onWarning, isCrawler, handle };
}

/**
 * Use modules the app imported itself instead of loading them lazily.
 *
 * Assembled inside the promise, so a version mismatch surfaces through `ready`
 * and the fail-open path like any other load failure, instead of throwing while
 * the app is still starting.
 */
function modulesLoader(modules: X402Modules) {
  return () => Promise.resolve().then(() => fromModules(modules));
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                             */
/* -------------------------------------------------------------------------- */

/** `true` is one hop, `false` is none. Anything else must be a whole number. */
export function normalizeTrustProxy(value: boolean | number): number {
  if (value === true) return 1;
  if (value === false) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `trustProxy must be true, false or a whole number of proxies, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * The address to identify against.
 *
 * With no trusted proxy, only the socket address counts — the one value a
 * client cannot set.
 *
 * With `n` trusted proxies, the answer is the entry the outermost trusted proxy
 * wrote: `n` from the RIGHT of `X-Forwarded-For`. Not the leftmost. nginx
 * (`$proxy_add_x_forwarded_for`), AWS load balancers, Cloudflare and Fly all
 * APPEND the address they saw to whatever the client sent. So the leftmost
 * entry is attacker-controlled everywhere that appends: a scraper sends
 * `X-Forwarded-For: 132.196.86.5`, the proxy appends its real address, and a
 * leftmost reading identifies it as GPTBot at `ip-range` confidence — the
 * strongest signal crawlmeter has, forged with one header. Proxies that
 * overwrite instead (Vercel) leave one entry, which reads the same either way.
 *
 * Fewer entries than trusted hops means the chain is not what the config says;
 * the socket address is the only safe answer then.
 */
export function clientAddress(
  headers: HeaderBag,
  socketAddress: string | null,
  trustProxy: number,
): string | null {
  if (trustProxy > 0) {
    const entries = (header(headers, "x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (entries.length >= trustProxy) return entries[entries.length - trustProxy] ?? null;
  }
  return socketAddress;
}

/**
 * Pathname only.
 *
 * The query string is dropped before route matching, so `/api/x?page=2` prices
 * the same as `/api/x`. Otherwise every distinct query would look like a
 * separate route in the report and a crawler could dodge a rule by appending a
 * parameter.
 */
export function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  return path === "" ? "/" : path;
}

/**
 * The absolute URL of the requested resource, for the x402 challenge.
 *
 * Informational — it tells the payer what they are paying for — and held to the
 * same rule as the address: `X-Forwarded-Proto` counts only when a proxy is
 * trusted, and then the entry nearest the app is used.
 */
export function resourceUrl(request: EngineRequest, trustProxy: number): string {
  const host = header(request.headers, "host") ?? "localhost";
  const forwarded =
    trustProxy > 0
      ? header(request.headers, "x-forwarded-proto")?.split(",").map((entry) => entry.trim()).pop()
      : undefined;
  const protocol = forwarded || request.protocol || "http";
  return `${protocol}://${host}${pathOf(request.url)}`;
}

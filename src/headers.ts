/**
 * The HTTP headers crawlmeter reads and writes.
 *
 * Two families meet here.
 *
 * **Cloudflare's `crawler-*` headers** are the vocabulary crawler operators
 * already implement, so crawlmeter speaks it whether or not payment is ever
 * switched on. `crawler-price` goes on every 402 — it is not optional. A 402
 * that does not say what the page costs is a closed door with no price tag.
 *
 * **x402 v2 headers** (`payment-required`, `payment-signature`,
 * `payment-response`) carry the actual payment. v1's `x-payment` and
 * `x-payment-response` still exist in the published packages for backwards
 * compatibility and we deliberately emit NEITHER — one wire format, documented,
 * so nobody has to guess which one a crawlmeter site speaks.
 *
 * A declared budget is not a payment. `crawler-max-price` and
 * `crawler-exact-price` are read and reported, and neither opens the gate.
 * Cloudflare can serve on those headers because their network is merchant of
 * record and bills the crawler afterwards; crawlmeter holds no such position,
 * so under x402 only a verified payment counts.
 */

import { ConfigError, parseMoney } from "./config.js";
import { toCrawlerPrice, type Money } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/** What this resource costs. Emitted on every 402. */
export const CRAWLER_PRICE = "crawler-price";
/** Crawler's declared ceiling. Recorded, never honoured as payment. */
export const CRAWLER_MAX_PRICE = "crawler-max-price";
/** Crawler's declared exact bid. Recorded, never honoured as payment. */
export const CRAWLER_EXACT_PRICE = "crawler-exact-price";
/** What was actually charged. Emitted on a 200 that followed a settlement. */
export const CRAWLER_CHARGED = "crawler-charged";

/** x402 v2 challenge. */
export const PAYMENT_REQUIRED = "payment-required";
/** x402 v2 payment presented by the crawler. */
export const PAYMENT_SIGNATURE = "payment-signature";
/** x402 v2 settlement receipt. */
export const PAYMENT_RESPONSE = "payment-response";

/** Session receipt issued after a settled payment. */
export const SESSION = "crawlmeter-session";

/** RFC 9421 headers, read by the signature detection layer. */
export const SIGNATURE = "signature";
export const SIGNATURE_INPUT = "signature-input";
export const SIGNATURE_AGENT = "signature-agent";

/**
 * x402 v1 headers. Listed so the test suite can assert we never emit them, not
 * because anything here writes them.
 */
export const LEGACY_HEADERS = ["x-payment", "x-payment-response"] as const;

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Headers as a framework hands them over. */
export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/** First value of a header, lowercased name, or null. */
export function header(headers: HeaderBag, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (value === undefined) return null;
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first !== "" ? first : null;
}

/**
 * Parse a price header into micros.
 *
 * Returns null instead of throwing: a crawler sending a malformed budget gets
 * its budget ignored, not a 500. Config gets the strict parser; the wire gets
 * the forgiving one.
 */
export function parsePriceHeader(value: string | null): number | null {
  if (value === null) return null;
  try {
    return parseMoney(value).micros;
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

export interface CrawlerHeaders {
  /** `crawler-max-price` in micros, or null. */
  readonly maxPriceMicros: number | null;
  /** `crawler-exact-price` in micros, or null. */
  readonly exactPriceMicros: number | null;
  /** True when an x402 v2 payment is attached. */
  readonly hasPaymentSignature: boolean;
  /** The attached x402 v2 payment, exactly as sent. */
  readonly paymentSignature: string | null;
  /** Session token presented by the crawler. */
  readonly sessionToken: string | null;
  /** RFC 9421 headers, in the shape the detection layer wants. */
  readonly signature: {
    readonly signature: string | null;
    readonly signatureInput: string | null;
    readonly signatureAgent: string | null;
  };
}

/** Read everything crawlmeter cares about out of a request's headers. */
export function readCrawlerHeaders(headers: HeaderBag): CrawlerHeaders {
  const paymentSignature = header(headers, PAYMENT_SIGNATURE);
  return {
    maxPriceMicros: parsePriceHeader(header(headers, CRAWLER_MAX_PRICE)),
    exactPriceMicros: parsePriceHeader(header(headers, CRAWLER_EXACT_PRICE)),
    hasPaymentSignature: paymentSignature !== null,
    paymentSignature,
    sessionToken: header(headers, SESSION),
    signature: {
      signature: header(headers, SIGNATURE),
      signatureInput: header(headers, SIGNATURE_INPUT),
      signatureAgent: header(headers, SIGNATURE_AGENT),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** The slice of a response object needed to set headers. */
export interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

/** Announce the price of this resource. Belongs on every 402. */
export function setCrawlerPrice(response: HeaderSink, price: Money): void {
  response.setHeader(CRAWLER_PRICE, toCrawlerPrice(price));
}

/** Announce what was actually charged. Belongs on a 200 that followed a settlement. */
export function setCrawlerCharged(response: HeaderSink, price: Money): void {
  response.setHeader(CRAWLER_CHARGED, toCrawlerPrice(price));
}

/** Hand the crawler its session receipt. */
export function setSessionToken(response: HeaderSink, token: string): void {
  response.setHeader(SESSION, token);
}

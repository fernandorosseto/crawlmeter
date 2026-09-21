/**
 * Core types for crawlmeter.
 *
 * This module is pure: no I/O, no framework, no payment library.
 */

/* -------------------------------------------------------------------------- */
/* Confidence                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How sure we are that a request really came from the crawler it claims to be.
 *
 * Ordered weakest to strongest. The names are deliberately honest:
 *
 * - `ua-only`            User-Agent matched a known crawler. Forgeable with one
 *                        line of curl. This is a guess, not an identification.
 * - `signed-unverified`  RFC 9421 `Signature` / `Signature-Input` headers are
 *                        present, but we have NOT verified the signature. Also
 *                        forgeable — attaching headers proves nothing. It ranks
 *                        above `ua-only` only because it signals intent to
 *                        identify, and it ranks BELOW `ip-range` on purpose.
 * - `ip-range`           Source IP falls inside a CIDR block the operator
 *                        publishes. Hard to forge, but shared cloud ranges and
 *                        stale published lists keep this short of proof.
 * - `rdns`               Reverse DNS resolves to the operator's domain and a
 *                        forward lookup confirms it. Costs a DNS round trip.
 * - `signed-verified`    RFC 9421 signature cryptographically verified against
 *                        the operator's published key. Actual proof. Not
 *                        implemented in v0.1 — see README.
 */
export type Confidence =
  | "ua-only"
  | "signed-unverified"
  | "ip-range"
  | "rdns"
  | "signed-verified";

/** Confidence levels from weakest to strongest. Index is the rank. */
export const CONFIDENCE_ORDER = [
  "ua-only",
  "signed-unverified",
  "ip-range",
  "rdns",
  "signed-verified",
] as const satisfies readonly Confidence[];

/** Numeric rank of a confidence level. Higher is stronger. */
export function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_ORDER.indexOf(confidence);
}

/** True when `actual` is at least as strong as `minimum`. */
export function meetsConfidence(actual: Confidence, minimum: Confidence): boolean {
  return confidenceRank(actual) >= confidenceRank(minimum);
}

/** Type guard for values coming from user config or JSON. */
export function isConfidence(value: unknown): value is Confidence {
  return (
    typeof value === "string" &&
    (CONFIDENCE_ORDER as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A price, stored as an integer count of micro-units (1e-6).
 *
 * Integers, not floats: `0.1 + 0.2 !== 0.3` has no place in a billing path.
 * Micro-units were chosen because USDC has exactly 6 decimals, so `micros`
 * converts to an x402 `amount` string with no scaling and no rounding.
 */
export interface Money {
  /** Integer micro-units. $0.01 is 10_000. Never negative. */
  readonly micros: number;
  readonly currency: "USD";
}

/** Micro-units per whole currency unit. */
export const MICROS_PER_UNIT = 1_000_000;

/** Build a Money from an integer micro amount. */
export function money(micros: number): Money {
  if (!Number.isInteger(micros) || micros < 0) {
    throw new RangeError(`money() expects a non-negative integer, got ${micros}`);
  }
  return { micros, currency: "USD" };
}

/**
 * Render as an x402 `amount` — the smallest unit of the asset, as a string.
 * Assumes a 6-decimal asset such as USDC, which is what `micros` encodes.
 */
export function toAssetAmount(value: Money): string {
  return String(value.micros);
}

/**
 * Render as an exact decimal string, e.g. `"0.010000"` for 10_000 micros.
 *
 * This is the form x402 accepts as a price. It is built from integer digits,
 * never from a float, so `$0.07` arrives as `"0.070000"` rather than as
 * `0.06999999999999999`. x402's own conversion back to token units is also
 * string-based, which is what makes the round trip exact — and there is a test
 * against the real library that holds both sides to that.
 */
export function toDecimalAmount(value: Money): string {
  const whole = Math.floor(value.micros / MICROS_PER_UNIT);
  const frac = value.micros % MICROS_PER_UNIT;
  return `${whole}.${String(frac).padStart(6, "0")}`;
}

/**
 * Render for the Cloudflare-style `crawler-price` header, e.g. `USD 0.01`.
 * Trailing zeros beyond two decimals are trimmed, but at least two are kept
 * so prices read as currency.
 */
export function toCrawlerPrice(value: Money): string {
  const whole = Math.floor(value.micros / MICROS_PER_UNIT);
  const frac = value.micros % MICROS_PER_UNIT;
  let fracStr = String(frac).padStart(6, "0").replace(/0+$/, "");
  if (fracStr.length < 2) fracStr = fracStr.padEnd(2, "0");
  return `${value.currency} ${whole}.${fracStr}`;
}

/* -------------------------------------------------------------------------- */
/* Identification                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The result of the detection layers. Produced outside `evaluate`, because
 * detection does I/O (DNS, fetching published IP ranges) and `evaluate` does not.
 */
export interface Identification {
  /** Stable lowercase id from the agent catalog, e.g. `"gptbot"`. Null = not a known crawler. */
  readonly agent: string | null;
  /** Operator id, e.g. `"openai"`. Null when unknown or not a crawler. */
  readonly operator: string | null;
  /** Null exactly when `agent` is null. */
  readonly confidence: Confidence | null;
  /** Human-readable trail of what matched, for the report and for debugging. */
  readonly evidence: readonly string[];
}

/** An identification meaning "this is not a crawler we know about". */
export const NOT_A_CRAWLER: Identification = {
  agent: null,
  operator: null,
  confidence: null,
  evidence: [],
};

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything `evaluate` needs, already resolved by the adapter.
 *
 * Nothing here requires a network call, which is what makes `evaluate` a pure
 * function and the whole decision layer testable without mocks.
 */
export interface EvaluatedRequest {
  readonly method: string;
  /** Pathname only — no query string, no origin. */
  readonly path: string;
  readonly identification: Identification;
  /** True when the request carries an x402 v2 `payment-signature` header. */
  readonly hasPaymentSignature: boolean;
  /** True when the request carries a session token we already verified. */
  readonly hasValidSession: boolean;
  /**
   * Value of the Cloudflare-style `crawler-max-price` request header, in micros.
   *
   * Recorded but NOT acted on in v0.1: declaring a budget is not a payment. In
   * Cloudflare's model their network is merchant of record and settles the
   * charge; we have no such position, so under x402 only a verified payment
   * grants access. See the `crawler-max-price` test.
   */
  readonly maxPriceMicros?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                    */
/* -------------------------------------------------------------------------- */

/** Why a request was let through without being charged. */
export type PassReason =
  | "not-a-crawler"
  | "free-path"
  | "valid-session"
  | "allowlisted"
  | "not-charged"
  | "below-min-confidence"
  | "no-price"
  | "observe-mode"
  | "fail-open";

export type DecisionAction = "pass" | "require-payment" | "accept-payment";

/**
 * What the middleware should do, plus what the store should record.
 */
export interface Decision {
  readonly action: DecisionAction;
  /** Set only when `action` is `"pass"`. */
  readonly reason: PassReason | null;
  /** The route pattern that matched, or `"*"` for the default price. Null when no price applied. */
  readonly route: string | null;
  /** The price resolved for this route, independent of whether it was charged. */
  readonly price: Money | null;
  /**
   * What `mode: "enforce"` would have charged for this exact request under this
   * exact config — the number the report headlines as potential revenue.
   *
   * Null whenever enforce mode would also have let the request through. In
   * particular a `ua-only` hit under the default `minConfidenceToCharge`
   * contributes nothing, because flipping enforce on would not have billed it.
   * Counting it would overstate the headline number on the README's first screen.
   */
  readonly potential: Money | null;
}

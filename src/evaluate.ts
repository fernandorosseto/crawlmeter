/**
 * The decision engine.
 *
 * `evaluate` is a pure function: same input, same output, no clock, no network,
 * no DNS, no filesystem. Every expensive thing — reverse DNS, fetching an
 * operator's published IP ranges, verifying a payment with a facilitator — is
 * resolved by the adapter before this runs. That is what lets the entire
 * precedence table be tested without a single mock.
 */

import { meetsConfidence, type Decision, type EvaluatedRequest, type PassReason } from "./types.js";
import type { NormalizedConfig } from "./config.js";
import { isFree, resolvePrice } from "./pricing.js";

/** Build a `pass` decision that records nothing as billable. */
function pass(reason: PassReason): Decision {
  return { action: "pass", reason, route: null, price: null, potential: null };
}

/**
 * Decide what to do with a request.
 *
 * The order of the checks below is load-bearing twice over. It decides who gets
 * billed, and it decides the `reason` label — which feeds the report, so a
 * swapped pair does not just mislabel a row, it moves traffic between buckets
 * the operator reads as "nearly billable" and "ignored".
 *
 *  1. not a known crawler      fast exit, before any work
 *  2. path is always free
 *  3. already paid this session
 *  4. agent is allowlisted
 *  5. agent is outside the charge list
 *  6. identification too weak to bill
 *  7. no price applies to this path
 *  8. observe mode              the only branch that books potential revenue
 *  9. payment attached          verify it
 * 10. otherwise                 ask for payment
 */
export function evaluate(request: EvaluatedRequest, config: NormalizedConfig): Decision {
  const { agent, confidence } = request.identification;

  // 1. Not a crawler we know. This is the overwhelming majority of traffic, so
  //    it exits before route matching, price resolution or anything else.
  if (agent === null || confidence === null) {
    return pass("not-a-crawler");
  }

  // 2. Always-free paths. robots.txt and friends stay free for everyone: a toll
  //    on the file that declares your crawling policy is self-defeating.
  if (isFree(request.path, config.freeMatchers)) {
    return pass("free-path");
  }

  // 3. A valid session means this crawler already paid within the TTL. Charging
  //    per asset would bill a single page view dozens of times.
  if (request.hasValidSession) {
    return pass("valid-session");
  }

  // 4. Allowlisted agents pass free but are still recorded — knowing how much
  //    Googlebot costs you is part of the point, even if you never bill it.
  if (config.allow.has(agent)) {
    return pass("allowlisted");
  }

  // 5. An empty charge list means "every known AI crawler". A non-empty one is
  //    exhaustive: anything outside it passes.
  if (config.charge.size > 0 && !config.charge.has(agent)) {
    return pass("not-charged");
  }

  // 6. Identification too weak to bill on. Checked before pricing so the reason
  //    reported is the real one — the request was not skipped for lack of a
  //    price, it was skipped because we cannot prove who sent it.
  if (!meetsConfidence(confidence, config.minConfidenceToCharge)) {
    return pass("below-min-confidence");
  }

  // 7. No route matched and no default price. A legitimate setup: count crawler
  //    traffic without putting a number on it.
  const resolved = resolvePrice(request.path, config.routes, config.defaultPrice);
  if (resolved === null) {
    return pass("no-price");
  }

  const { route, price } = resolved;

  // 8. Observe mode. Nothing is blocked and nothing is charged, but this is the
  //    one pass branch that books potential revenue, because it is the one
  //    where enforce mode would have billed. Everything above would have passed
  //    in enforce mode too, so counting any of it would inflate the headline
  //    number on the README's first screen.
  if (config.mode === "observe") {
    return { action: "pass", reason: "observe-mode", route, price, potential: price };
  }

  // 9. Payment attached — hand off to the facilitator for verify and settle.
  //
  //    `crawler-max-price` is deliberately not consulted here. Declaring a
  //    budget is not a payment. Cloudflare can serve on that header because
  //    their network is merchant of record and bills the crawler afterwards; we
  //    have no such position, so under x402 only a verified payment opens the
  //    gate.
  if (request.hasPaymentSignature) {
    return { action: "accept-payment", reason: null, route, price, potential: price };
  }

  // 10. Ask for payment.
  return { action: "require-payment", reason: null, route, price, potential: price };
}

/**
 * The decision to fall back to when something outside `evaluate` breaks — a
 * facilitator timeout, an unreachable IP-range list, a store write that throws.
 *
 * crawlmeter fails open, always. This middleware sits in the request path of
 * somebody else's site; a billing dependency having a bad day must never take
 * their content offline. The failure is logged and the content is served.
 */
export function failOpen(): Decision {
  return pass("fail-open");
}

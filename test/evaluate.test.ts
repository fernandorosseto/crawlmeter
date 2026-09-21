import { describe, expect, it } from "vitest";
import { evaluate, failOpen } from "../src/evaluate.js";
import { normalizeConfig, parseMoney } from "../src/config.js";
import { ENFORCE_BASE, identify, request } from "./helpers.js";

const observe = (overrides = {}) =>
  normalizeConfig({ mode: "observe", price: "$0.01", ...overrides });

const enforce = (overrides = {}) =>
  normalizeConfig({ ...ENFORCE_BASE, price: "$0.01", ...overrides });

describe("precedence order", () => {
  it("1. exits first for non-crawlers", () => {
    const decision = evaluate(
      request({ identification: identify(null), path: "/robots.txt", hasValidSession: true }),
      observe(),
    );
    // Every later rule also matches; not-a-crawler must still win.
    expect(decision.reason).toBe("not-a-crawler");
    expect(decision.action).toBe("pass");
  });

  it("2. free paths beat session, allow, charge and mode", () => {
    const decision = evaluate(
      request({ path: "/robots.txt", hasValidSession: true }),
      enforce({ charge: ["gptbot"] }),
    );
    expect(decision.reason).toBe("free-path");
  });

  it("2. free paths support globs", () => {
    const decision = evaluate(request({ path: "/.well-known/ai.txt" }), enforce());
    expect(decision.reason).toBe("free-path");
  });

  it("3. a valid session beats allowlisting and charging", () => {
    const decision = evaluate(request({ hasValidSession: true }), enforce({ charge: ["gptbot"] }));
    expect(decision.reason).toBe("valid-session");
  });

  it("4. allowlisted agents pass", () => {
    const decision = evaluate(request(), enforce({ allow: ["gptbot"] }));
    expect(decision.reason).toBe("allowlisted");
  });

  it("5. an agent outside a non-empty charge list passes", () => {
    const decision = evaluate(request(), enforce({ charge: ["ccbot"] }));
    expect(decision.reason).toBe("not-charged");
  });

  it("5. an empty charge list means every known crawler", () => {
    const decision = evaluate(request(), enforce({ charge: [] }));
    expect(decision.action).toBe("require-payment");
  });

  it("6. below-min-confidence is reported before no-price", () => {
    // No price configured at all AND weak identification. The confidence check
    // comes first, so the operator learns the real reason: we could not prove
    // who sent it, not that pricing was missing.
    const config = normalizeConfig({ ...ENFORCE_BASE, routes: { "/other/*": "$0.01" } });
    const decision = evaluate(
      request({ path: "/blog/x", identification: identify("ccbot", "ua-only") }),
      config,
    );
    expect(decision.reason).toBe("below-min-confidence");
  });

  it("7. no matching route and no default price passes with no-price", () => {
    const config = normalizeConfig({ ...ENFORCE_BASE, routes: { "/api/*": "$0.05" } });
    const decision = evaluate(request({ path: "/blog/x" }), config);
    expect(decision.reason).toBe("no-price");
    expect(decision.potential).toBeNull();
  });

  it("8. observe mode passes everything that would otherwise be billed", () => {
    const decision = evaluate(request(), observe());
    expect(decision.action).toBe("pass");
    expect(decision.reason).toBe("observe-mode");
  });

  it("9. a payment signature is accepted", () => {
    const decision = evaluate(request({ hasPaymentSignature: true }), enforce());
    expect(decision.action).toBe("accept-payment");
    expect(decision.reason).toBeNull();
  });

  it("10. otherwise payment is required", () => {
    const decision = evaluate(request(), enforce());
    expect(decision.action).toBe("require-payment");
    expect(decision.price).toEqual(parseMoney("$0.01"));
  });

  it("5 before 6: an uncharged agent reads as not-charged, not below-min-confidence", () => {
    // The pair most likely to be written in the wrong order. Getting it
    // backwards files ignored traffic under "nearly billable".
    const decision = evaluate(
      request({ identification: identify("ccbot", "ua-only") }),
      enforce({ charge: ["gptbot"] }),
    );
    expect(decision.reason).toBe("not-charged");
  });
});

describe("potential revenue", () => {
  it("books the route price in observe mode", () => {
    const decision = evaluate(request({ path: "/api/x" }), observe({ routes: { "/api/*": "$0.05" } }));
    expect(decision.potential).toEqual(parseMoney("$0.05"));
    expect(decision.route).toBe("/api/*");
  });

  it("books nothing for a ua-only hit under the default minimum", () => {
    // The headline number must answer "what would enforce mode have earned?".
    // Enforce would not have billed this, so counting it would be a lie on the
    // first screen of the README.
    const decision = evaluate(
      request({ identification: identify("ccbot", "ua-only") }),
      observe(),
    );
    expect(decision.reason).toBe("below-min-confidence");
    expect(decision.potential).toBeNull();
  });

  it("books a ua-only hit once the operator opts into billing one", () => {
    const decision = evaluate(
      request({ identification: identify("ccbot", "ua-only") }),
      observe({ minConfidenceToCharge: "ua-only" }),
    );
    expect(decision.reason).toBe("observe-mode");
    expect(decision.potential).toEqual(parseMoney("$0.01"));
  });

  it("books nothing for allowlisted, free, session or non-crawler traffic", () => {
    const cases = [
      evaluate(request(), observe({ allow: ["gptbot"] })),
      evaluate(request({ path: "/robots.txt" }), observe()),
      evaluate(request({ hasValidSession: true }), observe()),
      evaluate(request({ identification: identify(null) }), observe()),
      evaluate(request(), observe({ charge: ["ccbot"] })),
    ];
    for (const decision of cases) {
      expect(decision.potential).toBeNull();
    }
  });

  it("books the price on both enforce outcomes, so the two modes are comparable", () => {
    expect(evaluate(request(), enforce()).potential).toEqual(parseMoney("$0.01"));
    expect(evaluate(request({ hasPaymentSignature: true }), enforce()).potential).toEqual(
      parseMoney("$0.01"),
    );
  });

  it("matches observe potential to enforce charge for the same request", () => {
    // The property the report rests on: observe is a dry run of enforce.
    const paths = ["/api/users", "/blog/post", "/anything", "/api/v1/deep/nested"];
    const routes = { "/api/*": "$0.05", "/blog/*": "$0.002" };
    for (const path of paths) {
      const observed = evaluate(request({ path }), observe({ routes }));
      const enforced = evaluate(request({ path }), enforce({ routes }));
      expect(observed.potential).toEqual(enforced.potential);
      expect(observed.route).toBe(enforced.route);
    }
  });
});

describe("confidence gating", () => {
  const levels = ["ua-only", "signed-unverified", "ip-range", "rdns", "signed-verified"] as const;

  it("bills at or above the minimum and passes below it", () => {
    for (const level of levels) {
      const decision = evaluate(
        request({ identification: identify("gptbot", level) }),
        enforce({ minConfidenceToCharge: "ip-range" }),
      );
      const billable = ["ip-range", "rdns", "signed-verified"].includes(level);
      expect(decision.action, level).toBe(billable ? "require-payment" : "pass");
    }
  });

  it("ranks an unverified signature below a published IP range", () => {
    // Attaching RFC 9421 headers without a verified signature proves nothing —
    // it is as forgeable as a User-Agent and must not outrank IP evidence.
    const decision = evaluate(
      request({ identification: identify("gptbot", "signed-unverified") }),
      enforce({ minConfidenceToCharge: "ip-range" }),
    );
    expect(decision.reason).toBe("below-min-confidence");
  });
});

describe("crawler-max-price", () => {
  it("does not grant access on its own", () => {
    // Declaring a budget is not a payment. Cloudflare can serve on this header
    // because it is merchant of record; we are not.
    const decision = evaluate(
      request({ maxPriceMicros: 1_000_000, hasPaymentSignature: false }),
      enforce(),
    );
    expect(decision.action).toBe("require-payment");
  });
});

describe("route specificity", () => {
  const routes = { "/api/*": "$0.05", "/api/public/*": "$0.001", "/blog/*": "$0.002" };

  it("prefers the more specific pattern", () => {
    const decision = evaluate(request({ path: "/api/public/status" }), enforce({ routes }));
    expect(decision.route).toBe("/api/public/*");
    expect(decision.price).toEqual(parseMoney("$0.001"));
  });

  it("matches across path segments", () => {
    const decision = evaluate(request({ path: "/api/v1/deep/nested" }), enforce({ routes }));
    expect(decision.route).toBe("/api/*");
  });

  it('falls back to the default price and reports the route as "*"', () => {
    const decision = evaluate(request({ path: "/about" }), enforce({ routes }));
    expect(decision.route).toBe("*");
    expect(decision.price).toEqual(parseMoney("$0.01"));
  });
});

describe("failOpen", () => {
  it("passes and books nothing", () => {
    const decision = failOpen();
    expect(decision.action).toBe("pass");
    expect(decision.reason).toBe("fail-open");
    expect(decision.potential).toBeNull();
  });
});

describe("purity", () => {
  it("returns the same decision for the same input", () => {
    const config = enforce();
    const req = request();
    expect(evaluate(req, config)).toEqual(evaluate(req, config));
  });

  it("does not mutate its arguments", () => {
    const config = enforce();
    const req = request();
    const reqSnapshot = structuredClone(req);
    evaluate(req, config);
    expect(req).toEqual(reqSnapshot);
  });
});

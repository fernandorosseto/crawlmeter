import { describe, expect, it } from "vitest";
import { ConfigError, normalizeConfig, parseMoney } from "../src/config.js";
import { toAssetAmount, toCrawlerPrice } from "../src/types.js";
import { ENFORCE_BASE } from "./helpers.js";

describe("parseMoney", () => {
  it("accepts the formats a human would write", () => {
    for (const input of ["$0.01", "USD 0.01", "usd 0.01", "0.01", " $0.01 ", 0.01]) {
      expect(parseMoney(input).micros, String(input)).toBe(10_000);
    }
  });

  it("parses decimals exactly, without float drift", () => {
    // 0.07 through Number arithmetic gives 0.06999999999999999.
    expect(parseMoney("$0.07").micros).toBe(70_000);
    expect(parseMoney("$0.29").micros).toBe(290_000);
    expect(parseMoney("$1.10").micros).toBe(1_100_000);
    expect(parseMoney("$0.000001").micros).toBe(1);
  });

  it("strips thousands separators", () => {
    expect(parseMoney("$1,234.50").micros).toBe(1_234_500_000);
  });

  it("rejects more than six decimals rather than rounding silently", () => {
    expect(() => parseMoney("$0.0000001")).toThrow(ConfigError);
    expect(() => parseMoney("$0.0000001")).toThrow(/maximum is 6/);
  });

  it("rejects negatives, junk and empties", () => {
    for (const input of ["-1", "$-0.01", "abc", "", "  ", "$", "1.2.3", -0.5, NaN, Infinity]) {
      expect(() => parseMoney(input as string | number), String(input)).toThrow(ConfigError);
    }
  });

  it("round-trips through the x402 amount and the crawler-price header", () => {
    expect(toAssetAmount(parseMoney("$0.01"))).toBe("10000");
    expect(toCrawlerPrice(parseMoney("$0.01"))).toBe("USD 0.01");
    expect(toCrawlerPrice(parseMoney("$1.50"))).toBe("USD 1.50");
    expect(toCrawlerPrice(parseMoney("$0.002"))).toBe("USD 0.002");
  });
});

describe("normalizeConfig defaults", () => {
  it("defaults to observe mode", () => {
    expect(normalizeConfig().mode).toBe("observe");
  });

  it("defaults minConfidenceToCharge to ip-range, excluding ua-only", () => {
    expect(normalizeConfig().minConfidenceToCharge).toBe("ip-range");
  });

  it("defaults the free list to robots.txt, sitemap.xml and .well-known", () => {
    const config = normalizeConfig();
    for (const path of ["/robots.txt", "/sitemap.xml", "/.well-known/anything"]) {
      expect(config.freeMatchers.some((m) => m(path)), path).toBe(true);
    }
    expect(config.freeMatchers.some((m) => m("/blog/post"))).toBe(false);
  });

  it("defaults the session TTL to 600 seconds", () => {
    expect(normalizeConfig().session.ttlSeconds).toBe(600);
  });

  it("lowercases and trims agent ids", () => {
    const config = normalizeConfig({ allow: [" GPTBot "], charge: ["CCBot"] });
    expect(config.allow.has("gptbot")).toBe(true);
    expect(config.charge.has("ccbot")).toBe(true);
  });
});

describe("normalizeConfig validation", () => {
  it("rejects an unknown mode", () => {
    expect(() => normalizeConfig({ mode: "bill-everyone" as never })).toThrow(/mode must be/);
  });

  it("rejects an unknown confidence level", () => {
    expect(() => normalizeConfig({ minConfidenceToCharge: "very-sure" as never })).toThrow(
      /minConfidenceToCharge/,
    );
  });

  it("rejects route patterns that are not pathnames", () => {
    expect(() => normalizeConfig({ routes: { "api/*": "$0.01" } })).toThrow(/must start with/);
    expect(() => normalizeConfig({ routes: { "": "$0.01" } })).toThrow(/empty pattern/);
  });

  it("adds free paths to the defaults instead of replacing them", () => {
    // Replacing would make `free: ["/about"]` quietly start charging for
    // robots.txt, the file that declares the crawling policy.
    const config = normalizeConfig({ free: ["/about"] });
    for (const path of ["/about", "/robots.txt", "/sitemap.xml", "/.well-known/ai.txt"]) {
      expect(config.freeMatchers.some((m) => m(path)), path).toBe(true);
    }
  });

  it("rejects free entries that are not pathnames", () => {
    expect(() => normalizeConfig({ free: ["robots.txt"] })).toThrow(/must be pathname patterns/);
  });

  it("rejects an agent listed in both allow and charge", () => {
    expect(() => normalizeConfig({ allow: ["gptbot"], charge: ["gptbot"] })).toThrow(
      /both allow and charge/,
    );
  });

  it("rejects a non-positive session TTL", () => {
    expect(() => normalizeConfig({ session: { ttlSeconds: 0 } })).toThrow(/positive integer/);
    expect(() => normalizeConfig({ session: { ttlSeconds: 1.5 } })).toThrow(/positive integer/);
  });
});

describe("enforce mode readiness", () => {
  it("names every missing field at once", () => {
    let message = "";
    try {
      normalizeConfig({ mode: "enforce" });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const field of ["payTo", "network", "facilitator", "session.secret", "price or routes"]) {
      expect(message).toContain(field);
    }
  });

  it("points at observe mode as the way out", () => {
    expect(() => normalizeConfig({ mode: "enforce" })).toThrow(/mode "observe"/);
  });

  it("accepts a complete enforce config", () => {
    expect(() => normalizeConfig({ ...ENFORCE_BASE, price: "$0.01" })).not.toThrow();
  });

  it("accepts routes with no default price", () => {
    expect(() =>
      normalizeConfig({ ...ENFORCE_BASE, routes: { "/api/*": "$0.05" } }),
    ).not.toThrow();
  });

  it("does not require payment fields in observe mode", () => {
    expect(() => normalizeConfig({ mode: "observe", price: "$0.01" })).not.toThrow();
  });
});

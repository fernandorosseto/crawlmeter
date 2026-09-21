import { describe, expect, it } from "vitest";

import catalog from "../../src/data/agents.json" with { type: "json" };
import { AGENTS, CATALOG_VERSION, COMPILED_AGENTS, agentById } from "../../src/detect/agents.js";
import { isConfidence, meetsConfidence, type Confidence } from "../../src/types.js";

/**
 * The catalog is data, so it is validated as data. A bad row here does not
 * throw at import time — it silently mis-identifies traffic and mis-bills it,
 * which is why the check lives in CI rather than in the request path.
 */
describe("agents.json", () => {
  it("declares a review date", () => {
    expect(CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(CATALOG_VERSION))).toBe(false);
  });

  it("is not empty", () => {
    expect(AGENTS.length).toBeGreaterThan(0);
  });

  it("gives every agent a unique lowercase id", () => {
    const ids = catalog.agents.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toBe(id.toLowerCase());
      expect(id).not.toBe("");
    }
  });

  it("gives every agent an operator", () => {
    for (const agent of catalog.agents) {
      expect(agent.operator, agent.id).toBeTruthy();
      expect(agent.operator).toBe(agent.operator.toLowerCase());
    }
  });

  it("gives every agent a ua pattern that compiles", () => {
    for (const agent of catalog.agents) {
      expect(agent.uaPattern, agent.id).toBeTruthy();
      expect(() => new RegExp(agent.uaPattern, "i")).not.toThrow();
    }
  });

  it("gives every agent a valid maxConfidence", () => {
    for (const agent of catalog.agents) {
      expect(isConfidence(agent.maxConfidence), `${agent.id}: ${agent.maxConfidence}`).toBe(true);
    }
  });

  it("never claims signed-verified, which v0.1 cannot produce", () => {
    for (const agent of catalog.agents) {
      expect(agent.maxConfidence, agent.id).not.toBe("signed-verified");
    }
  });

  it("backs every ip-range ceiling with a published list", () => {
    for (const agent of catalog.agents) {
      if (meetsConfidence(agent.maxConfidence as Confidence, "ip-range")) {
        expect(agent.ipRangesUrl, agent.id).toBeTruthy();
        expect(agent.ipRangesFormat, agent.id).toBe("prefixes");
        expect(agent.ipRangesUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it("backs every rdns ceiling with reverse-dns suffixes", () => {
    for (const agent of catalog.agents) {
      if (meetsConfidence(agent.maxConfidence as Confidence, "rdns")) {
        expect(agent.rdnsSuffixes.length, agent.id).toBeGreaterThan(0);
      }
    }
  });

  it("does not promise a ceiling it has no evidence source for", () => {
    for (const agent of catalog.agents) {
      if (agent.ipRangesUrl === null) {
        expect(agent.maxConfidence, agent.id).toBe("ua-only");
      }
    }
  });

  it("gives every agent a docs link", () => {
    for (const agent of catalog.agents) {
      expect(agent.docs, agent.id).toMatch(/^https:\/\//);
    }
  });

  it("keeps the agents with no published ranges at ua-only", () => {
    // Named in CLAUDE.md as the reason minConfidenceToCharge defaults to
    // ip-range: these publish nothing, so they can never be billed by default.
    for (const id of ["ccbot", "meta-externalagent"]) {
      expect(agentById(id)?.maxConfidence, id).toBe("ua-only");
    }
  });

  it("omits robots.txt control tokens, which never appear as user agents", () => {
    // Google: "Google-Extended doesn't have a separate HTTP request user agent
    // string." Apple: "Applebot-Extended does not crawl webpages."
    // A row for either would match nothing and only inflate the catalog.
    expect(agentById("google-extended")).toBeNull();
    expect(agentById("applebot-extended")).toBeNull();
  });

  it("keeps applebot itself, which does publish both a list and a domain", () => {
    const applebot = agentById("applebot");
    expect(applebot?.ipRangesUrl).toBe("https://search.developer.apple.com/applebot.json");
    expect(applebot?.rdnsSuffixes).toContain("applebot.apple.com");
  });

  it("orders compiled agents most specific first", () => {
    const lengths = COMPILED_AGENTS.map((agent) => agent.uaPattern.length);
    const sorted = [...lengths].sort((a, b) => b - a);
    expect(lengths).toEqual(sorted);
  });

  it("looks agents up by id", () => {
    expect(agentById("gptbot")?.operator).toBe("openai");
    expect(agentById("nope")).toBeNull();
  });
});

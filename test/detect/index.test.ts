import { describe, expect, it, vi } from "vitest";

import { createDetector } from "../../src/detect/index.js";
import { parseCidr, type Cidr, type IpRangeCache } from "../../src/detect/ipRanges.js";
import type { DnsResolver } from "../../src/detect/rdns.js";
import { NOT_A_CRAWLER } from "../../src/types.js";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.4; +https://openai.com/gptbot)";

/** A range cache backed by fixed blocks, so no test touches the network. */
function ranges(blocks: readonly string[]): IpRangeCache & { get: ReturnType<typeof vi.fn> } {
  const parsed = blocks.map((block) => parseCidr(block)!) as readonly Cidr[];
  return { get: vi.fn(async () => parsed) } as IpRangeCache & { get: ReturnType<typeof vi.fn> };
}

/** A resolver that verifies `hostname` for `ip`, and nothing else. */
function resolver(ip: string, hostname: string): DnsResolver & { reverse: ReturnType<typeof vi.fn> } {
  return {
    reverse: vi.fn(async (address: string) => (address === ip ? [hostname] : [])),
    resolve: async (name: string) => (name === hostname ? [ip] : []),
  } as DnsResolver & { reverse: ReturnType<typeof vi.fn> };
}

describe("the fast path", () => {
  it("returns not-a-crawler for an ordinary browser", async () => {
    const detect = createDetector({ ipRanges: ranges([]), resolver: null });
    await expect(detect({ userAgent: CHROME, ip: "203.0.113.9" })).resolves.toEqual(NOT_A_CRAWLER);
  });

  it("does no network and no dns work for a request that is not a crawler", async () => {
    // The overwhelming majority of traffic takes this path. If it costs a
    // lookup, installing crawlmeter costs every visitor latency.
    const ipRanges = ranges(["20.171.0.0/16"]);
    const dns = resolver("203.0.113.9", "whatever.example");
    const detect = createDetector({ ipRanges, resolver: dns });

    await detect({ userAgent: CHROME, ip: "203.0.113.9" });

    expect(ipRanges.get).not.toHaveBeenCalled();
    expect(dns.reverse).not.toHaveBeenCalled();
  });
});

describe("escalation", () => {
  it("reports ua-only when nothing stronger applies", async () => {
    const detect = createDetector({ ipRanges: ranges([]), resolver: null });
    const identification = await detect({ userAgent: GPTBOT, ip: "203.0.113.9" });

    expect(identification.agent).toBe("gptbot");
    expect(identification.operator).toBe("openai");
    expect(identification.confidence).toBe("ua-only");
    expect(identification.evidence).toEqual(["ua:gptbot"]);
  });

  it("reaches ip-range when the address is in the published list", async () => {
    const detect = createDetector({ ipRanges: ranges(["20.171.0.0/16"]), resolver: null });
    const identification = await detect({ userAgent: GPTBOT, ip: "20.171.5.9" });

    expect(identification.confidence).toBe("ip-range");
    expect(identification.evidence).toEqual(["ua:gptbot", "ip:20.171.0.0/16"]);
  });

  it("stays at ua-only when the address is outside the published list", async () => {
    const detect = createDetector({ ipRanges: ranges(["20.171.0.0/16"]), resolver: null });
    const identification = await detect({ userAgent: GPTBOT, ip: "203.0.113.9" });

    expect(identification.confidence).toBe("ua-only");
  });

  it("reaches rdns when reverse and forward lookups agree", async () => {
    const ip = "66.249.66.1";
    const hostname = "crawl-66-249-66-1.googlebot.com";
    const detect = createDetector({ ipRanges: ranges([]), resolver: resolver(ip, hostname) });

    const identification = await detect({ userAgent: "GoogleOther/1.0", ip });

    expect(identification.confidence).toBe("rdns");
    expect(identification.evidence).toEqual(["ua:googleother", `rdns:${hostname}`]);
  });

  it("takes the strongest layer when several match", async () => {
    const ip = "66.249.66.1";
    const hostname = "crawl-66-249-66-1.googlebot.com";
    const detect = createDetector({
      ipRanges: ranges(["66.249.66.0/24"]),
      resolver: resolver(ip, hostname),
    });

    const identification = await detect({
      userAgent: "GoogleOther/1.0",
      ip,
      signature: { signature: "sig1=:x:", signatureInput: 'sig1=("@path")' },
    });

    expect(identification.confidence).toBe("rdns");
    // Every layer that matched is recorded, weakest first, so the operator can
    // see how the conclusion was reached.
    expect(identification.evidence).toEqual([
      "ua:googleother",
      "signature:present",
      "ip:66.249.66.0/24",
      `rdns:${hostname}`,
    ]);
  });

  it("records an unverified signature but ranks it below ip-range", async () => {
    const detect = createDetector({ ipRanges: ranges([]), resolver: null });
    const identification = await detect({
      userAgent: GPTBOT,
      ip: "203.0.113.9",
      signature: {
        signature: "sig1=:x:",
        signatureInput: 'sig1=("@path")',
        signatureAgent: '"https://openai.com"',
      },
    });

    expect(identification.confidence).toBe("signed-unverified");
    expect(identification.evidence).toContain("signature-agent:https://openai.com");
  });

  it("skips the rdns round trip once a stronger level is already established", async () => {
    // Nothing above rdns exists in v0.1, so this only fires when the agent has
    // no suffixes — but the guard is what keeps the DNS cost off the path the
    // day signed-verified lands.
    const dns = resolver("20.171.5.9", "nope.example");
    const detect = createDetector({ ipRanges: ranges(["20.171.0.0/16"]), resolver: dns });

    const identification = await detect({ userAgent: GPTBOT, ip: "20.171.5.9" });

    expect(identification.confidence).toBe("ip-range");
    expect(dns.reverse).not.toHaveBeenCalled();
  });
});

describe("the catalog ceiling", () => {
  it("holds an agent to the maxConfidence its catalog row declares", async () => {
    // CCBot publishes no ranges, so it can never rise above ua-only. Sending
    // signature headers must not buy it a higher level.
    const detect = createDetector({ ipRanges: ranges([]), resolver: null });
    const identification = await detect({
      userAgent: "CCBot/2.0 (https://commoncrawl.org/faq/)",
      ip: "203.0.113.9",
      signature: { signature: "sig1=:x:", signatureInput: 'sig1=("@path")' },
    });

    expect(identification.confidence).toBe("ua-only");
    expect(identification.evidence).toContain("capped-by-catalog:ua-only");
  });

  it("does not fetch a published list for an agent that has none", async () => {
    const ipRanges = ranges(["203.0.113.0/24"]);
    const detect = createDetector({ ipRanges, resolver: null });

    await detect({ userAgent: "CCBot/2.0", ip: "203.0.113.9" });

    expect(ipRanges.get).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("degrades instead of discarding when the range cache rejects", async () => {
    // A broken lookup must cost precision, not the whole identification. The
    // crawler was still recognised; it just cannot be proven this time.
    const detect = createDetector({
      ipRanges: {
        get: async () => {
          throw new Error("boom");
        },
      },
      resolver: null,
    });

    const identification = await detect({ userAgent: GPTBOT, ip: "20.171.5.9" });
    expect(identification.agent).toBe("gptbot");
    expect(identification.confidence).toBe("ua-only");
    expect(identification.evidence).toContain("ip-range:unavailable");
  });

  it("degrades to ua-only when the resolver rejects", async () => {
    const detect = createDetector({
      ipRanges: ranges([]),
      resolver: {
        reverse: async () => {
          throw new Error("SERVFAIL");
        },
        resolve: async () => [],
      },
    });

    const identification = await detect({ userAgent: "GoogleOther/1.0", ip: "66.249.66.1" });
    expect(identification.confidence).toBe("ua-only");
  });

  it("degrades to ua-only when there is no resolver at all", async () => {
    // This is the edge-runtime case: no node:dns, so no rdns layer.
    const detect = createDetector({ ipRanges: ranges([]), resolver: null });
    const identification = await detect({ userAgent: "GoogleOther/1.0", ip: "66.249.66.1" });
    expect(identification.confidence).toBe("ua-only");
  });

  it("does not break on a malformed address", async () => {
    const detect = createDetector({ ipRanges: ranges(["20.171.0.0/16"]), resolver: null });
    const identification = await detect({ userAgent: GPTBOT, ip: "not-an-ip" });
    expect(identification.confidence).toBe("ua-only");
  });

  it("does not break when there is no address at all", async () => {
    const detect = createDetector({ ipRanges: ranges(["20.171.0.0/16"]), resolver: null });
    const identification = await detect({ userAgent: GPTBOT });
    expect(identification.confidence).toBe("ua-only");
  });
});

describe("independence from mode", () => {
  it("escalates without being told anything about observe or enforce", async () => {
    // Load-bearing: observe is a dry-run of enforce, so detection must produce
    // the same identification in both. If escalation were skipped in observe to
    // save a round trip, every hit would sit at ua-only, fall under the default
    // minConfidenceToCharge, and the reported potential revenue would be zero
    // forever — which is the one number the product exists to show.
    const detect = createDetector({ ipRanges: ranges(["20.171.0.0/16"]), resolver: null });
    const identification = await detect({ userAgent: GPTBOT, ip: "20.171.5.9" });

    expect(identification.confidence).toBe("ip-range");
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  createIpRangeCache,
  inAnyCidr,
  inCidr,
  parseCidr,
  parseIp,
  parsePrefixDocument,
  type FetchLike,
} from "../../src/detect/ipRanges.js";

/** Assert `ip` is inside `cidr`, parsing both. */
function contains(cidr: string, ip: string): boolean {
  const block = parseCidr(cidr);
  const address = parseIp(ip);
  if (block === null || address === null) throw new Error(`unparseable: ${cidr} / ${ip}`);
  return inCidr(address, block);
}

describe("parseIp", () => {
  it("parses ipv4 and ipv6", () => {
    expect(parseIp("20.171.0.1")).not.toBeNull();
    expect(parseIp("2001:4860:4801:2008::1")).not.toBeNull();
    expect(parseIp("::1")).not.toBeNull();
    expect(parseIp("::")).not.toBeNull();
  });

  it("rejects malformed addresses", () => {
    expect(parseIp("")).toBeNull();
    expect(parseIp("20.171.0")).toBeNull();
    expect(parseIp("20.171.0.256")).toBeNull();
    expect(parseIp("2001::db8::1")).toBeNull();
    expect(parseIp("not-an-ip")).toBeNull();
    expect(parseIp("gggg::1")).toBeNull();
  });

  it("reads an ipv4-mapped ipv6 address as the ipv4 address", () => {
    expect(parseIp("::ffff:20.171.0.1")).toEqual(parseIp("20.171.0.1"));
  });

  it("ignores a zone id", () => {
    expect(parseIp("fe80::1%eth0")).toEqual(parseIp("fe80::1"));
  });
});

describe("inCidr", () => {
  it("matches an address inside an ipv4 block", () => {
    expect(contains("20.171.0.0/16", "20.171.5.9")).toBe(true);
    expect(contains("20.171.0.0/16", "20.172.5.9")).toBe(false);
  });

  it("matches an address inside an ipv6 block", () => {
    expect(contains("2001:4860:4801:2008::/64", "2001:4860:4801:2008::5")).toBe(true);
    expect(contains("2001:4860:4801:2008::/64", "2001:4860:4801:2009::5")).toBe(false);
  });

  it("includes both edges of a block", () => {
    expect(contains("20.171.0.0/24", "20.171.0.0")).toBe(true);
    expect(contains("20.171.0.0/24", "20.171.0.255")).toBe(true);
    expect(contains("20.171.0.0/24", "20.171.1.0")).toBe(false);
  });

  it("handles a single-host /32, which is most of what operators publish", () => {
    expect(contains("107.20.236.150/32", "107.20.236.150")).toBe(true);
    expect(contains("107.20.236.150/32", "107.20.236.151")).toBe(false);
  });

  it("handles a prefix that does not fall on a byte boundary", () => {
    expect(contains("172.182.202.0/25", "172.182.202.127")).toBe(true);
    expect(contains("172.182.202.0/25", "172.182.202.128")).toBe(false);
  });

  it("matches an ipv4-mapped address against an ipv4 block", () => {
    // Same host, arriving over a dual stack.
    expect(contains("20.171.0.0/16", "::ffff:20.171.5.9")).toBe(true);
  });

  it("never matches a real ipv6 address against an ipv4 block", () => {
    const block = parseCidr("0.0.0.0/0");
    const address = parseIp("2001:4860::1");
    expect(block).not.toBeNull();
    expect(address).not.toBeNull();
    expect(inCidr(address!, block!)).toBe(false);
  });
});

describe("parseCidr", () => {
  it("rejects malformed blocks without throwing", () => {
    expect(parseCidr("20.171.0.0")).toBeNull();
    expect(parseCidr("20.171.0.0/33")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
    expect(parseCidr("20.171.0.0/abc")).toBeNull();
    expect(parseCidr("/24")).toBeNull();
  });

  it("keeps the published text for evidence", () => {
    expect(parseCidr("20.171.0.0/16")?.source).toBe("20.171.0.0/16");
  });
});

describe("parsePrefixDocument", () => {
  const document = {
    creationTime: "2026-09-18T14:46:15.000000",
    prefixes: [
      { ipv4Prefix: "20.171.0.0/16" },
      { ipv6Prefix: "2001:4860:4801:2008::/64" },
      { ipv4Prefix: "not-a-prefix" },
      { somethingElse: true },
      null,
    ],
  };

  it("reads the published shape used by every operator so far", () => {
    const blocks = parsePrefixDocument(document);
    expect(blocks.map((block) => block.source)).toEqual([
      "20.171.0.0/16",
      "2001:4860:4801:2008::/64",
    ]);
  });

  it("drops bad rows instead of rejecting the whole list", () => {
    expect(parsePrefixDocument(document)).toHaveLength(2);
  });

  it("returns an empty list for anything that is not the expected shape", () => {
    expect(parsePrefixDocument(null)).toEqual([]);
    expect(parsePrefixDocument("nope")).toEqual([]);
    expect(parsePrefixDocument({})).toEqual([]);
    expect(parsePrefixDocument({ prefixes: "nope" })).toEqual([]);
  });
});

describe("createIpRangeCache", () => {
  const URL = "https://openai.com/gptbot.json";

  function okFetch(prefixes: readonly string[]): FetchLike {
    return vi.fn(async () => ({
      ok: true,
      json: async () => ({ prefixes: prefixes.map((ipv4Prefix) => ({ ipv4Prefix })) }),
    }));
  }

  it("fetches a list and matches against it", async () => {
    const cache = createIpRangeCache({ fetch: okFetch(["20.171.0.0/16"]) });
    const blocks = await cache.get(URL);
    expect(inAnyCidr(parseIp("20.171.5.9")!, blocks)).toBe(true);
  });

  it("reuses the list inside the ttl", async () => {
    const fetchImpl = okFetch(["20.171.0.0/16"]);
    let now = 1_000;
    const cache = createIpRangeCache({ fetch: fetchImpl, ttlMs: 10_000, now: () => now });

    await cache.get(URL);
    now += 5_000;
    await cache.get(URL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 10_000;
    await cache.get(URL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent misses into one request", async () => {
    const fetchImpl = okFetch(["20.171.0.0/16"]);
    const cache = createIpRangeCache({ fetch: fetchImpl });
    await Promise.all([cache.get(URL), cache.get(URL), cache.get(URL)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("makes no request at all when fetch is disabled", async () => {
    const cache = createIpRangeCache({ fetch: null });
    await expect(cache.get(URL)).resolves.toEqual([]);
  });

  it("degrades instead of throwing when the fetch fails", async () => {
    const cache = createIpRangeCache({
      fetch: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await expect(cache.get(URL)).resolves.toEqual([]);
  });

  it("degrades on a non-ok response", async () => {
    const cache = createIpRangeCache({
      fetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    });
    await expect(cache.get(URL)).resolves.toEqual([]);
  });

  it("does not hammer a failing endpoint on every request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    let now = 1_000;
    const cache = createIpRangeCache({ fetch: fetchImpl, retryAfterMs: 60_000, now: () => now });

    await cache.get(URL);
    now += 1_000;
    await cache.get(URL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 60_000;
    await cache.get(URL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

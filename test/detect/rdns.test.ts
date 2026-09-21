import { describe, expect, it, vi } from "vitest";

import { endsWithSuffix, verifyRdns, type DnsResolver } from "../../src/detect/rdns.js";

const GOOGLE = ["googlebot.com", "geo.googlebot.com"];

/** A resolver backed by a fixed map, so no test touches DNS. */
function resolver(
  ptr: Record<string, readonly string[]>,
  forward: Record<string, readonly string[]>,
): DnsResolver {
  return {
    reverse: async (ip) => ptr[ip] ?? [],
    resolve: async (hostname) => forward[hostname] ?? [],
  };
}

describe("endsWithSuffix", () => {
  it("accepts the domain itself and anything under it", () => {
    expect(endsWithSuffix("crawl-66-249-66-1.googlebot.com", GOOGLE)).toBe(true);
    expect(endsWithSuffix("googlebot.com", GOOGLE)).toBe(true);
  });

  it("rejects a domain that merely ends with the same letters", () => {
    // The dot is the whole defence. Without it anyone can register
    // `notgooglebot.com` and mint an identity.
    expect(endsWithSuffix("notgooglebot.com", GOOGLE)).toBe(false);
    expect(endsWithSuffix("googlebot.com.evil.example", GOOGLE)).toBe(false);
  });

  it("ignores case and a trailing root dot", () => {
    expect(endsWithSuffix("Crawl-1.GoogleBot.com.", GOOGLE)).toBe(true);
  });
});

describe("verifyRdns", () => {
  const ip = "66.249.66.1";
  const hostname = "crawl-66-249-66-1.googlebot.com";

  it("verifies a reverse lookup confirmed by a forward lookup", async () => {
    const result = await verifyRdns(
      ip,
      GOOGLE,
      resolver({ [ip]: [hostname] }, { [hostname]: [ip] }),
    );
    expect(result).toEqual({ verified: true, hostname });
  });

  it("does not verify a name under another operator's domain", async () => {
    const other = "crawl-1.bing.com";
    const result = await verifyRdns(
      ip,
      GOOGLE,
      resolver({ [ip]: [other] }, { [other]: [ip] }),
    );
    expect(result.verified).toBe(false);
  });

  it("does not verify without forward confirmation", async () => {
    // A PTR record proves nothing on its own: whoever controls the address can
    // point it at any name they like.
    const result = await verifyRdns(
      ip,
      GOOGLE,
      resolver({ [ip]: [hostname] }, { [hostname]: ["1.2.3.4"] }),
    );
    expect(result.verified).toBe(false);
  });

  it("does not verify when the forward lookup returns nothing", async () => {
    const result = await verifyRdns(ip, GOOGLE, resolver({ [ip]: [hostname] }, {}));
    expect(result.verified).toBe(false);
  });

  it("compares addresses by value, not by notation", async () => {
    const v6 = "2001:4860:4801:2008::1";
    const name = "crawl-1.googlebot.com";
    const result = await verifyRdns(
      v6,
      GOOGLE,
      resolver({ [v6]: [name] }, { [name]: ["2001:4860:4801:2008:0:0:0:1"] }),
    );
    expect(result.verified).toBe(true);
  });

  it("degrades when the resolver throws", async () => {
    const broken: DnsResolver = {
      reverse: async () => {
        throw new Error("SERVFAIL");
      },
      resolve: async () => [],
    };
    await expect(verifyRdns(ip, GOOGLE, broken)).resolves.toEqual({
      verified: false,
      hostname: null,
    });
  });

  it("degrades when the lookup runs past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const slow: DnsResolver = {
        reverse: () => new Promise(() => {}),
        resolve: async () => [],
      };
      const pending = verifyRdns(ip, GOOGLE, slow, 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toEqual({ verified: false, hostname: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when the agent publishes no suffixes", async () => {
    const spy = vi.fn(async () => [hostname]);
    const unused: DnsResolver = { reverse: spy, resolve: async () => [] };
    await verifyRdns(ip, [], unused);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing for an unparseable address", async () => {
    const spy = vi.fn(async () => [hostname]);
    const unused: DnsResolver = { reverse: spy, resolve: async () => [] };
    const result = await verifyRdns("not-an-ip", GOOGLE, unused);
    expect(result.verified).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

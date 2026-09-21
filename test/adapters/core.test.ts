import { describe, expect, it, vi } from "vitest";

import {
  clientAddress,
  createEngine,
  normalizeTrustProxy,
  pathOf,
  resourceUrl,
} from "../../src/adapters/core.js";
import type { Detector } from "../../src/detect/index.js";
import { ConfigError } from "../../src/config.js";
import { createMemoryStore } from "../../src/store/memory.js";

/**
 * The engine both adapters share. The address tests here are the ones that
 * matter most: they decide whether `ip-range` — the strongest signal crawlmeter
 * has — can be forged with a single request header.
 */

const OPENAI_IP = "132.196.86.5"; // inside openai.com/gptbot.json
const REAL_CLIENT = "203.0.113.9";
const PROXY = "10.0.0.2";

describe("clientAddress", () => {
  it("uses the socket when no proxy is trusted", () => {
    expect(clientAddress({ "x-forwarded-for": OPENAI_IP }, PROXY, 0)).toBe(PROXY);
  });

  it("reads the entry a single trusted proxy appended, not what the client wrote", () => {
    // The attack: a scraper sends X-Forwarded-For with an address inside
    // OpenAI's published range. nginx, AWS load balancers, Cloudflare and Fly
    // all APPEND the real peer to it. Reading the leftmost entry would identify
    // the scraper as GPTBot at ip-range confidence.
    const headers = { "x-forwarded-for": `${OPENAI_IP}, ${REAL_CLIENT}` };
    expect(clientAddress(headers, PROXY, 1)).toBe(REAL_CLIENT);
  });

  it("reads the only entry when the proxy overwrites the header", () => {
    // Vercel overwrites X-Forwarded-For with the real client address.
    expect(clientAddress({ "x-forwarded-for": REAL_CLIENT }, null, 1)).toBe(REAL_CLIENT);
  });

  it("counts hops from the right when several proxies are trusted", () => {
    // CDN in front of a load balancer: the CDN appends the client, the load
    // balancer appends the CDN.
    const headers = { "x-forwarded-for": `${OPENAI_IP}, ${REAL_CLIENT}, 198.51.100.7` };
    expect(clientAddress(headers, PROXY, 2)).toBe(REAL_CLIENT);
  });

  it("falls back to the socket when the chain is shorter than the config claims", () => {
    // The trusted proxies would each have appended an entry. If they did not,
    // the header is not what the config says it is, and cannot be believed.
    expect(clientAddress({ "x-forwarded-for": OPENAI_IP }, PROXY, 2)).toBe(PROXY);
  });

  it("falls back to the socket when the header is missing", () => {
    expect(clientAddress({}, PROXY, 1)).toBe(PROXY);
  });

  it("tolerates spacing and empty entries", () => {
    expect(clientAddress({ "x-forwarded-for": ` ${OPENAI_IP} ,, ${REAL_CLIENT} ` }, PROXY, 1)).toBe(
      REAL_CLIENT,
    );
  });
});

describe("normalizeTrustProxy", () => {
  it("reads true as one proxy and false as none", () => {
    expect(normalizeTrustProxy(true)).toBe(1);
    expect(normalizeTrustProxy(false)).toBe(0);
    expect(normalizeTrustProxy(3)).toBe(3);
  });

  it("refuses anything that is not a whole number of proxies, at boot", () => {
    expect(() => normalizeTrustProxy(-1)).toThrow(ConfigError);
    expect(() => normalizeTrustProxy(1.5)).toThrow(ConfigError);
    expect(() => createEngine({ trustProxy: -1 }, { trustProxy: false })).toThrow(ConfigError);
  });
});

describe("resourceUrl", () => {
  it("uses the protocol written by the nearest trusted proxy", () => {
    const request = {
      method: "GET",
      url: "/a?b=1",
      headers: { host: "example.com", "x-forwarded-proto": "http, https" },
      socketAddress: null,
      protocol: "http",
    };
    expect(resourceUrl(request, 1)).toBe("https://example.com/a");
    expect(resourceUrl(request, 0)).toBe("http://example.com/a");
  });
});

describe("pathOf", () => {
  it("drops the query string and fragment", () => {
    expect(pathOf("/blog/hello?utm=x#top")).toBe("/blog/hello");
    expect(pathOf("")).toBe("/");
  });
});

describe("the engine", () => {
  it("identifies against the address a trusted proxy wrote", async () => {
    const seen: Array<string | null | undefined> = [];
    const detector: Detector = (input) => {
      seen.push(input.ip);
      return Promise.resolve({ agent: "gptbot", operator: "openai", confidence: "ua-only", evidence: [] });
    };
    const engine = createEngine({ detector, trustProxy: true }, { trustProxy: false });

    await engine.handle({
      method: "GET",
      url: "/",
      headers: { "user-agent": "GPTBot/1.4", "x-forwarded-for": `${OPENAI_IP}, ${REAL_CLIENT}` },
      socketAddress: PROXY,
      protocol: "http",
    });

    expect(seen).toEqual([REAL_CLIENT]);
  });

  it("uses the adapter's default when trustProxy is not set", () => {
    expect(createEngine({}, { trustProxy: false }).trustProxy).toBe(0);
    expect(createEngine({}, { trustProxy: true }).trustProxy).toBe(1);
    expect(createEngine({ trustProxy: false }, { trustProxy: true }).trustProxy).toBe(0);
  });

  it("never throws, even when detection and the store both fail", async () => {
    const onError = vi.fn();
    const engine = createEngine(
      {
        price: "$0.01",
        detector: () => Promise.reject(new Error("dns exploded")),
        store: {
          record() {
            throw new Error("disk full");
          },
          summary: () => Promise.reject(new Error("disk full")),
          flush: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        onError,
      },
      { trustProxy: false },
    );

    const handled = await engine.handle({
      method: "GET",
      url: "/",
      headers: { "user-agent": "GPTBot/1.4" },
      socketAddress: REAL_CLIENT,
      protocol: "http",
    });
    expect(handled.answer).toEqual({ kind: "pass", headers: {} });
    expect(() => handled.record(10)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("records a size of null as unmeasured, not as zero", async () => {
    const store = createMemoryStore();
    const engine = createEngine(
      {
        price: "$0.01",
        store,
        detector: () =>
          Promise.resolve({ agent: "gptbot", operator: "openai", confidence: "ip-range", evidence: [] }),
      },
      { trustProxy: false },
    );
    const handled = await engine.handle({
      method: "GET",
      url: "/",
      headers: { "user-agent": "GPTBot/1.4" },
      socketAddress: REAL_CLIENT,
      protocol: "http",
    });
    handled.record(null);

    expect(store.events[0]?.bytes).toBeNull();
  });
});

describe("the x402 option", () => {
  const ENFORCE = {
    mode: "enforce" as const,
    price: "$0.01",
    payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    network: "eip155:84532",
    facilitator: "http://127.0.0.1:9",
    session: { secret: "s" },
  };

  it("reports an incompatible x402 through ready, instead of breaking startup", async () => {
    // Modules from an x402 version too far from the one crawlmeter was built
    // against. The app must still start and serve; the operator must be told.
    const onWarning = vi.fn();
    const engine = createEngine(
      { ...ENFORCE, x402: { server: {}, http: {}, types: {}, scheme: {} }, onWarning },
      { trustProxy: false },
    );

    await expect(engine.ready).rejects.toThrow(/does not export/);
    await new Promise((settle) => setTimeout(settle, 10));
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("does not export"));
  });

  it("is ignored in observe mode, where nothing is ever loaded", async () => {
    const engine = createEngine(
      { price: "$0.01", x402: { server: {}, http: {}, types: {}, scheme: {} } },
      { trustProxy: false },
    );
    await expect(engine.ready).resolves.toBeUndefined();
  });
});

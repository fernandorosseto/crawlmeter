import { afterEach, describe, expect, it, vi } from "vitest";

import catalog from "../src/data/agents.json" with { type: "json" };
import { createDetector } from "../src/detect/index.js";

/**
 * crawlmeter never phones home.
 *
 * The only outbound request the package is allowed to make is fetching the CIDR
 * lists operators publish about themselves — every one of them named in
 * `agents.json`, reviewable in a diff. No analytics, no "anonymous usage", no
 * license check. Trust is the asset; one undeclared request spends it.
 */

const ALLOWED_HOSTS = new Set(
  catalog.agents
    .map((agent) => agent.ipRangesUrl)
    .filter((url): url is string => typeof url === "string")
    .map((url) => new URL(url).host),
);

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const GPTBOT = "GPTBot/1.4";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Replace global fetch with a recorder that answers with an empty list. */
function recordFetches(): string[] {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    return { ok: true, json: async () => ({ prefixes: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("outbound traffic", () => {
  it("only ever reaches hosts declared in agents.json", async () => {
    const calls = recordFetches();
    // No injected cache: this exercises the real default, which is what ships.
    const detect = createDetector({ resolver: null });

    await detect({ userAgent: GPTBOT, ip: "20.171.5.9" });
    await detect({ userAgent: "ClaudeBot/1.0", ip: "20.171.5.9" });
    await detect({ userAgent: "PerplexityBot/1.0", ip: "20.171.5.9" });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(ALLOWED_HOSTS.has(new URL(call).host), call).toBe(true);
    }
  });

  it("makes no request at all for a request that is not a crawler", async () => {
    const calls = recordFetches();
    const detect = createDetector({ resolver: null });

    await detect({ userAgent: CHROME, ip: "203.0.113.9" });

    expect(calls).toEqual([]);
  });

  it("makes no request at all when range fetching is turned off", async () => {
    const calls = recordFetches();
    const detect = createDetector({ ipRanges: null, resolver: null });

    await detect({ userAgent: GPTBOT, ip: "20.171.5.9" });

    expect(calls).toEqual([]);
  });

  it("makes no request for an agent whose operator publishes no list", async () => {
    const calls = recordFetches();
    const detect = createDetector({ resolver: null });

    await detect({ userAgent: "CCBot/2.0", ip: "203.0.113.9" });

    expect(calls).toEqual([]);
  });
});

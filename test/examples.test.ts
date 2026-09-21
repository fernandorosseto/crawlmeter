import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createServer } from "../examples/express-observe/server.js";

/**
 * The example is the quickstart.
 *
 * It is the first code anyone runs and the block that goes on the README's
 * first screen, so it is tested like anything else. A quickstart that does not
 * boot breaks the only promise the project makes on install: five minutes to a
 * number.
 */

let server: Server | null = null;
const originalFetch = globalThis.fetch;

/** Every outbound host the example reached, other than its own socket. */
let outbound: string[] = [];

beforeEach(() => {
  // The example uses the real detector, on purpose — it is the quickstart, and
  // stubbing detection would stop testing what people actually run. But CI must
  // not depend on openai.com being up, so calls that leave the machine are
  // answered here with an empty list. Detection degrades to ua-only, which is
  // exactly what it does when an operator's endpoint is down.
  outbound = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.includes("127.0.0.1") || url.includes("localhost")) {
      return originalFetch(input, init);
    }
    outbound.push(new URL(url).host);
    return Promise.resolve(
      new Response(JSON.stringify({ prefixes: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const current = server;
  server = null;
  if (current !== null) {
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });
  }
});

async function start(): Promise<string> {
  const app = createServer() as { listen: (port: number, host: string, cb: () => void) => Server };
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Give the response time to be recorded. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("the express-observe example", () => {
  it("boots and serves content", async () => {
    const url = await start();
    const response = await fetch(`${url}/blog/hello`, { headers: { "user-agent": "GPTBot/1.4" } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");
  });

  it("blocks nothing, which is what observe mode means", async () => {
    const url = await start();
    const response = await fetch(`${url}/api/things`, { headers: { "user-agent": "GPTBot/1.4" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ things: ["one", "two", "three"] });
  });

  it("reports what the crawler traffic would have been worth", async () => {
    const url = await start();
    await fetch(`${url}/blog/hello`, { headers: { "user-agent": "GPTBot/1.4" } });
    await fetch(`${url}/api/things`, { headers: { "user-agent": "GPTBot/1.4" } });
    await settle();

    const report = await (await fetch(`${url}/report`)).text();

    // Two crawler hits. The /report request itself is a browser, so it takes
    // the fast path and is never recorded.
    expect(report).toContain("AI crawlers made 2 requests");
    expect(report).toMatch(/gptbot\s+openai\s+2/);
    // From localhost, GPTBot cannot be proven, so the report says why the
    // headline is zero instead of leaving the operator to guess.
    expect(report).toContain("identity not proven strongly enough to bill");
  });

  it("phones home to nobody", async () => {
    // The only outbound traffic the package is allowed to make is fetching the
    // IP ranges operators publish about themselves.
    const url = await start();
    await fetch(`${url}/blog/hello`, { headers: { "user-agent": "GPTBot/1.4" } });
    await settle();

    expect(outbound).toEqual(["openai.com"]);
  });

  it("records nothing for ordinary visitors", async () => {
    const url = await start();
    await fetch(`${url}/blog/hello`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      },
    });
    await settle();

    const report = await (await fetch(`${url}/report`)).text();
    expect(report).toContain("AI crawlers made 0 requests");
  });
});

describe("the next-observe example", () => {
  it("loads as shipped, builds its proxy, and warns about nothing", async () => {
    // The example opens a SQLite file; point it somewhere disposable before
    // the module runs.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "crawlmeter-next-example-"));
    process.env["CRAWLMETER_DB"] = join(dir, "crawlmeter.db");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const example = (await import("../examples/next-observe/proxy.js")) as {
        proxy: ((request: unknown) => unknown) & { store: { close(): Promise<void> } };
        config: { matcher: string[] };
      };

      expect(typeof example.proxy).toBe("function");
      // Next's own static assets are skipped; robots.txt is not.
      expect(example.config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico).*)"]);
      // A persistent store was given and the proxy header is trusted: neither
      // of the setup warnings applies.
      expect(warn).not.toHaveBeenCalled();

      const { NextRequest } = await import("next/server.js");
      const browser = example.proxy(
        new NextRequest("https://example.com/blog/hello", { headers: { "user-agent": "Mozilla/5.0" } }),
      );
      expect(browser).toBeUndefined();

      await example.proxy.store.close();
    } finally {
      warn.mockRestore();
      delete process.env["CRAWLMETER_DB"];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

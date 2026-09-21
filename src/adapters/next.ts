/**
 * Next.js proxy (the file formerly known as middleware).
 *
 *     // proxy.ts
 *     import { crawlmeter } from "crawlmeter/next";
 *     export const proxy = crawlmeter({ price: "$0.01", store: ... });
 *
 * Imported from `crawlmeter/next`, not from `crawlmeter`, because it imports
 * `next/server`. Keeping it off the main entry point means nobody who does not
 * use Next.js ever loads — or needs to install — Next.js.
 *
 * Like the Express middleware, this is a thin translator around the engine in
 * `./core.ts`. What differs is the platform, in four ways that shape the
 * defaults:
 *
 * 1. **There is no socket.** `NextRequest.ip` was removed in Next.js 15, and the
 *    proxy never sees the TCP peer. `X-Forwarded-For` is the only source of a
 *    client address, so `trustProxy` defaults to ONE hop here — the inverse of
 *    Express. On Vercel that header is written by the platform and cannot be
 *    spoofed; behind nginx, a load balancer or Cloudflare the trusted entry is
 *    the one the proxy appended. The exception is `next start` exposed straight
 *    to the internet with nothing in front of it: Next.js only fills the header
 *    when the client did not send one (`??=` in its base server), so there the
 *    address is whatever the client claims, and `ip-range` confidence can be
 *    forged. Put a proxy in front — you need one for TLS anyway.
 * 2. **The proxy never sees the page.** It runs before the route renders, so the
 *    size of what the app sends is unknowable here. Passed requests are recorded
 *    with `bytes: null` — unmeasured, not zero. 402s, which this code answers
 *    itself, are measured.
 * 3. **The proxy is isolated from the app.** Next.js documents that it runs
 *    separately from render code and does not guarantee shared modules or
 *    globals. An in-memory store in the proxy cannot be read by the app, and on
 *    serverless hosts it vanishes with the instance. Use a persistent store;
 *    crawlmeter warns once if none is given.
 * 4. **The instance may be frozen once the response returns.** Writes are handed
 *    to `event.waitUntil` so they land before that happens.
 */

// "next/server.js", not "next/server": Next.js ships no `exports` map, so the
// extensionless path resolves only inside a bundler. With the extension it
// resolves everywhere — in Next's own build, and in plain Node ESM.
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server.js";

import type { NormalizedConfig } from "../config.js";
import type { Store } from "../store/types.js";
import { createEngine, type EngineOptions } from "./core.js";

export type CrawlmeterProxyOptions = EngineOptions;

export interface CrawlmeterProxy {
  (request: NextRequest, event?: NextFetchEvent): NextResponse | undefined | Promise<NextResponse | undefined>;
  /** The store in use. Read it from the CLI, not from the app — see point 3 above. */
  readonly store: Store;
  readonly config: NormalizedConfig;
  /** See `CrawlmeterMiddleware.ready` in the Express adapter. */
  readonly ready: Promise<void>;
}

/** Emitted once when the proxy is built without a persistent store. */
export const MEMORY_STORE_WARNING =
  "crawlmeter/next: no store was given, so decisions go to an in-memory store inside the Next.js proxy. " +
  "Next.js runs the proxy separately from your app and does not guarantee shared state, so nothing else " +
  "can reliably read it, and on serverless hosts it disappears with the instance. Pass a persistent store: " +
  "createSqliteStore on a server with a disk, createPostgresStore on Vercel.";

/** Emitted once when the proxy is told to trust no proxy — which leaves it no address at all. */
export const NO_ADDRESS_WARNING =
  "crawlmeter/next: trustProxy is off, but the Next.js proxy has no socket address — X-Forwarded-For is " +
  "the only source of the client address. Identification cannot rise above \"ua-only\" and reported " +
  "potential revenue will stay at zero. Remove trustProxy: false unless you really mean it.";

export function crawlmeter(options: CrawlmeterProxyOptions = {}): CrawlmeterProxy {
  const engine = createEngine(options, { trustProxy: true });

  // Both are setup mistakes that make crawlmeter record nothing useful while
  // appearing to work. Said once, at startup, rather than never.
  if (engine.trustProxy === 0) warn(NO_ADDRESS_WARNING);
  if (options.store === undefined) warn(MEMORY_STORE_WARNING);

  function warn(message: string): void {
    try {
      engine.onWarning(message);
    } catch (error) {
      engine.onError?.(error);
    }
  }

  const proxy = (
    request: NextRequest,
    event?: NextFetchEvent,
  ): NextResponse | undefined | Promise<NextResponse | undefined> => {
    // The fast path. Returning nothing lets the request through untouched, and
    // doing it synchronously costs a human visitor nothing at all.
    if (!engine.isCrawler(request.headers.get("user-agent"))) return undefined;
    return serve(request, event);
  };

  async function serve(request: NextRequest, event?: NextFetchEvent): Promise<NextResponse | undefined> {
    const handled = await engine.handle({
      method: request.method,
      url: request.nextUrl.pathname + request.nextUrl.search,
      // Fetch headers already have lowercase names.
      headers: Object.fromEntries(request.headers),
      socketAddress: null,
      protocol: request.nextUrl.protocol.replace(/:$/, "") || null,
    });

    let response: NextResponse | undefined;
    let bytes: number | null;
    try {
      const { answer } = handled;
      if (answer.kind === "respond") {
        response = new NextResponse(answer.body, { status: answer.status, headers: answer.headers });
        bytes = new TextEncoder().encode(answer.body).length;
      } else {
        const headers = Object.entries(answer.headers);
        if (headers.length > 0) {
          response = NextResponse.next();
          for (const [name, value] of headers) response.headers.set(name, value);
        }
        // The app renders the page after the proxy returns. Its size is not
        // something this code can know.
        bytes = null;
      }
    } catch (error) {
      // Last resort. If building the answer threw, the request goes through.
      engine.onError?.(error);
      response = undefined;
      bytes = null;
    }

    handled.record(bytes);
    try {
      // Keep a serverless instance alive until the write has landed.
      event?.waitUntil(engine.store.flush());
    } catch (error) {
      engine.onError?.(error);
    }
    return response;
  }

  return Object.assign(proxy, {
    store: engine.store,
    config: engine.config,
    ready: engine.ready,
  });
}

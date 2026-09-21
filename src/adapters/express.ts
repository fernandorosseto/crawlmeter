/**
 * Express middleware.
 *
 * A thin translator around the engine in `./core.ts`, which holds every
 * decision — identification, pricing, payment, fail-open. This file only turns
 * an Express request into an `EngineRequest` and the engine's answer back into
 * an Express response, and measures how many bytes went out.
 *
 * Two properties specific to Express:
 *
 * 1. **A request that is not a known crawler leaves synchronously.** No await,
 *    no promise tick, no store write. That is almost all traffic.
 * 2. **Proxy headers are not trusted by default.** Express has a real socket
 *    address, so the safe default is to use it. Behind a proxy, set
 *    `trustProxy` — crawlmeter warns once if it sees `X-Forwarded-For` while
 *    trusting none, because otherwise every crawler is identified by the
 *    proxy's address and the report reads zero.
 *
 * Express itself is not a dependency, not even a type-only one. The two
 * interfaces below are the entire surface this middleware touches.
 */

import type { NormalizedConfig } from "../config.js";
import { header, type HeaderBag, type HeaderSink } from "../headers.js";
import type { Store } from "../store/types.js";
import {
  PROXY_WARNING,
  clientAddress,
  createEngine,
  normalizeTrustProxy,
  pathOf as pathOfUrl,
  resourceUrl,
  type EngineOptions,
  type EngineRequest,
  type Handled,
} from "./core.js";

export { PROXY_WARNING };

/* -------------------------------------------------------------------------- */
/* The bits of Express this touches                                            */
/* -------------------------------------------------------------------------- */

export interface AdapterRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly headers: HeaderBag;
  /** `"http"` or `"https"`, as Express resolved it. Used for the 402's resource URL. */
  readonly protocol?: string | undefined;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

export interface AdapterResponse extends HeaderSink {
  statusCode: number;
  headersSent?: boolean;
  write(...args: never[]): unknown;
  end(...args: never[]): unknown;
  on(event: string, listener: () => void): unknown;
}

export type NextFunction = (error?: unknown) => void;

export type CrawlmeterOptions = EngineOptions;

export interface CrawlmeterMiddleware {
  (request: AdapterRequest, response: AdapterResponse, next: NextFunction): void;
  /** The store in use, so the report can read it. */
  readonly store: Store;
  /** The config after validation. */
  readonly config: NormalizedConfig;
  /**
   * Settles when the middleware can do its job. Always resolved in observe
   * mode. In enforce mode it waits for x402 to load and the facilitator to
   * answer, and rejects with the real cause — including the install command
   * when x402 is missing. `await meter.ready` at startup to make a broken
   * enforce setup fail the deploy instead of quietly serving everything free.
   */
  readonly ready: Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Middleware                                                                  */
/* -------------------------------------------------------------------------- */

export function crawlmeter(options: CrawlmeterOptions = {}): CrawlmeterMiddleware {
  // Express has a socket, so the safe default is to trust no proxy.
  const engine = createEngine(options, { trustProxy: false });

  const middleware = (
    request: AdapterRequest,
    response: AdapterResponse,
    next: NextFunction,
  ): void => {
    // The fast path: this must return without awaiting anything.
    if (!engine.isCrawler(header(request.headers, "user-agent"))) {
      next();
      return;
    }
    void serve(request, response, next);
  };

  async function serve(
    request: AdapterRequest,
    response: AdapterResponse,
    next: NextFunction,
  ): Promise<void> {
    const handled: Handled = await engine.handle(toEngineRequest(request));

    // Recording happens when the response is done, so the byte count is real.
    try {
      onFinish(response, (bytes) => handled.record(bytes));
    } catch (error) {
      engine.onError?.(error);
    }

    try {
      const { answer } = handled;
      for (const [name, value] of Object.entries(answer.headers)) response.setHeader(name, value);
      if (answer.kind === "respond") {
        response.statusCode = answer.status;
        (response.end as (chunk: string) => unknown)(answer.body);
        return;
      }
      next();
    } catch (error) {
      // Last resort. If answering threw, the content still goes out.
      engine.onError?.(error);
      if (response.headersSent !== true) next();
    }
  }

  return Object.assign(middleware, {
    store: engine.store,
    config: engine.config,
    ready: engine.ready,
  });
}

function toEngineRequest(request: AdapterRequest): EngineRequest {
  return {
    method: request.method ?? "GET",
    url: request.originalUrl ?? request.url ?? "/",
    headers: request.headers,
    socketAddress: request.socket?.remoteAddress ?? null,
    protocol: request.protocol ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Pathname only — see `pathOf` in `./core.ts`. */
export function pathOf(request: AdapterRequest): string {
  return pathOfUrl(request.originalUrl ?? request.url ?? "/");
}

/** The address to identify against — see `clientAddress` in `./core.ts`. */
export function addressOf(request: AdapterRequest, trustProxy: boolean | number): string | null {
  return clientAddress(
    request.headers,
    request.socket?.remoteAddress ?? null,
    normalizeTrustProxy(trustProxy),
  );
}

/** The absolute URL of the requested resource — see `resourceUrl` in `./core.ts`. */
export function urlOf(request: AdapterRequest, trustProxy: boolean | number): string {
  return resourceUrl(toEngineRequest(request), normalizeTrustProxy(trustProxy));
}

/* -------------------------------------------------------------------------- */
/* Response helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Byte length of one chunk, without assuming Node's Buffer exists. */
function sizeOf(chunk: unknown): number {
  if (typeof chunk === "string") {
    return typeof Buffer !== "undefined"
      ? Buffer.byteLength(chunk)
      : new TextEncoder().encode(chunk).length;
  }
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

/**
 * Count the bytes written, then report them once the response is done.
 *
 * `write` and `end` are wrapped rather than reading `content-length`, because a
 * streamed or chunked response has no such header and would report zero — and
 * "how much bandwidth are the crawlers costing me" is one of the numbers the
 * report exists to answer. The wrappers only measure: arguments are passed
 * through untouched, and the original is always called.
 */
export function onFinish(response: AdapterResponse, done: (bytes: number) => void): void {
  let bytes = 0;
  let reported = false;

  const originalWrite = response.write.bind(response) as (...args: unknown[]) => unknown;
  const originalEnd = response.end.bind(response) as (...args: unknown[]) => unknown;

  (response as { write: unknown }).write = (...args: unknown[]): unknown => {
    bytes += sizeOf(args[0]);
    return originalWrite(...args);
  };
  (response as { end: unknown }).end = (...args: unknown[]): unknown => {
    bytes += sizeOf(args[0]);
    return originalEnd(...args);
  };

  response.on("finish", () => {
    if (reported) return;
    reported = true;
    done(bytes);
  });
}

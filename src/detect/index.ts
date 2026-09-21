/**
 * Detection: turn a raw request into an `Identification`.
 *
 * This is where all of crawlmeter's I/O lives — HTTP for published CIDR lists,
 * DNS for reverse lookups — which is exactly why it is here and not in
 * `evaluate()`. The adapter runs this first and hands the result to the pure
 * decision layer.
 *
 * Two rules govern this module:
 *
 * 1. **It never throws.** A failed lookup degrades to a weaker level. This code
 *    sits in the request path of somebody else's site.
 * 2. **It does not know about `mode`.** Confidence escalation runs identically
 *    in observe and enforce, and that is load-bearing: observe is a dry-run of
 *    enforce, so if escalation were skipped to save a round trip in observe,
 *    every hit would sit at `ua-only`, fall under the default
 *    `minConfidenceToCharge`, and report zero potential revenue forever. The
 *    number the product exists to show would always be zero.
 *
 * The fast path is the other half of the bargain: a request whose User-Agent
 * matches no known crawler — which is almost all of them — returns before any
 * network or DNS work happens at all.
 */

import {
  NOT_A_CRAWLER,
  confidenceRank,
  meetsConfidence,
  type Confidence,
  type Identification,
} from "../types.js";
import { matchUserAgent } from "./ua.js";
import {
  createIpRangeCache,
  findCidr,
  parseIp,
  type IpRangeCache,
} from "./ipRanges.js";
import {
  DEFAULT_RDNS_TIMEOUT_MS,
  createNodeResolver,
  verifyRdns,
  type DnsResolver,
} from "./rdns.js";
import { detectSignature, type SignatureHeaders } from "./signature.js";

export interface DetectInput {
  readonly userAgent?: string | null;
  /** Remote address, already resolved from proxy headers by the adapter. */
  readonly ip?: string | null;
  readonly signature?: SignatureHeaders;
}

export interface DetectorOptions {
  /**
   * Cache of published CIDR lists. Pass `null` to skip the `ip-range` layer
   * entirely — which also means no outbound requests at all.
   */
  readonly ipRanges?: IpRangeCache | null;
  /**
   * DNS resolver for the `rdns` layer. Pass `null` to skip it. Omit it and a
   * `node:dns` resolver is loaded lazily, or skipped where that module has no
   * implementation, as on edge runtimes.
   */
  readonly resolver?: DnsResolver | null;
  /** Budget for the reverse + forward round trip. */
  readonly rdnsTimeoutMs?: number;
}

export type Detector = (input: DetectInput) => Promise<Identification>;

/**
 * Build a detector.
 *
 * Note what this signature does NOT take: the crawlmeter config, and therefore
 * the mode. Detection cannot be tuned down for observe even by accident.
 */
export function createDetector(options: DetectorOptions = {}): Detector {
  const ipRanges = options.ipRanges === undefined ? createIpRangeCache() : options.ipRanges;
  const rdnsTimeoutMs = options.rdnsTimeoutMs ?? DEFAULT_RDNS_TIMEOUT_MS;

  let resolverPromise: Promise<DnsResolver | null> | null = null;
  const getResolver = (): Promise<DnsResolver | null> => {
    if (options.resolver !== undefined) return Promise.resolve(options.resolver);
    resolverPromise ??= createNodeResolver().catch(() => null);
    return resolverPromise;
  };

  return async (input) => {
    try {
      return await identify(input, ipRanges, getResolver, rdnsTimeoutMs);
    } catch {
      // Belt and braces. Each layer already degrades on its own; this catches
      // anything unforeseen so detection can never break a request.
      return NOT_A_CRAWLER;
    }
  };
}

let defaultDetector: Detector | null = null;

/** Detect using a lazily created default detector. */
export function detect(input: DetectInput): Promise<Identification> {
  defaultDetector ??= createDetector();
  return defaultDetector(input);
}

async function identify(
  input: DetectInput,
  ipRanges: IpRangeCache | null,
  getResolver: () => Promise<DnsResolver | null>,
  rdnsTimeoutMs: number,
): Promise<Identification> {
  // Fast path. No catalog hit means no crawler, and nothing below this line
  // costs the site a single millisecond.
  const agent = matchUserAgent(input.userAgent);
  if (agent === null) return NOT_A_CRAWLER;

  const ceiling = agent.maxConfidence;
  const evidence: string[] = [`ua:${agent.id}`];
  let confidence: Confidence = "ua-only";

  // Signature headers. Present but unverified, so this ranks below `ip-range`
  // on purpose — see `src/detect/signature.ts`.
  const signature = detectSignature(input.signature ?? {});
  if (signature.present) {
    evidence.push("signature:present");
    if (signature.agentUrl !== null) evidence.push(`signature-agent:${signature.agentUrl}`);
    confidence = strongest(confidence, "signed-unverified");
  }

  const ip = typeof input.ip === "string" ? parseIp(input.ip) : null;

  // Published CIDR list. Skipped when the catalog says this agent can never
  // reach `ip-range` anyway — that is what spares CCBot and friends a fetch.
  if (ip !== null && ipRanges !== null && agent.ipRangesUrl !== null && allows(ceiling, "ip-range")) {
    try {
      const blocks = await ipRanges.get(agent.ipRangesUrl);
      const block = findCidr(ip, blocks);
      if (block !== null) {
        evidence.push(`ip:${block.source}`);
        confidence = strongest(confidence, "ip-range");
      }
    } catch {
      // Degrade, do not discard: the User-Agent match is still worth reporting,
      // and throwing away a known crawler because a CDN had a bad minute would
      // quietly zero out the operator's numbers.
      evidence.push("ip-range:unavailable");
    }
  }

  // Reverse DNS. Last, because it is the only layer that costs a round trip
  // the operator cannot cache away, and it only runs when it could actually
  // raise the result.
  if (
    typeof input.ip === "string" &&
    agent.rdnsSuffixes.length > 0 &&
    allows(ceiling, "rdns") &&
    confidenceRank(confidence) < confidenceRank("rdns")
  ) {
    try {
      const resolver = await getResolver();
      if (resolver !== null) {
        const result = await verifyRdns(input.ip, agent.rdnsSuffixes, resolver, rdnsTimeoutMs);
        if (result.verified) {
          evidence.push(`rdns:${result.hostname ?? ""}`);
          confidence = strongest(confidence, "rdns");
        }
      }
    } catch {
      evidence.push("rdns:unavailable");
    }
  }

  const capped = cap(confidence, ceiling);
  if (capped !== confidence) evidence.push(`capped-by-catalog:${ceiling}`);

  return {
    agent: agent.id,
    operator: agent.operator,
    confidence: capped,
    evidence,
  };
}

/** The stronger of two levels. */
function strongest(a: Confidence, b: Confidence): Confidence {
  return meetsConfidence(a, b) ? a : b;
}

/** True when the catalog ceiling permits reaching `level`. */
function allows(ceiling: Confidence, level: Confidence): boolean {
  return meetsConfidence(ceiling, level);
}

/**
 * Hold the result to the ceiling the catalog declares for this agent.
 *
 * The ceiling is data, so an operator who starts publishing ranges is a
 * one-line pull request away from being billable — no code change, no release.
 */
function cap(confidence: Confidence, ceiling: Confidence): Confidence {
  return meetsConfidence(confidence, ceiling) ? ceiling : confidence;
}

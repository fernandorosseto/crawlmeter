/**
 * The agent catalog.
 *
 * The data lives in `src/data/agents.json` so it can be reviewed and updated by
 * pull request without touching code. This module only loads it, types it and
 * compiles the User-Agent patterns.
 *
 * Two well-known names are deliberately absent, and both for the same reason:
 * they are robots.txt control tokens, not crawlers, so no request ever carries
 * them and there is nothing to detect.
 *
 * - `Google-Extended` — Google states it "doesn't have a separate HTTP request
 *   user agent string"; crawling happens under existing Google user agents.
 * - `Applebot-Extended` — Apple states it "does not crawl webpages"; it only
 *   controls how content already crawled by `Applebot` may be used.
 *
 * `Applebot` itself IS in the catalog: Apple publishes both a CIDR list and an
 * `applebot.apple.com` reverse-DNS domain, so it reaches `rdns`.
 */

import catalog from "../data/agents.json" with { type: "json" };
import { isConfidence, type Confidence } from "../types.js";

/** One row of `agents.json`. */
export interface AgentEntry {
  /** Stable lowercase id, e.g. `"gptbot"`. */
  readonly id: string;
  /** Operator id, e.g. `"openai"`. */
  readonly operator: string;
  /** Regex source matched case-insensitively against the User-Agent. */
  readonly uaPattern: string;
  readonly purpose: string;
  /** Where the operator publishes its CIDR list. Null when it publishes none. */
  readonly ipRangesUrl: string | null;
  /** Shape of that document. Only `"prefixes"` exists so far. */
  readonly ipRangesFormat: string | null;
  /** Domains a reverse lookup must end in for `rdns` to apply. */
  readonly rdnsSuffixes: readonly string[];
  /**
   * The strongest confidence this agent can ever reach.
   *
   * The ceiling lives in the data, not in the logic, so the limitation is
   * visible to anyone reading the catalog and fixable by PR the day an operator
   * starts publishing ranges. CCBot, meta-externalagent and friends publish
   * nothing, so they are stuck at `ua-only` — which is exactly why the default
   * `minConfidenceToCharge` is `ip-range`.
   */
  readonly maxConfidence: Confidence;
  readonly docs: string;
}

export interface CompiledAgent extends AgentEntry {
  /** Case-insensitive matcher built from `uaPattern`. */
  readonly matches: (userAgent: string) => boolean;
}

/** Date the catalog was last reviewed, as written in the JSON. */
export const CATALOG_VERSION: string = catalog.version;

/** Raw catalog rows, in file order. */
export const AGENTS: readonly AgentEntry[] = catalog.agents.map((agent) => ({
  ...agent,
  // The JSON is checked by `test/detect/agents.test.ts`; this keeps the type
  // honest for anything that slips past review.
  maxConfidence: isConfidence(agent.maxConfidence) ? agent.maxConfidence : "ua-only",
}));

/**
 * Catalog compiled for lookup, most specific pattern first.
 *
 * "Most specific" is the longest pattern. It matters whenever one token
 * contains another — a future `Applebot-Extended` row must be tested before
 * `Applebot`, or every extended hit would be filed under the shorter name.
 */
export const COMPILED_AGENTS: readonly CompiledAgent[] = [...AGENTS]
  .sort((a, b) => b.uaPattern.length - a.uaPattern.length || (a.id < b.id ? -1 : 1))
  .map((agent) => {
    const pattern = safeRegExp(agent.uaPattern);
    return {
      ...agent,
      matches: pattern ? (userAgent: string) => pattern.test(userAgent) : () => false,
    };
  });

const BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

/** Look up a catalog row by its id. */
export function agentById(id: string): AgentEntry | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Compile a pattern, or return null if it does not compile.
 *
 * A broken row must not take the process down at import time — the catalog is
 * data, and bad data degrades detection rather than breaking the site. The test
 * suite is where a pattern that does not compile is supposed to be caught.
 */
function safeRegExp(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

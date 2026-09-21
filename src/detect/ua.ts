/**
 * Layer 1: User-Agent matching.
 *
 * Produces `ua-only`, the weakest level there is. A User-Agent is a claim, not
 * an identification — one line of curl forges it. Everything above this layer
 * exists to turn the claim into something harder to fake.
 */

import { COMPILED_AGENTS, type CompiledAgent } from "./agents.js";

/**
 * Find the catalog entry whose pattern matches this User-Agent.
 *
 * The catalog is pre-sorted most specific first, so the first hit wins and a
 * token that contains a shorter token is filed under the longer one.
 */
export function matchUserAgent(userAgent: string | null | undefined): CompiledAgent | null {
  if (!userAgent) return null;
  for (const agent of COMPILED_AGENTS) {
    if (agent.matches(userAgent)) return agent;
  }
  return null;
}

/**
 * Route matching and price resolution. Pure: no I/O.
 */

import type { Money } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Glob matching                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Compile a path glob into a matcher.
 *
 * Semantics, chosen to match what people mean rather than what shells do:
 *
 * - `*` matches any run of characters, including `/`. So `/api/*` matches
 *   `/api/users` AND `/api/v1/users`. Treating `*` as segment-local surprises
 *   people writing `/api/*` and expecting the whole subtree.
 * - `**` is accepted as an alias for `*`, so paths copied from other tools work.
 * - Matching is case-sensitive and anchored at both ends.
 * - Everything else is literal, including `.` and `?`.
 */
export function createMatcher(pattern: string): (path: string) => boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metacharacters
    .replace(/\?/g, "\\?")
    .replace(/\*+/g, ".*"); // `*` and `**` both mean "anything"
  const re = new RegExp(`^${source}$`);
  return (path: string) => re.test(path);
}

/** Number of characters in a pattern that are not wildcards. */
function literalWeight(pattern: string): number {
  return pattern.replace(/\*/g, "").length;
}

/**
 * Sort patterns most specific first.
 *
 * Specificity is: more literal characters wins; then longer pattern wins; then
 * lexicographic, purely so the order is deterministic across runs and platforms.
 * Determinism matters — an unstable sort here makes prices flap between deploys.
 */
export function sortBySpecificity(patterns: readonly string[]): string[] {
  return [...patterns].sort((a, b) => {
    const weight = literalWeight(b) - literalWeight(a);
    if (weight !== 0) return weight;
    const length = b.length - a.length;
    if (length !== 0) return length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/* Compiled route table                                                        */
/* -------------------------------------------------------------------------- */

export interface CompiledRoute {
  readonly pattern: string;
  readonly price: Money;
  readonly matches: (path: string) => boolean;
}

/** Compile and pre-sort a route table so lookups are a linear scan in priority order. */
export function compileRoutes(routes: ReadonlyMap<string, Money>): CompiledRoute[] {
  return sortBySpecificity([...routes.keys()]).map((pattern) => ({
    pattern,
    price: routes.get(pattern)!,
    matches: createMatcher(pattern),
  }));
}

/** Compile a list of patterns with no prices attached (the `free` list). */
export function compilePatterns(
  patterns: readonly string[],
): ReadonlyArray<(path: string) => boolean> {
  return sortBySpecificity(patterns).map(createMatcher);
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedPrice {
  readonly route: string;
  readonly price: Money;
}

/**
 * Find the price for a path.
 *
 * The most specific matching route wins. When nothing matches, the default
 * price applies and the route is reported as `"*"` so the report can tell
 * "priced by a rule" apart from "priced by the fallback".
 *
 * Returns null when no route matched and there is no default price, which is a
 * legitimate config: counting crawler traffic without pricing it at all.
 */
export function resolvePrice(
  path: string,
  routes: readonly CompiledRoute[],
  defaultPrice: Money | null,
): ResolvedPrice | null {
  for (const route of routes) {
    if (route.matches(path)) {
      return { route: route.pattern, price: route.price };
    }
  }
  return defaultPrice ? { route: "*", price: defaultPrice } : null;
}

/** True when the path is on the always-free list. */
export function isFree(
  path: string,
  freeMatchers: ReadonlyArray<(path: string) => boolean>,
): boolean {
  return freeMatchers.some((matches) => matches(path));
}

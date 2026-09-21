/**
 * What gets recorded, and what can be read back.
 *
 * The store is the only place a decision outlives the request that produced it,
 * so two rules shape this file:
 *
 * 1. **`record` returns `void`, not a promise.** Recording must never be on the
 *    critical path of somebody else's response. A store that cannot keep up
 *    drops writes; it does not add latency and it does not throw.
 * 2. **`potentialMicros` comes from `Decision.potential` and from nowhere
 *    else.** Potential revenue has exactly one definition — what enforce would
 *    have charged for this same request under this same config. `eventFromDecision`
 *    is the only supported way to build an event, so no adapter can invent a
 *    number the report would then present as revenue.
 */

import type { Confidence, Decision, DecisionAction, PassReason } from "../types.js";

/** One decision, as recorded. */
export interface CrawlEvent {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly agent: string | null;
  readonly operator: string | null;
  readonly confidence: Confidence | null;
  readonly method: string;
  /** Pathname only — no query string. */
  readonly path: string;
  /** Matched route pattern, `"*"` for the default price, null when unpriced. */
  readonly route: string | null;
  readonly action: DecisionAction;
  readonly reason: PassReason | null;
  readonly priceMicros: number | null;
  /** What enforce would have charged. Null when it would have passed too. */
  readonly potentialMicros: number | null;
  /**
   * Response size, for the GB column of the report — or null when the adapter
   * cannot see the response.
   *
   * Null, not zero. The Next.js proxy runs before the route renders and never
   * sees the body it produces; recording 0 there would tell the operator the
   * crawlers cost them nothing, on the report's first screen.
   */
  readonly bytes: number | null;
}

export interface Totals {
  readonly hits: number;
  /** Sum of the sizes that were measured. */
  readonly bytes: number;
  /** How many hits `bytes` covers. Less than `hits` when some adapter could not measure. */
  readonly bytesMeasured: number;
  readonly potentialMicros: number;
}

export interface Bucket extends Totals {
  readonly key: string;
}

export interface Summary {
  readonly totals: Totals;
  readonly byAgent: readonly Bucket[];
  readonly byOperator: readonly Bucket[];
  readonly byRoute: readonly Bucket[];
  /** Why traffic was let through. This is where the `below-min-confidence`
   * slice lives — seen, but too weakly identified to bill. */
  readonly byReason: readonly Bucket[];
}

export interface TimeRange {
  /** Inclusive. */
  readonly from?: number;
  /** Exclusive. */
  readonly to?: number;
}

export interface Store {
  /** Record a decision. Fire and forget: never blocks, never throws. */
  record(event: CrawlEvent): void;
  /** Aggregates for the report. */
  summary(range?: TimeRange): Promise<Summary>;
  /** Settle pending writes. For shutdown and for tests. */
  flush(): Promise<void>;
  /** Flush and release resources. */
  close(): Promise<void>;
}

export const EMPTY_TOTALS: Totals = { hits: 0, bytes: 0, bytesMeasured: 0, potentialMicros: 0 };

export const EMPTY_SUMMARY: Summary = {
  totals: EMPTY_TOTALS,
  byAgent: [],
  byOperator: [],
  byRoute: [],
  byReason: [],
};

/**
 * Build an event from a decision.
 *
 * Every adapter goes through here, which is what keeps potential revenue
 * honest: the number is copied from the decision, never computed a second time.
 */
export function eventFromDecision(
  decision: Decision,
  context: {
    readonly method: string;
    readonly path: string;
    readonly agent: string | null;
    readonly operator: string | null;
    readonly confidence: Confidence | null;
    /** Response size; null when it cannot be measured. Defaults to null. */
    readonly bytes?: number | null;
    readonly at?: number;
  },
): CrawlEvent {
  return {
    at: context.at ?? Date.now(),
    agent: context.agent,
    operator: context.operator,
    confidence: context.confidence,
    method: context.method,
    path: context.path,
    route: decision.route,
    action: decision.action,
    reason: decision.reason,
    priceMicros: decision.price?.micros ?? null,
    potentialMicros: decision.potential?.micros ?? null,
    bytes: context.bytes ?? null,
  };
}

/** True when the event falls inside the range. */
export function inRange(event: CrawlEvent, range?: TimeRange): boolean {
  if (range === undefined) return true;
  if (range.from !== undefined && event.at < range.from) return false;
  if (range.to !== undefined && event.at >= range.to) return false;
  return true;
}

/**
 * Aggregate events into the report's shape.
 *
 * Pure, and shared by every store that can hold its data in memory, so the
 * numbers cannot drift between backends. Sums stay in integer micros from end
 * to end — see `Money` in `src/types.ts` for why no float is allowed near this.
 */
export function aggregate(events: Iterable<CrawlEvent>, range?: TimeRange): Summary {
  let hits = 0;
  let bytes = 0;
  let bytesMeasured = 0;
  let potentialMicros = 0;

  const byAgent = new Map<string, Totals>();
  const byOperator = new Map<string, Totals>();
  const byRoute = new Map<string, Totals>();
  const byReason = new Map<string, Totals>();

  for (const event of events) {
    if (!inRange(event, range)) continue;
    hits += 1;
    if (event.bytes !== null) {
      bytes += event.bytes;
      bytesMeasured += 1;
    }
    potentialMicros += event.potentialMicros ?? 0;

    add(byAgent, event.agent ?? NOT_A_CRAWLER_KEY, event);
    add(byOperator, event.operator ?? NOT_A_CRAWLER_KEY, event);
    if (event.route !== null) add(byRoute, event.route, event);
    if (event.reason !== null) add(byReason, event.reason, event);
  }

  return {
    totals: { hits, bytes, bytesMeasured, potentialMicros },
    byAgent: toBuckets(byAgent),
    byOperator: toBuckets(byOperator),
    byRoute: toBuckets(byRoute),
    byReason: toBuckets(byReason),
  };
}

function add(map: Map<string, Totals>, key: string, event: CrawlEvent): void {
  const current = map.get(key) ?? EMPTY_TOTALS;
  map.set(key, {
    hits: current.hits + 1,
    bytes: current.bytes + (event.bytes ?? 0),
    bytesMeasured: current.bytesMeasured + (event.bytes === null ? 0 : 1),
    potentialMicros: current.potentialMicros + (event.potentialMicros ?? 0),
  });
}

/**
 * Order buckets biggest first, with ties broken by key.
 *
 * Deterministic on purpose: a report whose rows move between runs is a report
 * nobody trusts. Exported so the SQL-backed stores, which group in the database
 * rather than in this process, order their rows the same way — the numbers must
 * not depend on which backend the operator picked.
 */
export function compareBuckets(a: Bucket, b: Bucket): number {
  return (
    b.potentialMicros - a.potentialMicros ||
    b.hits - a.hits ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** Label used when an event belongs to no crawler. */
export const NOT_A_CRAWLER_KEY = "(not a crawler)";

function toBuckets(map: ReadonlyMap<string, Totals>): Bucket[] {
  return [...map.entries()]
    .map(([key, totals]) => ({ key, ...totals }))
    .sort(compareBuckets);
}

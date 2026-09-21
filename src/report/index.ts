/**
 * The report: what the AI crawler traffic was, and what it would have been
 * worth.
 *
 * This is the number the product exists to show, so it is held to the rule that
 * governs potential revenue everywhere else: it is `Decision.potential`, summed,
 * and nothing more. A hit that enforce mode would not have billed contributes
 * nothing to the headline — but it is not hidden. It is shown separately, with
 * the reason it was not billable, because "seen but not provable" is exactly
 * what an operator needs to know to act on it.
 *
 * Pure: a `Summary` goes in, a `Report` comes out. Reading the store and
 * printing are somebody else's job.
 */

import { agentById } from "../detect/agents.js";
import { NOT_A_CRAWLER_KEY, type Bucket, type Summary } from "../store/types.js";
import type { PassReason } from "../types.js";

export interface ReportRow {
  readonly key: string;
  /** For crawler rows, the operator from the catalog. */
  readonly operator?: string | null;
  readonly hits: number;
  /** Sum of measured sizes, or null when none of these hits could be measured. */
  readonly bytes: number | null;
  readonly bytesMeasured: number;
  readonly potentialMicros: number;
}

export interface UnbilledRow extends ReportRow {
  readonly reason: PassReason;
  /** Plain-language explanation for the operator. */
  readonly label: string;
}

export interface Report {
  /** Epoch ms the report covers from, or null for everything recorded. */
  readonly since: number | null;
  readonly totals: {
    /** Crawler requests. Human traffic is never recorded. */
    readonly hits: number;
    readonly bytes: number | null;
    readonly bytesMeasured: number;
    /** What enforce mode would have charged. The headline. */
    readonly potentialMicros: number;
  };
  readonly crawlers: readonly ReportRow[];
  readonly operators: readonly ReportRow[];
  /** Traffic priced by a route rule. */
  readonly routes: readonly ReportRow[];
  /** Traffic priced by the fallback `price`, kept apart from the rules. */
  readonly fallbackRoute: ReportRow | null;
  /** Crawler traffic that was not billable, grouped by why. */
  readonly unbilled: readonly UnbilledRow[];
  /** Things the operator should know, most important first. */
  readonly notes: readonly string[];
}

/** What each pass reason means to someone reading the report. */
export const REASON_LABELS: Readonly<Record<PassReason, string>> = {
  "not-a-crawler": "not an AI crawler",
  "free-path": "always-free paths (robots.txt, sitemap, .well-known)",
  "valid-session": "covered by an earlier payment in the same session",
  allowlisted: "crawlers you allowlisted",
  "not-charged": "crawlers outside your charge list",
  "below-min-confidence": "identity not proven strongly enough to bill",
  "no-price": "no price set for the path",
  "observe-mode": "billable",
  "fail-open": "served during a failure (fail-open)",
};

/** The share of weakly identified traffic at which a missing proxy setup is the likely cause. */
const WEAK_SHARE_FOR_PROXY_HINT = 0.9;

export function buildReport(summary: Summary, options: { readonly since?: number | null } = {}): Report {
  const crawlers = summary.byAgent
    .filter((bucket) => bucket.key !== NOT_A_CRAWLER_KEY)
    .map((bucket) => ({ ...row(bucket), operator: agentById(bucket.key)?.operator ?? null }));
  const operators = summary.byOperator.filter((bucket) => bucket.key !== NOT_A_CRAWLER_KEY).map(row);

  // Adapters never record human traffic, so these normally match. If some
  // store does hold not-a-crawler events, they are not crawler traffic and do
  // not belong in a report about crawlers.
  const human = summary.byAgent.find((bucket) => bucket.key === NOT_A_CRAWLER_KEY);
  const hits = summary.totals.hits - (human?.hits ?? 0);
  const bytesTotal = summary.totals.bytes - (human?.bytes ?? 0);
  const bytesMeasured = summary.totals.bytesMeasured - (human?.bytesMeasured ?? 0);

  const routes = summary.byRoute.filter((bucket) => bucket.key !== "*").map(row);
  const fallback = summary.byRoute.find((bucket) => bucket.key === "*");

  const unbilled: UnbilledRow[] = summary.byReason
    .filter((bucket) => isPassReason(bucket.key))
    .filter((bucket) => bucket.key !== "observe-mode" && bucket.key !== "not-a-crawler")
    .map((bucket) => ({
      ...row(bucket),
      reason: bucket.key as PassReason,
      label: REASON_LABELS[bucket.key as PassReason],
    }));

  const report: Omit<Report, "notes"> = {
    since: options.since ?? null,
    totals: {
      hits,
      bytes: bytesMeasured > 0 ? bytesTotal : null,
      bytesMeasured,
      potentialMicros: summary.totals.potentialMicros,
    },
    crawlers,
    operators,
    routes,
    fallbackRoute: fallback === undefined ? null : row(fallback),
    unbilled,
  };
  return { ...report, notes: notesFor(report) };
}

function row(bucket: Bucket): ReportRow {
  return {
    key: bucket.key,
    hits: bucket.hits,
    bytes: bucket.bytesMeasured > 0 ? bucket.bytes : null,
    bytesMeasured: bucket.bytesMeasured,
    potentialMicros: bucket.potentialMicros,
  };
}

function isPassReason(key: string): key is PassReason {
  return key in REASON_LABELS;
}

/**
 * What the operator should know that the numbers alone do not say.
 *
 * The most important one is the silent zero. When a site sits behind a proxy
 * and crawlmeter is not told to trust it, every crawler is identified by the
 * proxy's address, no published range ever matches, everything falls below the
 * default confidence to bill, and the headline reads zero. The middleware warns
 * at startup; this says it again where the operator is actually looking — at
 * the number that looks wrong.
 */
function notesFor(report: Omit<Report, "notes">): string[] {
  const notes: string[] = [];
  const { hits, potentialMicros, bytesMeasured } = report.totals;

  if (hits === 0) {
    notes.push(
      "No crawler traffic has been recorded yet. crawlmeter only records AI crawlers, never human visitors; " +
        "if crawlers should have visited by now, check that the middleware is installed on the routes they read.",
    );
    return notes;
  }

  const weak = report.unbilled.find((each) => each.reason === "below-min-confidence");
  if (potentialMicros === 0 && weak !== undefined && weak.hits >= hits * WEAK_SHARE_FOR_PROXY_HINT) {
    notes.push(
      "Almost every crawler request was identified only by its User-Agent, so none of it counts toward " +
        "potential revenue. If your site is behind a proxy (Vercel, Cloudflare, Fly, Render, nginx, a load " +
        "balancer), crawlmeter may be seeing the proxy's address instead of the crawler's: set trustProxy " +
        "(Express) or keep the default (Next.js). Some crawlers, such as CCBot and Meta's, publish no address " +
        "ranges at all and can never be proven, so some of this is expected.",
    );
  } else if (weak !== undefined) {
    notes.push(
      `${weak.hits} crawler ${plural(weak.hits, "request", "requests")} could not be proven to come from the ` +
        "crawler named in the User-Agent, and are not counted toward potential revenue. That is deliberate: " +
        "a User-Agent can be forged by anyone.",
    );
  }

  if (bytesMeasured < hits) {
    notes.push(
      `Response sizes were measured for ${bytesMeasured} of ${hits} ${plural(hits, "request", "requests")}. ` +
        "The Next.js proxy runs before the page is rendered and cannot see its size; those requests are " +
        "counted, but their bandwidth is unknown rather than zero.",
    );
  }

  const failed = report.unbilled.find((each) => each.reason === "fail-open");
  if (failed !== undefined) {
    notes.push(
      `${failed.hits} ${plural(failed.hits, "request was", "requests were")} served during a failure ` +
        "(fail-open): detection, the store or the payment facilitator had a problem. Check the errors your " +
        "onError handler received.",
    );
  }

  return notes;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

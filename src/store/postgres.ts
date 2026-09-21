/**
 * Postgres-backed store, for deployments with more than one instance.
 *
 * The driver is `postgres` (postgres.js), loaded through a dynamic import and
 * declared as an OPTIONAL peer dependency. It was picked over `pg` for one
 * reason that matters to a package other people install: postgres.js has zero
 * dependencies, where `pg` brings six. This store issues about five queries in
 * total, so the richer client buys nothing and the smaller supply chain is the
 * whole benefit.
 *
 * Every count and sum comes back through `Number()` on purpose: Postgres
 * returns BIGINT and SUM as strings to avoid silent precision loss, and micros
 * are integers everywhere else in this package.
 */

import {
  compareBuckets,
  NOT_A_CRAWLER_KEY,
  type Bucket,
  type CrawlEvent,
  type Store,
  type Summary,
  type TimeRange,
} from "./types.js";
import { createWriteQueue } from "./writeQueue.js";

export interface PostgresStoreOptions {
  /** Connection string, e.g. `postgres://user:pass@host/db`. */
  readonly url: string;
  /** Called when a batch of writes fails. */
  readonly onError?: (error: unknown) => void;
  /** Events per write. */
  readonly maxBatch?: number;
}

type Row = Record<string, unknown>;

/** The slice of postgres.js this module uses. */
interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  (rows: readonly Row[], ...columns: string[]): unknown;
  (identifier: string): unknown;
  end(): Promise<void>;
}

const COLUMNS = [
  "at",
  "agent",
  "operator",
  "confidence",
  "method",
  "path",
  "route",
  "action",
  "reason",
  "price_micros",
  "potential_micros",
  "bytes",
] as const;

async function loadDriver(): Promise<(url: string) => Sql> {
  const specifier = "postgres";
  try {
    const module = (await import(specifier)) as { default: (url: string) => Sql };
    return module.default;
  } catch (cause) {
    throw new Error(
      "crawlmeter: the postgres store needs the postgres driver. Install it with `npm i postgres`, or use the default in-memory store.",
      { cause },
    );
  }
}

function toRow(event: CrawlEvent): Row {
  return {
    at: event.at,
    agent: event.agent,
    operator: event.operator,
    confidence: event.confidence,
    method: event.method,
    path: event.path,
    route: event.route,
    action: event.action,
    reason: event.reason,
    price_micros: event.priceMicros,
    potential_micros: event.potentialMicros,
    bytes: event.bytes,
  };
}

export async function createPostgresStore(options: PostgresStoreOptions): Promise<Store> {
  const driver = await loadDriver();
  const sql = driver(options.url);

  await sql`
    CREATE TABLE IF NOT EXISTS crawl_events (
      id               BIGSERIAL PRIMARY KEY,
      at               BIGINT NOT NULL,
      agent            TEXT,
      operator         TEXT,
      confidence       TEXT,
      method           TEXT NOT NULL,
      path             TEXT NOT NULL,
      route            TEXT,
      action           TEXT NOT NULL,
      reason           TEXT,
      price_micros     BIGINT,
      potential_micros BIGINT,
      bytes            BIGINT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS crawl_events_at ON crawl_events (at)`;

  const queue = createWriteQueue({
    flush: async (batch) => {
      const rows = batch.map(toRow);
      await sql`INSERT INTO crawl_events ${sql(rows, ...COLUMNS)}`;
    },
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.maxBatch !== undefined ? { maxBatch: options.maxBatch } : {}),
  });

  /** Time filter as a composable fragment, so the queries stay readable. */
  function timeWindow(range?: TimeRange): unknown {
    if (range?.from !== undefined && range.to !== undefined) {
      return sql`WHERE at >= ${range.from} AND at < ${range.to}`;
    }
    if (range?.from !== undefined) return sql`WHERE at >= ${range.from}`;
    if (range?.to !== undefined) return sql`WHERE at < ${range.to}`;
    return sql``;
  }

  async function buckets(
    column: "agent" | "operator" | "route" | "reason",
    range: TimeRange | undefined,
    keepNulls: boolean,
  ): Promise<Bucket[]> {
    const rows = await sql`
      SELECT ${sql(column)} AS key,
             COUNT(*) AS hits,
             COALESCE(SUM(bytes), 0) AS bytes,
             COUNT(bytes) AS measured,
             COALESCE(SUM(COALESCE(potential_micros, 0)), 0) AS potential
      FROM crawl_events ${timeWindow(range)}
      GROUP BY ${sql(column)}
    `;

    return rows
      .filter((row) => keepNulls || row["key"] !== null)
      .map((row) => ({
        key: (row["key"] as string | null) ?? NOT_A_CRAWLER_KEY,
        hits: Number(row["hits"]),
        bytes: Number(row["bytes"]),
        bytesMeasured: Number(row["measured"]),
        potentialMicros: Number(row["potential"]),
      }))
      .sort(compareBuckets);
  }

  return {
    record(event: CrawlEvent): void {
      queue.push(event);
    },

    async summary(range?: TimeRange): Promise<Summary> {
      await queue.drain();
      const [totals] = await sql`
        SELECT COUNT(*) AS hits,
               COALESCE(SUM(bytes), 0) AS bytes,
               COUNT(bytes) AS measured,
               COALESCE(SUM(COALESCE(potential_micros, 0)), 0) AS potential
        FROM crawl_events ${timeWindow(range)}
      `;

      const [byAgent, byOperator, byRoute, byReason] = await Promise.all([
        buckets("agent", range, true),
        buckets("operator", range, true),
        buckets("route", range, false),
        buckets("reason", range, false),
      ]);

      return {
        totals: {
          hits: Number(totals?.["hits"] ?? 0),
          bytes: Number(totals?.["bytes"] ?? 0),
          bytesMeasured: Number(totals?.["measured"] ?? 0),
          potentialMicros: Number(totals?.["potential"] ?? 0),
        },
        byAgent,
        byOperator,
        byRoute,
        byReason,
      };
    },

    flush(): Promise<void> {
      return queue.drain();
    },

    async close(): Promise<void> {
      await queue.drain();
      await sql.end();
    },
  };
}

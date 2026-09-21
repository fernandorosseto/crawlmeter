/**
 * SQLite-backed store, for a single machine that wants history.
 *
 * Built on `node:sqlite`, which ships with Node itself — no dependency, no
 * native build, no prebuilt binary to match against the host.
 *
 * `better-sqlite3` was the obvious choice and was tried first. Its v13 prebuilds
 * cover eight platform/arch pairs with no build step, which is exactly what a
 * package like this wants. But the win32-x64 prebuild hard-crashes the process
 * on `new Database(':memory:')` on an ordinary Intel Windows 11 host with Node
 * 22.13 — `require` succeeds, the constructor kills the process with no catchable
 * error. A crash nobody can try/catch, on one of the three desktop platforms, is
 * not something to put behind a "just add one flag to your config" feature.
 *
 * The trade accepted in exchange: `node:sqlite` is Stability 1.2, a release
 * candidate. This module touches only its most settled surface — open, exec,
 * prepare, run, all, close — and the pending rename of `DatabaseSync` keeps the
 * old name as a plain alias, so that churn cannot reach us. It is also unflagged
 * only from Node 22.13, which is why `engines.node` says `>=22.13`.
 *
 * Aggregation happens in SQL, not in this process: a store that exists to hold
 * months of traffic must not have to load months of traffic into memory to
 * answer one question.
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

export interface SqliteStoreOptions {
  /** Database file, or `":memory:"`. */
  readonly path: string;
  /** Called when a batch of writes fails. */
  readonly onError?: (error: unknown) => void;
  /** Events per write. */
  readonly maxBatch?: number;
}

/** The slice of `node:sqlite` this module uses. */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): unknown;
}
type SqliteConstructor = new (path: string) => SqliteDatabase;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crawl_events (
  id               INTEGER PRIMARY KEY,
  at               INTEGER NOT NULL,
  agent            TEXT,
  operator         TEXT,
  confidence       TEXT,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,
  route            TEXT,
  action           TEXT NOT NULL,
  reason           TEXT,
  price_micros     INTEGER,
  potential_micros INTEGER,
  bytes            INTEGER
);
CREATE INDEX IF NOT EXISTS crawl_events_at ON crawl_events (at);
`;

const INSERT = `
INSERT INTO crawl_events
  (at, agent, operator, confidence, method, path, route, action, reason, price_micros, potential_micros, bytes)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Load `node:sqlite`, or explain why it is not there.
 *
 * Both class names are accepted: `Database` is the name the rename lands under
 * and `DatabaseSync` is the alias it keeps, so this works either side of that
 * change without a version check.
 *
 * The specifier is held in a variable so bundlers targeting runtimes without
 * `node:sqlite` — the edge adapter, for one — do not try to resolve it.
 */
async function loadDriver(): Promise<SqliteConstructor> {
  const specifier = "node:sqlite";
  let module: { DatabaseSync?: unknown; Database?: unknown };
  try {
    module = (await import(specifier)) as { DatabaseSync?: unknown; Database?: unknown };
  } catch (cause) {
    throw new Error(
      "crawlmeter: the sqlite store needs the built-in node:sqlite module, available unflagged from Node 22.13. Upgrade Node, or use the default in-memory store.",
      { cause },
    );
  }
  const constructor = module.DatabaseSync ?? module.Database;
  if (typeof constructor !== "function") {
    throw new Error(
      "crawlmeter: node:sqlite loaded but exposes no DatabaseSync or Database class. Upgrade Node, or use the default in-memory store.",
    );
  }
  return constructor as SqliteConstructor;
}

export async function createSqliteStore(options: SqliteStoreOptions): Promise<Store> {
  const Driver = await loadDriver();
  const db = new Driver(options.path);
  // WAL lets the report read while requests are still being written.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const insert = db.prepare(INSERT);

  /**
   * One transaction per batch.
   *
   * Without it SQLite fsyncs once per row, which turns a burst of crawler
   * traffic into a burst of disk writes. `node:sqlite` has no transaction
   * helper, so the statements are explicit.
   */
  function insertMany(batch: readonly CrawlEvent[]): void {
    db.exec("BEGIN");
    try {
      for (const event of batch) {
        insert.run(
          event.at,
          event.agent,
          event.operator,
          event.confidence,
          event.method,
          event.path,
          event.route,
          event.action,
          event.reason,
          event.priceMicros,
          event.potentialMicros,
          event.bytes,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const queue = createWriteQueue({
    flush: insertMany,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.maxBatch !== undefined ? { maxBatch: options.maxBatch } : {}),
  });

  function where(range?: TimeRange): { clause: string; params: number[] } {
    const clauses: string[] = [];
    const params: number[] = [];
    if (range?.from !== undefined) {
      clauses.push("at >= ?");
      params.push(range.from);
    }
    if (range?.to !== undefined) {
      clauses.push("at < ?");
      params.push(range.to);
    }
    return { clause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /**
   * Group in SQL, label and order in JS.
   *
   * Grouping on the raw column keeps the query trivial; the null group is the
   * traffic that matched no crawler, and it is labelled here so every backend
   * spells it the same way.
   */
  function buckets(column: string, range: TimeRange | undefined, keepNulls: boolean): Bucket[] {
    const { clause, params } = where(range);
    const rows = db
      .prepare(
        `SELECT ${column} AS key,
                COUNT(*) AS hits,
                COALESCE(SUM(bytes), 0) AS bytes,
                COUNT(bytes) AS measured,
                COALESCE(SUM(COALESCE(potential_micros, 0)), 0) AS potential
         FROM crawl_events ${clause}
         GROUP BY ${column}`,
      )
      .all(...params) as ReadonlyArray<{
      key: string | null;
      hits: number;
      bytes: number;
      measured: number;
      potential: number;
    }>;

    return rows
      .filter((row) => keepNulls || row.key !== null)
      .map((row) => ({
        key: row.key ?? NOT_A_CRAWLER_KEY,
        hits: Number(row.hits),
        bytes: Number(row.bytes),
        bytesMeasured: Number(row.measured),
        potentialMicros: Number(row.potential),
      }))
      .sort(compareBuckets);
  }

  return {
    record(event: CrawlEvent): void {
      queue.push(event);
    },

    async summary(range?: TimeRange): Promise<Summary> {
      await queue.drain();
      const { clause, params } = where(range);
      const [totals] = db
        .prepare(
          `SELECT COUNT(*) AS hits,
                  COALESCE(SUM(bytes), 0) AS bytes,
                  COUNT(bytes) AS measured,
                  COALESCE(SUM(COALESCE(potential_micros, 0)), 0) AS potential
           FROM crawl_events ${clause}`,
        )
        .all(...params) as ReadonlyArray<{
        hits: number;
        bytes: number;
        measured: number;
        potential: number;
      }>;

      return {
        totals: {
          hits: Number(totals?.hits ?? 0),
          bytes: Number(totals?.bytes ?? 0),
          bytesMeasured: Number(totals?.measured ?? 0),
          potentialMicros: Number(totals?.potential ?? 0),
        },
        byAgent: buckets("agent", range, true),
        byOperator: buckets("operator", range, true),
        byRoute: buckets("route", range, false),
        byReason: buckets("reason", range, false),
      };
    },

    flush(): Promise<void> {
      return queue.drain();
    },

    async close(): Promise<void> {
      await queue.drain();
      db.close();
    },
  };
}

import { afterEach, describe, expect, it } from "vitest";

import { createMemoryStore } from "../../src/store/memory.js";
import { createPostgresStore } from "../../src/store/postgres.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import {
  eventFromDecision,
  NOT_A_CRAWLER_KEY,
  type CrawlEvent,
  type Store,
} from "../../src/store/types.js";
import { money, type Decision } from "../../src/types.js";

/**
 * One suite, every backend.
 *
 * The report must read the same whichever store the operator picked, so the
 * contract is written once and run against all of them. Memory aggregates in
 * this process; sqlite and postgres aggregate in SQL. Those are genuinely
 * different implementations of the same sums, which is exactly why they need
 * the same tests.
 */

const POSTGRES_URL = process.env["CRAWLMETER_TEST_POSTGRES_URL"];

interface Backend {
  readonly name: string;
  readonly available: boolean;
  create(): Promise<Store>;
}

const backends: readonly Backend[] = [
  {
    name: "memory",
    available: true,
    create: () => Promise.resolve(createMemoryStore()),
  },
  {
    name: "sqlite",
    // node:sqlite ships with Node, so this backend is always exercised in CI.
    available: true,
    create: () => createSqliteStore({ path: ":memory:" }),
  },
  {
    name: "postgres",
    // Needs a live server; set CRAWLMETER_TEST_POSTGRES_URL to run it.
    available: POSTGRES_URL !== undefined,
    create: async () => {
      const store = await createPostgresStore({ url: POSTGRES_URL! });
      await truncatePostgres();
      return store;
    },
  },
];

async function truncatePostgres(): Promise<void> {
  const { default: postgres } = (await import("postgres")) as {
    default: (url: string) => {
      (strings: TemplateStringsArray): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const sql = postgres(POSTGRES_URL!);
  await sql`TRUNCATE crawl_events`;
  await sql.end();
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const T0 = 1_789_000_000_000;

function observed(price: string | null): Decision {
  return price === null
    ? { action: "pass", reason: "no-price", route: null, price: null, potential: null }
    : {
        action: "pass",
        reason: "observe-mode",
        route: "/blog/*",
        price: money(Number(price)),
        potential: money(Number(price)),
      };
}

function event(overrides: Partial<CrawlEvent> = {}): CrawlEvent {
  return {
    ...eventFromDecision(observed("50000"), {
      method: "GET",
      path: "/blog/hello",
      agent: "gptbot",
      operator: "openai",
      confidence: "ip-range",
      bytes: 1_000,
      at: T0,
    }),
    ...overrides,
  };
}

/** A mixed day of traffic, used by several tests. */
function sampleEvents(): CrawlEvent[] {
  return [
    event({ at: T0, agent: "gptbot", operator: "openai", potentialMicros: 50_000, bytes: 1_000 }),
    event({ at: T0 + 1, agent: "gptbot", operator: "openai", potentialMicros: 50_000, bytes: 2_000 }),
    event({
      at: T0 + 2,
      agent: "claudebot",
      operator: "anthropic",
      route: "/docs/*",
      potentialMicros: 10_000,
      bytes: 500,
    }),
    // Seen, but too weakly identified to bill: contributes hits and bytes, and
    // exactly zero potential revenue.
    event({
      at: T0 + 3,
      agent: "ccbot",
      operator: "commoncrawl",
      confidence: "ua-only",
      reason: "below-min-confidence",
      route: null,
      priceMicros: null,
      potentialMicros: null,
      bytes: 750,
    }),
    // Not a crawler at all.
    event({
      at: T0 + 4,
      agent: null,
      operator: null,
      confidence: null,
      reason: "not-a-crawler",
      route: null,
      priceMicros: null,
      potentialMicros: null,
      bytes: 3_000,
    }),
  ];
}

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

for (const backend of backends) {
  describe.skipIf(!backend.available)(`store contract: ${backend.name}`, () => {
    let store: Store | null = null;

    async function open(): Promise<Store> {
      store = await backend.create();
      return store;
    }

    afterEach(async () => {
      await store?.close();
      store = null;
    });

    it("returns a zeroed summary when empty, never undefined", async () => {
      const summary = await (await open()).summary();

      expect(summary.totals).toEqual({ hits: 0, bytes: 0, bytesMeasured: 0, potentialMicros: 0 });
      expect(summary.byAgent).toEqual([]);
      expect(summary.byOperator).toEqual([]);
      expect(summary.byRoute).toEqual([]);
      expect(summary.byReason).toEqual([]);
    });

    it("shows a recorded event in the summary", async () => {
      const subject = await open();
      subject.record(event());
      await subject.flush();

      const summary = await subject.summary();
      expect(summary.totals.hits).toBe(1);
      expect(summary.totals.bytes).toBe(1_000);
      expect(summary.totals.potentialMicros).toBe(50_000);
    });

    it("records without blocking the caller", async () => {
      // `record` is fire and forget by design: the write must never be on the
      // critical path of somebody else's response.
      const subject = await open();
      expect(subject.record(event())).toBeUndefined();
      await subject.flush();
      expect((await subject.summary()).totals.hits).toBe(1);
    });

    it("sums potential revenue by agent and by route", async () => {
      const subject = await open();
      for (const each of sampleEvents()) subject.record(each);
      await subject.flush();

      const summary = await subject.summary();
      const byAgent = Object.fromEntries(
        summary.byAgent.map((bucket) => [bucket.key, bucket.potentialMicros]),
      );
      expect(byAgent["gptbot"]).toBe(100_000);
      expect(byAgent["claudebot"]).toBe(10_000);
      expect(byAgent["ccbot"]).toBe(0);

      const byRoute = Object.fromEntries(
        summary.byRoute.map((bucket) => [bucket.key, bucket.potentialMicros]),
      );
      expect(byRoute["/blog/*"]).toBe(100_000);
      expect(byRoute["/docs/*"]).toBe(10_000);
    });

    it("keeps the weakly identified slice visible but worth nothing", async () => {
      const subject = await open();
      for (const each of sampleEvents()) subject.record(each);
      await subject.flush();

      const summary = await subject.summary();
      const weak = summary.byReason.find((bucket) => bucket.key === "below-min-confidence");
      expect(weak?.hits).toBe(1);
      expect(weak?.bytes).toBe(750);
      expect(weak?.potentialMicros).toBe(0);
    });

    it("labels traffic that matched no crawler", async () => {
      const subject = await open();
      for (const each of sampleEvents()) subject.record(each);
      await subject.flush();

      const summary = await subject.summary();
      const bucket = summary.byAgent.find((each) => each.key === NOT_A_CRAWLER_KEY);
      expect(bucket?.hits).toBe(1);
      expect(bucket?.potentialMicros).toBe(0);
    });

    it("sums only the sizes it could measure, and says how many that was", async () => {
      // An unmeasured hit is not a zero-byte hit. Counting it as zero would
      // understate what the crawlers cost; ignoring it silently would hide how
      // much of the total the byte figure actually covers.
      const subject = await open();
      subject.record(event({ agent: "claudebot", operator: "anthropic", bytes: 500 }));
      // Seen by an adapter that cannot measure the response (the Next.js proxy).
      subject.record(event({ agent: "claudebot", operator: "anthropic", bytes: null }));
      subject.record(event({ agent: "gptbot", bytes: 1_000 }));
      await subject.flush();

      const summary = await subject.summary();
      expect(summary.totals.hits).toBe(3);
      expect(summary.totals.bytesMeasured).toBe(2);
      expect(summary.totals.bytes).toBe(1_500);

      const claude = summary.byAgent.find((bucket) => bucket.key === "claudebot");
      expect(claude?.hits).toBe(2);
      expect(claude?.bytesMeasured).toBe(1);
      expect(claude?.bytes).toBe(500);
    });

    it("keeps every sum an integer", async () => {
      const subject = await open();
      for (const each of sampleEvents()) subject.record(each);
      await subject.flush();

      const summary = await subject.summary();
      expect(Number.isInteger(summary.totals.potentialMicros)).toBe(true);
      expect(Number.isInteger(summary.totals.bytes)).toBe(true);
      for (const bucket of summary.byAgent) {
        expect(Number.isInteger(bucket.potentialMicros), bucket.key).toBe(true);
      }
    });

    it("filters by time range, inclusive start and exclusive end", async () => {
      const subject = await open();
      for (const each of sampleEvents()) subject.record(each);
      await subject.flush();

      expect((await subject.summary({ from: T0, to: T0 + 2 })).totals.hits).toBe(2);
      expect((await subject.summary({ from: T0 + 2 })).totals.hits).toBe(3);
      expect((await subject.summary({ to: T0 })).totals.hits).toBe(0);
    });

    it("totals match the sum of the buckets", async () => {
      const subject = await open();
      for (const each of sampleEvents()) subject.record(each);
      await subject.flush();

      const summary = await subject.summary();
      const fromBuckets = summary.byAgent.reduce(
        (sum, bucket) => sum + bucket.potentialMicros,
        0,
      );
      expect(fromBuckets).toBe(summary.totals.potentialMicros);
      expect(summary.byAgent.reduce((sum, bucket) => sum + bucket.hits, 0)).toBe(
        summary.totals.hits,
      );
    });

    it("orders buckets biggest first, deterministically", async () => {
      const subject = await open();
      for (const each of sampleEvents()) subject.record(each);
      await subject.flush();

      const summary = await subject.summary();
      const potentials = summary.byAgent.map((bucket) => bucket.potentialMicros);
      expect(potentials).toEqual([...potentials].sort((a, b) => b - a));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Cross-backend agreement                                                     */
/* -------------------------------------------------------------------------- */

describe("backends agree", () => {
  it("produces byte-identical summaries from memory and sqlite", async () => {
    // Memory sums in JavaScript, sqlite sums in SQL. If the two ever disagree,
    // the operator's numbers depend on a config flag, which would be worse than
    // either being slightly wrong.
    const memory = createMemoryStore();
    const sqlite = await createSqliteStore({ path: ":memory:" });
    try {
      for (const each of sampleEvents()) {
        memory.record(each);
        sqlite.record(each);
      }
      await Promise.all([memory.flush(), sqlite.flush()]);

      expect(await sqlite.summary()).toEqual(await memory.summary());
    } finally {
      await memory.close();
      await sqlite.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Memory store specifics                                                      */
/* -------------------------------------------------------------------------- */

describe("the memory store", () => {
  it("drops the oldest events rather than growing without bound", async () => {
    // It lives in a long-running server. An unbounded array is a memory leak
    // with a delay fuse, and dropping old analytics beats taking the site down.
    const store = createMemoryStore({ maxEvents: 3 });
    for (let i = 0; i < 10; i += 1) store.record(event({ at: T0 + i }));

    expect(store.events).toHaveLength(3);
    expect(store.dropped).toBe(7);
    expect(store.events[0]?.at).toBe(T0 + 7);
    expect((await store.summary()).totals.hits).toBe(3);
  });
});

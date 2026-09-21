/**
 * `crawlmeter report` — read the store, print the report.
 *
 *     npx crawlmeter report
 *     npx crawlmeter report --db ./data/crawlmeter.db --since 30d
 *     npx crawlmeter report --db "$DATABASE_URL" --json
 *
 * The command reads a persistent store: a SQLite file, or a Postgres database.
 * It cannot read the in-memory store, which lives inside the server process
 * and dies with it.
 *
 * It refuses to report on a SQLite file that does not exist. SQLite would
 * happily create an empty one, and the report would then say "no crawler
 * traffic" about a database that was simply mistyped — a confident zero is the
 * one kind of wrong this product cannot afford.
 *
 * `main` takes its input and output as arguments so the tests can drive it
 * without spawning a process; `src/cli.ts` wires it to the real ones.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { createPostgresStore } from "../store/postgres.js";
import { createSqliteStore } from "../store/sqlite.js";
import type { Store } from "../store/types.js";
import { formatReport } from "./format.js";
import { buildReport } from "./index.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  now(): number;
  readonly version: string;
}

/** Exit codes: success, a failure while running, a mistake in the command. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const HELP = `Usage: crawlmeter report [options]

Print how much AI crawler traffic your site served, and what it would have
been worth had you been charging for it.

Options:
  --db <file|url>     SQLite file or postgres:// URL the middleware writes to.
                      Default: $CRAWLMETER_DB, then ./crawlmeter.db
  --since <when>      24h, 7d, 30d (any number of h or d), a date such as
                      2026-09-01, or "all". Default: all
  --json              Print the report as JSON.
  -h, --help          Show this help.
  -v, --version       Show the version.

The in-memory store cannot be reported on from here: it lives inside your
server process. Configure the middleware with createSqliteStore or
createPostgresStore to keep history the command can read.
`;

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`crawlmeter: ${messageOf(error)}\n\n${HELP}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  if (values.version === true) {
    io.stdout(`${io.version}\n`);
    return EXIT_OK;
  }
  if (values.help === true || positionals.length === 0) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  if (positionals[0] !== "report" || positionals.length > 1) {
    io.stderr(`crawlmeter: unknown command "${positionals.join(" ")}"\n\n${HELP}`);
    return EXIT_USAGE;
  }

  let since: number | null;
  try {
    since = parseSince(values.since ?? "all", io.now());
  } catch (error) {
    io.stderr(`crawlmeter: ${messageOf(error)}\n`);
    return EXIT_USAGE;
  }

  const target = values.db ?? io.env["CRAWLMETER_DB"] ?? "crawlmeter.db";
  let store: Store;
  try {
    store = await openStore(target, io.cwd);
  } catch (error) {
    io.stderr(`crawlmeter: ${messageOf(error)}\n`);
    return EXIT_FAILURE;
  }

  try {
    const summary = await store.summary(since === null ? undefined : { from: since });
    const report = buildReport(summary, { since });
    io.stdout(
      values.json === true
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatReport(report, { source: describeSource(target) }),
    );
    return EXIT_OK;
  } catch (error) {
    io.stderr(`crawlmeter: could not read ${describeSource(target)}: ${messageOf(error)}\n`);
    return EXIT_FAILURE;
  } finally {
    await store.close().catch(() => {});
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      db: { type: "string" },
      since: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

function isPostgres(target: string): boolean {
  return /^postgres(ql)?:\/\//i.test(target);
}

async function openStore(target: string, cwd: string): Promise<Store> {
  if (isPostgres(target)) return createPostgresStore({ url: target });

  const path = resolve(cwd, target);
  if (!existsSync(path)) {
    throw new Error(
      `no crawlmeter database at ${path}. Point --db at the file your middleware writes to ` +
        `(the path given to createSqliteStore), or set CRAWLMETER_DB.`,
    );
  }
  return createSqliteStore({ path });
}

/**
 * What to call the store in the report's title.
 *
 * A Postgres URL usually carries a password. It must never be printed — the
 * report ends up in terminals, CI logs and screenshots.
 */
export function describeSource(target: string): string {
  if (!isPostgres(target)) return target;
  try {
    const url = new URL(target);
    return `${url.protocol}//${url.hostname}${url.port === "" ? "" : `:${url.port}`}${url.pathname}`;
  } catch {
    return "postgres database";
  }
}

/** `24h`, `7d`, a date, or `all`. Returns epoch ms, or null for everything. */
export function parseSince(spec: string, now: number): number | null {
  const value = spec.trim().toLowerCase();
  if (value === "all") return null;

  const relative = /^(\d+)([hd])$/.exec(value);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2] === "h" ? 3_600_000 : 86_400_000;
    return now - amount * unit;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const at = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isNaN(at)) return at;
  }

  throw new Error(`--since must be like 24h, 7d, 2026-09-01 or all, not "${spec}"`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

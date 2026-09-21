import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  describeSource,
  main,
  parseSince,
  type CliIo,
} from "../../src/report/cli.js";
import type { Report } from "../../src/report/index.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import { eventFromDecision } from "../../src/store/types.js";
import { money, type Decision } from "../../src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = Date.parse("2026-09-21T12:00:00Z");
const DAY = 86_400_000;

let dir = "";
let db = "";

/** Output captured from one run of `main`. */
function io(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    cwd: dir,
    now: () => NOW,
    version: "0.1.0",
    ...overrides,
  };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

const BILLABLE: Decision = {
  action: "pass",
  reason: "observe-mode",
  route: "*",
  price: money(10_000),
  potential: money(10_000),
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crawlmeter-cli-"));
  db = join(dir, "crawlmeter.db");
  const store = await createSqliteStore({ path: db });
  // Two crawler hits this week, one a month ago.
  for (const at of [NOW - DAY, NOW - 2 * DAY, NOW - 40 * DAY]) {
    store.record(
      eventFromDecision(BILLABLE, {
        method: "GET",
        path: "/blog/post",
        agent: "gptbot",
        operator: "openai",
        confidence: "ip-range",
        bytes: 47_000,
        at,
      }),
    );
  }
  await store.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("crawlmeter report", () => {
  it("prints the report for a SQLite file", async () => {
    const run = io();
    const code = await main(["report", "--db", db], run.io);

    expect(code).toBe(EXIT_OK);
    expect(run.out()).toContain("AI crawlers made 3 requests");
    expect(run.out()).toContain("they would have paid USD 0.03");
    expect(run.err()).toBe("");
  });

  it("finds ./crawlmeter.db by default", async () => {
    const run = io();
    expect(await main(["report"], run.io)).toBe(EXIT_OK);
    expect(run.out()).toContain("AI crawlers made 3 requests");
  });

  it("reads the database from CRAWLMETER_DB", async () => {
    const run = io({ cwd: tmpdir(), env: { CRAWLMETER_DB: db } });
    expect(await main(["report"], run.io)).toBe(EXIT_OK);
    expect(run.out()).toContain("AI crawlers made 3 requests");
  });

  it("limits the report to a time window", async () => {
    const run = io();
    await main(["report", "--db", db, "--since", "7d"], run.io);

    expect(run.out()).toContain("AI crawlers made 2 requests");
    expect(run.out().split("\n")[0]).toContain("since 2026-09-14");
  });

  it("prints JSON that carries the same numbers", async () => {
    const run = io();
    await main(["report", "--db", db, "--json"], run.io);

    const report = JSON.parse(run.out()) as Report;
    expect(report.totals.hits).toBe(3);
    expect(report.totals.potentialMicros).toBe(30_000);
    expect(report.crawlers[0]?.key).toBe("gptbot");
  });

  it("refuses a database that does not exist, and does not create one", async () => {
    // SQLite would create an empty file, and the report would then say
    // "no crawler traffic" about a path that was simply mistyped.
    const missing = join(dir, "typo.db");
    const run = io();

    expect(await main(["report", "--db", missing], run.io)).toBe(EXIT_FAILURE);
    expect(run.err()).toContain("no crawlmeter database at");
    expect(run.out()).toBe("");
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects a malformed --since as a usage error", async () => {
    const run = io();
    expect(await main(["report", "--db", db, "--since", "yesterday"], run.io)).toBe(EXIT_USAGE);
    expect(run.err()).toContain("--since must be like");
  });

  it("rejects an unknown command and option", async () => {
    expect(await main(["reprot"], io().io)).toBe(EXIT_USAGE);
    expect(await main(["report", "--dbb", db], io().io)).toBe(EXIT_USAGE);
  });

  it("prints help and the version", async () => {
    const help = io();
    expect(await main(["--help"], help.io)).toBe(EXIT_OK);
    expect(help.out()).toContain("Usage: crawlmeter report");

    const bare = io();
    expect(await main([], bare.io)).toBe(EXIT_OK);
    expect(bare.out()).toContain("Usage: crawlmeter report");

    const version = io();
    expect(await main(["--version"], version.io)).toBe(EXIT_OK);
    expect(version.out()).toBe("0.1.0\n");
  });
});

describe("describeSource", () => {
  it("never prints a database password", () => {
    // The title ends up in terminals, CI logs and screenshots.
    const title = describeSource("postgres://crawl:s3cr3t-p4ss@db.example.com:5432/app");
    expect(title).toBe("postgres://db.example.com:5432/app");
    expect(title).not.toContain("s3cr3t");
  });

  it("leaves file paths as they are", () => {
    expect(describeSource("./crawlmeter.db")).toBe("./crawlmeter.db");
  });
});

describe("parseSince", () => {
  it("reads hours, days, dates and all", () => {
    expect(parseSince("24h", NOW)).toBe(NOW - 24 * 3_600_000);
    expect(parseSince("30d", NOW)).toBe(NOW - 30 * DAY);
    expect(parseSince("2026-09-01", NOW)).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(parseSince("all", NOW)).toBeNull();
  });

  it("refuses anything else", () => {
    for (const bad of ["", "yesterday", "7w", "2026-13-45", "-1d"]) {
      expect(() => parseSince(bad, NOW), bad).toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The binary as it ships                                                      */
/* -------------------------------------------------------------------------- */

describe("the crawlmeter binary", () => {
  const BUILD = join(ROOT, ".test-build", "cli");

  beforeAll(() => {
    // Laid out as the published package: dist/ beside package.json.
    rmSync(BUILD, { recursive: true, force: true });
    execFileSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.build.json",
        "--outDir",
        join(BUILD, "dist"),
      ],
      { cwd: ROOT, stdio: "pipe" },
    );
    copyFileSync(join(ROOT, "package.json"), join(BUILD, "package.json"));
  }, 120_000);

  afterAll(() => {
    rmSync(BUILD, { recursive: true, force: true });
    try {
      rmdirSync(join(ROOT, ".test-build"));
    } catch {
      // Another test file still owns something in there.
    }
  });

  function run(args: string[]) {
    return spawnSync(process.execPath, [join(BUILD, "dist", "cli.js"), ...args], {
      encoding: "utf8",
      cwd: dir,
    });
  }

  it("starts with a shebang, so npm can link it as a command", () => {
    expect(readFileSync(join(BUILD, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("reports the version from the package it ships in", () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(run(["--version"]).stdout.trim()).toBe(version);
  });

  it("still works when its package.json is not beside it", () => {
    // Bundled or copied somewhere else: --version degrades, the report does not.
    const loose = join(dir, "loose");
    execFileSync(process.execPath, ["-e", `require("fs").cpSync(${JSON.stringify(join(BUILD, "dist"))}, ${JSON.stringify(loose)}, { recursive: true })`]);
    const result = spawnSync(process.execPath, [join(loose, "cli.js"), "--version"], { encoding: "utf8" });
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout.trim()).toBe("unknown");
  });

  it("prints the report and exits 0, without the node:sqlite warning", () => {
    const result = run(["report", "--db", db]);
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain("AI crawlers made 3 requests");
    // Node warns that node:sqlite is experimental. That is noise in a report a
    // person asked for, and the binary silences it in its own process.
    expect(result.stderr).not.toContain("ExperimentalWarning");
  });

  it("exits 1 on a missing database and 2 on a usage error", () => {
    expect(run(["report", "--db", join(dir, "missing.db")]).status).toBe(EXIT_FAILURE);
    expect(run(["report", "--since", "soon"]).status).toBe(EXIT_USAGE);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSqliteStore } from "../../src/store/sqlite.js";
import type { Summary } from "../../src/store/types.js";

/**
 * crawlmeter inside a real Next.js 16 server.
 *
 * The example app is built with `next build` and served with `next start`, and
 * real HTTP requests go through the real proxy pipeline. The proxy resolves
 * `crawlmeter` and `crawlmeter/next` the way a user's app would — through the
 * package's own `exports`, into the built `dist/`. Events land in a SQLite file,
 * read back from outside the server: the same path the report takes.
 *
 * The only change from the shipped example is the detector. The real one would
 * fetch OpenAI's published ranges over the internet; this one is given OpenAI's
 * prefix in advance, so the test is deterministic and offline and can still
 * tell a forged address from a real one.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = join(ROOT, ".test-build", "next-real");
const DB = join(APP, "crawlmeter.db");
const NEXT = join(ROOT, "node_modules", "next", "dist", "bin", "next");

const OPENAI_IP = "132.196.86.5";
const REAL_CLIENT = "203.0.113.9";

/** The example's proxy, with an offline detector that knows OpenAI's range. */
const PROXY = `
import { createDetector, createSqliteStore, parseCidr } from "crawlmeter";
import { crawlmeter } from "crawlmeter/next";

const openai = [parseCidr("132.196.86.0/24")];

export const proxy = crawlmeter({
  price: "$0.01",
  routes: { "/api/*": "$0.05" },
  store: createSqliteStore({ path: process.env.CRAWLMETER_DB }),
  detector: createDetector({ ipRanges: { get: async () => openai }, resolver: null }),
  onWarning: (message) => console.log("[crawlmeter warning]", message),
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
`;

let server: ChildProcess | null = null;
let base = "";
let log = "";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolvePort(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error(`next start did not come up within ${timeoutMs} ms:\n${log}`);
}

function get(path: string, headers: Record<string, string>) {
  return fetch(`${base}${path}`, { headers });
}

async function summary(): Promise<Summary> {
  // Give the proxy's write queue a moment, then read the file from outside
  // the server — exactly what `crawlmeter report` will do.
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const store = await createSqliteStore({ path: DB });
  try {
    return await store.summary();
  } finally {
    await store.close();
  }
}

beforeAll(async () => {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });

  // `crawlmeter` resolves through the package's own exports into dist/,
  // which test/global-setup.ts built once before any suite started.

  cpSync(join(ROOT, "examples", "next-observe"), APP, { recursive: true });
  writeFileSync(join(APP, "proxy.js"), PROXY);
  // Its own config, so Next.js does not pick up this repository's tsconfig
  // and its source aliases. A user's app always has its own.
  writeFileSync(join(APP, "jsconfig.json"), JSON.stringify({ compilerOptions: {} }));

  execFileSync(process.execPath, [NEXT, "build", APP], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [NEXT, "start", APP, "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: { ...process.env, CRAWLMETER_DB: DB, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  await waitFor(`${base}/blog/hello`, 60_000);
}, 180_000);

afterAll(async () => {
  if (server !== null && server.exitCode === null) {
    const exited = new Promise((resolveExit) => server?.once("exit", resolveExit));
    server.kill();
    await exited;
  }
  rmSync(APP, { recursive: true, force: true });
  try {
    rmdirSync(join(ROOT, ".test-build"));
  } catch {
    // Another test file still owns something in there.
  }
});

describe("crawlmeter in a real Next.js server", () => {
  it("serves visitors and crawlers alike, and records only the crawlers", async () => {
    const browser = await get("/blog/hello", { "user-agent": "Mozilla/5.0 Chrome/140" });
    const crawler = await get("/blog/hello", { "user-agent": "GPTBot/1.4" });

    expect(browser.status).toBe(200);
    expect(await browser.text()).toContain("hello from the blog");
    expect(crawler.status).toBe(200);
    expect(await crawler.text()).toContain("hello from the blog");

    const recorded = await summary();
    expect(recorded.byAgent.map((bucket) => bucket.key)).toEqual(["gptbot"]);
    expect(log).not.toContain("[crawlmeter warning]");
  });

  it("records sizes as unmeasured, because the proxy never sees the page", async () => {
    await get("/api/things", { "user-agent": "ClaudeBot/1.0" });
    const recorded = await summary();

    expect(recorded.totals.hits).toBeGreaterThan(0);
    expect(recorded.totals.bytesMeasured).toBe(0);
  });

  it("ignores a forged address when a proxy appended the real one", async () => {
    // Behind nginx or a load balancer, the client's own X-Forwarded-For comes
    // first and the proxy's entry last. The last one is the truth.
    const before = await summary();
    await get("/blog/hello", {
      "user-agent": "GPTBot/1.4",
      "x-forwarded-for": `${OPENAI_IP}, ${REAL_CLIENT}`,
    });
    const after = await summary();

    const weak = (s: Summary) => s.byReason.find((b) => b.key === "below-min-confidence")?.hits ?? 0;
    expect(weak(after)).toBe(weak(before) + 1);
    expect(after.totals.potentialMicros).toBe(before.totals.potentialMicros);
  });

  it("characterises the known limit: bare `next start` believes the client's header", async () => {
    // Pinned on purpose. With nothing in front of it, Next.js fills
    // X-Forwarded-For only when the client did not send one (`??=` in its base
    // server), so a lone forged value reaches the proxy intact and earns
    // ip-range confidence. The docs say: put a proxy in front. If this test
    // ever fails because Next.js started appending the socket address, that is
    // good news — update the docs and invert it.
    const before = await summary();
    await get("/blog/hello", { "user-agent": "GPTBot/1.4", "x-forwarded-for": OPENAI_IP });
    const after = await summary();

    expect(after.totals.potentialMicros).toBe(before.totals.potentialMicros + 10_000);
  });
});

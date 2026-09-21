import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_FREE_PATHS } from "../src/config.js";
import { formatReport } from "../src/report/format.js";
import { buildReport } from "../src/report/index.js";
import { createSqliteStore } from "../src/store/sqlite.js";
import { WEEK_OF_TRAFFIC } from "./fixtures/report.js";

/**
 * The README is the product's first screen. Documentation that lies is worse
 * than none, so these tests hold it to the code: the example report is the real
 * formatter's output, the quickstart runs, the imports exist, the options exist,
 * the links resolve, and the first screen keeps its promise to talk about
 * measurement before it ever mentions money moving.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const WORK = join(ROOT, ".test-build", "readme");

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  try {
    rmdirSync(join(ROOT, ".test-build"));
  } catch {
    // Another test file still owns something in there.
  }
});

/** Fenced code blocks, with their language, in order. */
function codeBlocks(markdown: string): Array<{ lang: string; code: string }> {
  return [...markdown.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((match) => ({
    lang: match[1] ?? "",
    code: match[2] ?? "",
  }));
}

/** The text of one `## ` section, heading excluded. */
function section(heading: string): string {
  const start = README.indexOf(`## ${heading}\n`);
  if (start === -1) throw new Error(`README has no "## ${heading}" section`);
  const rest = README.slice(start + heading.length + 4);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the first screen", () => {
  it("leads with measurement: no pay or toll in the title or first line", () => {
    const [title, , tagline] = README.split("\n");
    for (const line of [title, tagline]) {
      expect(line, line).not.toMatch(/\bpay|\btoll/i);
    }
  });

  it("does not talk about payment or crypto before 'Why install this today'", () => {
    // The audience is site owners who would close the tab at the first sign of
    // a crypto project. Measurement comes first; money moving comes after.
    const before = README.slice(0, README.indexOf("## Why install this today"));
    for (const word of ["payment", "x402", "crypto", "wallet", "usdc", "blockchain", "stablecoin"]) {
      expect(before.toLowerCase(), word).not.toContain(word);
    }
  });

  it("puts its sections in the agreed order", () => {
    const order = [
      "## Quickstart",
      "## What you get",
      "## Why install this today",
      "## State of the market",
      "## How it works",
      "## Configuration",
      "## Known limitations",
    ].map((heading) => README.indexOf(heading));
    expect(order.every((position) => position !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("backs its numbers with sources", () => {
    const opening = README.slice(0, README.indexOf("## Quickstart"));
    expect(opening).toMatch(/\]\(https:\/\/blog\.cloudflare\.com\//);
    expect(section("State of the market")).toMatch(/\]\(https:\/\/www\.coindesk\.com\//);
  });
});

describe("the example report", () => {
  it("is exactly what the formatter prints", () => {
    // Not typed by hand: if the formatter changes, this fails until the README
    // shows what the command really prints.
    const block = codeBlocks(section("What you get")).find((each) => each.lang === "text");
    const expected = formatReport(buildReport(WEEK_OF_TRAFFIC), { source: "crawlmeter.db" });
    expect(block?.code).toBe(expected);
  });
});

describe("the quickstart", () => {
  it("runs, and records a crawler into the database the report reads", async () => {
    const quickstart = codeBlocks(section("Quickstart")).find((each) => each.lang === "js");
    expect(quickstart).toBeDefined();

    mkdirSync(WORK, { recursive: true });
    const db = join(WORK, "crawlmeter.db");
    // The README's code, verbatim, plus the two lines any real app would have:
    // a route to crawl and a way for this test to reach the app.
    const source =
      quickstart!.code.replace('"crawlmeter.db"', JSON.stringify(db)) +
      `app.get("/blog", (request, response) => response.send("hello"));\n` +
      // The quickstart never keeps a handle on the middleware; find it in
      // Express's stack so the test can close the database it opened.
      `const meter = (app.router ?? app._router).stack.map((layer) => layer.handle).find((handle) => handle?.store);\n` +
      `export { app, meter };\n`;
    const file = join(WORK, "quickstart.mjs");
    writeFileSync(file, source);

    const { app, meter } = (await import(pathToFileURL(file).href)) as {
      app: { listen(port: number, host: string, ready: () => void): import("node:http").Server };
      meter: { store: { close(): Promise<void> } };
    };
    const server = await new Promise<import("node:http").Server>((ready) => {
      const started = app.listen(0, "127.0.0.1", () => ready(started));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/blog`, { headers: { "user-agent": "GPTBot/1.4" } });
      expect(response.status).toBe(200);
      await new Promise((settle) => setTimeout(settle, 200));
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }

    // Closed first: Windows will not delete a database file that is still open.
    await meter.store.close();

    const store = await createSqliteStore({ path: db });
    try {
      expect((await store.summary()).byAgent.map((bucket) => bucket.key)).toEqual(["gptbot"]);
    } finally {
      await store.close();
    }
  });
});

describe("everything the README names exists", () => {
  it("every symbol it imports is exported from that entry point", async () => {
    const modules: Record<string, Record<string, unknown>> = {
      crawlmeter: await import("crawlmeter"),
      "crawlmeter/next": await import("crawlmeter/next"),
      "crawlmeter/x402": await import("crawlmeter/x402"),
    };
    const missing: string[] = [];
    for (const { code } of codeBlocks(README)) {
      for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(crawlmeter[^"]*)"/g)) {
        const entry = match[2]!;
        const module = modules[entry];
        for (const name of match[1]!.split(",").map((each) => each.trim()).filter(Boolean)) {
          if (module === undefined || !(name in module)) missing.push(`${name} from "${entry}"`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every entry point it imports is published in package.json", () => {
    const { exports } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    const entries = new Set(
      [...README.matchAll(/from\s*"(crawlmeter[^"]*)"/g)].map((match) =>
        match[1] === "crawlmeter" ? "." : `./${match[1]!.slice("crawlmeter/".length)}`,
      ),
    );
    for (const entry of entries) expect(Object.keys(exports), entry).toContain(entry);
  });

  it("every option in the configuration table is an option the code accepts", () => {
    // Read from the source, so a renamed option cannot survive in the docs.
    const accepted = new Set(
      ["src/config.ts", "src/adapters/core.ts"].flatMap((file) =>
        [...readFileSync(join(ROOT, file), "utf8").matchAll(/readonly (\w+)\?:/g)].map((match) => match[1]!),
      ),
    );
    const table = section("Configuration")
      .split("\n")
      .filter((line) => line.startsWith("| `"));
    const documented = table.flatMap((line) =>
      [...(line.split("|")[1] ?? "").matchAll(/`(\w+)`/g)].map((match) => match[1]!),
    );

    expect(documented.length).toBeGreaterThan(10);
    for (const option of documented) expect(accepted.has(option), option).toBe(true);
  });

  it("states the always-free paths the code really uses", () => {
    const freeRow = section("Configuration")
      .split("\n")
      .find((line) => line.startsWith("| `free`"));
    for (const path of DEFAULT_FREE_PATHS) expect(freeRow, path).toContain(path);
  });

  it("every local link points at a file that exists", () => {
    const local = [...README.matchAll(/\]\(([^)#]+)\)/g)]
      .map((match) => match[1]!)
      .filter((target) => !/^https?:/.test(target));
    expect(local.length).toBeGreaterThan(0);
    for (const target of local) expect(existsSync(join(ROOT, target)), target).toBe(true);
  });
});

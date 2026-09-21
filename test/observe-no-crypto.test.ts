import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE regression test.
 *
 * crawlmeter's promise is that measuring AI crawler traffic needs no wallet, no
 * crypto and no account. In code, that promise is one rule: in observe mode, no
 * `@x402/*` module is ever loaded. `@x402/evm` alone brings in `viem`.
 *
 * The rule is easy to break without noticing. One static
 * `import { x402ResourceServer } from "@x402/core/server"` anywhere reachable
 * from `src/index.ts` and every observe-mode install silently loads a
 * cryptocurrency stack. Nothing fails. Tests keep passing. The promise is just
 * gone.
 *
 * So it is checked twice:
 *
 * 1. **Statically**, over the source: walk every import reachable from
 *    `src/index.ts` and fail, naming the file, if any of them is `@x402/*`.
 * 2. **At runtime**, against the built package: in a child process, install a
 *    module hook that throws the moment anything resolves `@x402/*`, then run a
 *    full observe-mode cycle — a real Express app, real crawler requests, one
 *    of them carrying a payment header. Then run the same hook against enforce
 *    mode as a control, to prove the poison actually bites. Without the
 *    control, a hook that never fires would pass this test forever.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BUILD = join(ROOT, ".test-build", "observe-no-crypto");

/* -------------------------------------------------------------------------- */
/* 1. Static                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Source with comments removed, so prose about imports is not read as imports.
 *
 * The lazy loader's own documentation quotes the very pattern it forbids. A
 * scanner that trips over that is a scanner people learn to ignore. Line
 * comments are only stripped after whitespace or at line start, so the `//` in
 * a URL string survives.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** Every import specifier in a TypeScript file, with how it was written. */
function specifiersIn(raw: string): Array<{ specifier: string; kind: "static" | "dynamic-literal" }> {
  const source = withoutComments(raw);
  const found: Array<{ specifier: string; kind: "static" | "dynamic-literal" }> = [];
  const staticImport = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']/g;
  const bareImport = /(?:^|[\s;])import\s*["']([^"']+)["']/g;
  const dynamicLiteral = /import\s*\(\s*["']([^"']+)["']\s*[,)]/g;
  for (const match of source.matchAll(staticImport)) found.push({ specifier: match[1]!, kind: "static" });
  for (const match of source.matchAll(bareImport)) found.push({ specifier: match[1]!, kind: "static" });
  for (const match of source.matchAll(dynamicLiteral)) {
    found.push({ specifier: match[1]!, kind: "dynamic-literal" });
  }
  return found;
}

/** Resolve a relative `.js` import to its `.ts` source. */
function sourceFor(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(from), specifier);
  if (target.endsWith(".json")) return null;
  return target.replace(/\.js$/, ".ts");
}

/**
 * Everything reachable through static imports from the package's observe-mode
 * entry points: `crawlmeter`, `crawlmeter/next`, and the `crawlmeter` binary.
 * All three ship, so all three are held to the rule. (`crawlmeter/x402` is the
 * one entry point that exists to load x402, and is checked separately.)
 */
function reachableFromIndex(): Map<string, Array<{ specifier: string; kind: string }>> {
  const seen = new Map<string, Array<{ specifier: string; kind: string }>>();
  const queue = [join(SRC, "index.ts"), join(SRC, "adapters", "next.ts"), join(SRC, "cli.ts")];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const specifiers = specifiersIn(readFileSync(file, "utf8"));
    seen.set(file, specifiers);
    for (const { specifier, kind } of specifiers) {
      // Dynamic imports are not followed: loading lazily is exactly how the
      // payment code is kept out of observe mode.
      if (kind !== "static") continue;
      const next = sourceFor(file, specifier);
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

function allSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? allSourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("statically, from src/index.ts", () => {
  it("reaches no @x402 module through a static import", () => {
    const offenders: string[] = [];
    for (const [file, specifiers] of reachableFromIndex()) {
      for (const { specifier, kind } of specifiers) {
        if (kind === "static" && specifier.startsWith("@x402/")) {
          offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
        }
      }
    }
    expect(
      offenders,
      "A static @x402 import is reachable from src/index.ts. Observe mode would load a " +
        "crypto stack. Move it behind the lazy loader in src/payment/x402.ts.",
    ).toEqual([]);
  });

  it("names @x402 with a literal import() nowhere in src", () => {
    // A literal dynamic import is lazy at runtime but visible to bundlers,
    // which would pull the payment stack into every edge bundle.
    const offenders = allSourceFiles(SRC).flatMap((file) =>
      specifiersIn(readFileSync(file, "utf8"))
        .filter(({ specifier, kind }) => kind === "dynamic-literal" && specifier.startsWith("@x402/"))
        .map(({ specifier }) => `${relative(ROOT, file)}: import("${specifier}")`),
    );
    expect(offenders).toEqual([]);
  });

  it("mentions @x402 in exactly two files: the lazy loader and the opt-in entry", () => {
    // payment/x402.ts names the packages as strings for its lazy import.
    // payment/modules.ts is `crawlmeter/x402`, which imports them statically so
    // bundled deployments can ship enforce mode. Nothing else may name them.
    const mentioning = allSourceFiles(SRC)
      .filter((file) => /["']@x402\//.test(withoutComments(readFileSync(file, "utf8"))))
      .map((file) => relative(SRC, file).replace(/\\/g, "/"))
      .sort();
    expect(mentioning).toEqual(["payment/modules.ts", "payment/x402.ts"]);
  });

  it("keeps crawlmeter/x402 out of reach of every observe entry point", () => {
    // modules.ts is allowed its static x402 imports ONLY because nothing in
    // `crawlmeter` or `crawlmeter/next` imports it. The day something does,
    // observe mode loads a crypto stack again.
    const reached = [...reachableFromIndex().keys()].map((file) =>
      relative(SRC, file).replace(/\\/g, "/"),
    );
    expect(reached).not.toContain("payment/modules.ts");

    // And it really does import x402 statically — that is its whole job.
    const own = specifiersIn(readFileSync(join(SRC, "payment", "modules.ts"), "utf8"))
      .filter(({ kind, specifier }) => kind === "static" && specifier.startsWith("@x402/"))
      .map(({ specifier }) => specifier)
      .sort();
    expect(own).toEqual([
      "@x402/core/http",
      "@x402/core/server",
      "@x402/core/types",
      "@x402/evm/exact/server",
    ]);
  });

  it("would catch an offender, and ignores one written in a comment", () => {
    // The scanner is the test. Test the scanner.
    expect(specifiersIn(`import { x } from "@x402/core/server";`)).toEqual([
      { specifier: "@x402/core/server", kind: "static" },
    ]);
    expect(specifiersIn(`const m = await import("@x402/evm/exact/server");`)).toEqual([
      { specifier: "@x402/evm/exact/server", kind: "dynamic-literal" },
    ]);
    expect(specifiersIn(`// import("@x402/evm")\n/* from "@x402/core" */`)).toEqual([]);
    expect(specifiersIn(`const url = "https://x402.org"; import "./a.js";`)).toEqual([
      { specifier: "./a.js", kind: "static" },
    ]);
  });

  it("actually walks the graph, rather than passing on an empty one", () => {
    // Guard against the scanner silently finding nothing.
    const reached = [...reachableFromIndex().keys()].map((file) => relative(SRC, file).replace(/\\/g, "/"));
    expect(reached).toContain("adapters/express.ts");
    expect(reached).toContain("payment/gateway.ts");
    expect(reached).toContain("payment/x402.ts");
    expect(reached).toContain("adapters/next.ts");
    expect(reached).toContain("report/cli.ts");
    expect(reached.length).toBeGreaterThan(15);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Runtime, against the built package                                       */
/* -------------------------------------------------------------------------- */

/** A module hook that makes any attempt to resolve @x402/* throw. */
const POISON = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@x402/")) {
    throw new Error("observe-no-crypto: attempted to load " + specifier);
  }
  return nextResolve(specifier, context);
}
`;

const DETECTOR = `async () => ({ agent: "gptbot", operator: "openai", confidence: "ip-range", evidence: [] })`;

const OBSERVE_CYCLE = `
import { register } from "node:module";
register("./poison-x402.mjs", import.meta.url);

// Load the whole public surface, not just the adapter.
const pkg = await import("./index.js");
const express = (await import("express")).default;

const store = pkg.createMemoryStore();
const app = express();
app.use(pkg.crawlmeter({ price: "$0.01", store, onWarning() {}, detector: ${DETECTOR} }));
app.get("/page", (_q, r) => r.send("ok"));

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = "http://127.0.0.1:" + server.address().port;

const plain = await fetch(base + "/page", { headers: { "user-agent": "GPTBot/1.4" } });
// A crawler sending a payment to an observe-mode site must not wake x402 either.
const paying = await fetch(base + "/page", {
  headers: { "user-agent": "GPTBot/1.4", "payment-signature": "anything" },
});
await new Promise((resolve) => setTimeout(resolve, 50));
server.close();

const summary = await store.summary();
console.log(JSON.stringify({
  statuses: [plain.status, paying.status],
  hits: summary.totals.hits,
  potentialMicros: summary.totals.potentialMicros,
}));
`;

const ENFORCE_CONTROL = `
import { register } from "node:module";
register("./poison-x402.mjs", import.meta.url);

const pkg = await import("./index.js");
const meter = pkg.crawlmeter({
  mode: "enforce",
  price: "$0.01",
  payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
  network: "eip155:84532",
  facilitator: "http://127.0.0.1:9",
  session: { secret: "s" },
  onWarning() {},
});
try {
  await meter.ready;
  console.log(JSON.stringify({ ready: "resolved" }));
} catch (error) {
  console.log(JSON.stringify({
    ready: "rejected",
    message: error.message,
    cause: String(error.cause && error.cause.message),
  }));
}
`;

function runChild(name: string, code: string): unknown {
  const script = join(BUILD, name);
  writeFileSync(script, code);
  const result = spawnSync(process.execPath, [script], {
    cwd: BUILD,
    encoding: "utf8",
    timeout: 30_000,
  });
  const line = result.stdout
    .split("\n")
    .map((each) => each.trim())
    .filter((each) => each.startsWith("{"))
    .pop();
  if (result.status !== 0 || line === undefined) {
    throw new Error(`child ${name} failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  return JSON.parse(line);
}

describe("at runtime, against the built package", () => {
  beforeAll(() => {
    rmSync(BUILD, { recursive: true, force: true });
    mkdirSync(BUILD, { recursive: true });
    // Build exactly what ships, into a directory the test owns.
    execFileSync(
      process.execPath,
      [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", BUILD],
      { cwd: ROOT, stdio: "pipe" },
    );
    writeFileSync(join(BUILD, "poison-x402.mjs"), POISON);
  }, 120_000);

  afterAll(() => {
    // Only this test's own directory: other test files build into .test-build
    // too, and vitest runs files in parallel.
    rmSync(BUILD, { recursive: true, force: true });
    try {
      rmdirSync(join(ROOT, ".test-build"));
    } catch {
      // Not empty: another test is still using it, and will clean up after itself.
    }
  });

  it("runs a full observe-mode cycle with @x402 made impossible to load", () => {
    const result = runChild("observe-cycle.mjs", OBSERVE_CYCLE) as {
      statuses: number[];
      hits: number;
      potentialMicros: number;
    };

    // Served both, recorded both, and put a number on them — the product,
    // working, in a process where x402 cannot exist.
    expect(result.statuses).toEqual([200, 200]);
    expect(result.hits).toBe(2);
    expect(result.potentialMicros).toBe(20_000);
  });

  it("control: the same poison does stop enforce mode, with the install command", () => {
    // Proves the hook bites. If this ever resolves, the observe test above has
    // stopped proving anything.
    const result = runChild("enforce-control.mjs", ENFORCE_CONTROL) as {
      ready: string;
      message: string;
      cause: string;
    };

    expect(result.ready).toBe("rejected");
    expect(result.message).toContain("npm i @x402/core @x402/evm");
    expect(result.cause).toContain("observe-no-crypto: attempted to load @x402/");
  });
});

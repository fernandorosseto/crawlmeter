import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePaymentRequiredHeader } from "@x402/core/http";

/**
 * Enforce mode in a bundled deployment.
 *
 * Vercel and Next.js `output: "standalone"` ship only what their build sees the
 * app use. crawlmeter's default lazy import of x402 is invisible to it —
 * deliberately, so observe mode never loads x402 — and the result is a deploy
 * where enforce mode cannot load x402 and fails open on every request.
 *
 * The fix is `crawlmeter/x402`, which imports x402 statically so the build
 * includes it. This test deploys the same app twice, built the way it ships and
 * copied OUT of this repository, where no parent node_modules can supply a
 * missing package:
 *
 * - with `x402` from `crawlmeter/x402`, a crawler must get a real challenge;
 * - without it — the control — the same deploy must fail open, with a message
 *   that names the bundling cause, not just "install it".
 *
 * The control is what makes the first result mean something. If it ever starts
 * passing with a 402, Next.js has started following the lazy import and the
 * workaround may no longer be needed.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = join(ROOT, ".test-build", "next-standalone");
const NEXT = join(ROOT, "node_modules", "next", "dist", "bin", "next");

function proxySource(withX402: boolean): string {
  return `
import { createDetector, createMemoryStore, parseCidr } from "crawlmeter";
import { crawlmeter } from "crawlmeter/next";
${withX402 ? 'import { x402 } from "crawlmeter/x402";' : ""}

const openai = [parseCidr("132.196.86.0/24")];

export const proxy = crawlmeter({
  mode: "enforce",
  price: "$0.01",
  payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
  network: "eip155:84532",
  facilitator: process.env.FACILITATOR_URL,
  session: { secret: "standalone-secret" },
  store: createMemoryStore(),
  detector: createDetector({ ipRanges: { get: async () => openai }, resolver: null }),
  onWarning: (message) => console.log("[crawlmeter warning]", message),
  ${withX402 ? "x402," : ""}
});
`;
}

interface Deployment {
  dir: string;
  base: string;
  server: ChildProcess;
  log: () => string;
}

const deployments: Record<"fixed" | "control", Deployment | null> = { fixed: null, control: null };
let facilitator: Server | null = null;
let facilitatorUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolvePort(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

/** The standalone server.js — nested, because Next traces from the repo root. */
function findServer(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (entry === "server.js") return path;
    if (statSync(path).isDirectory()) {
      const found = findServer(path);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Build the app as it ships, move it out of the repo, and start it there. */
async function deploy(name: string, withX402: boolean): Promise<Deployment> {
  const app = join(BUILD, name);
  mkdirSync(app, { recursive: true });
  cpSync(join(ROOT, "examples", "next-observe"), app, { recursive: true });
  writeFileSync(join(app, "proxy.js"), proxySource(withX402));
  writeFileSync(join(app, "jsconfig.json"), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(join(app, "next.config.mjs"), `export default { output: "standalone" };\n`);

  execFileSync(process.execPath, [NEXT, "build", app], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

  const dir = mkdtempSync(join(tmpdir(), `crawlmeter-standalone-${name}-`));
  cpSync(join(app, ".next", "standalone"), dir, { recursive: true });
  const entry = findServer(dir);
  if (entry === null) throw new Error(`no server.js in the ${name} standalone output`);

  const port = await freePort();
  let log = "";
  const server = spawn(process.execPath, [entry], {
    cwd: dirname(entry),
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      FACILITATOR_URL: facilitatorUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/blog/hello`);
      // Let the enforce-mode startup (loading x402, reaching the facilitator)
      // finish and report before the tests look at the log.
      await new Promise((wait) => setTimeout(wait, 500));
      return { dir, base, server, log: () => log };
    } catch {
      await new Promise((wait) => setTimeout(wait, 250));
    }
  }
  throw new Error(`${name} standalone server did not come up:\n${log}`);
}

async function stop(deployment: Deployment | null): Promise<void> {
  if (deployment === null) return;
  if (deployment.server.exitCode === null) {
    const exited = new Promise((done) => deployment.server.once("exit", done));
    deployment.server.kill();
    await exited;
  }
  rmSync(deployment.dir, { recursive: true, force: true });
}

beforeAll(async () => {
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  // `crawlmeter` resolves through the package's own exports into dist/,
  // which test/global-setup.ts built once before any suite started.

  facilitator = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      request.url === "/supported"
        ? JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} })
        : "{}",
    );
  });
  await new Promise<void>((ready) => facilitator?.listen(0, "127.0.0.1", ready));
  const address = facilitator.address();
  facilitatorUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  deployments.fixed = await deploy("fixed", true);
  deployments.control = await deploy("control", false);
}, 300_000);

afterAll(async () => {
  await stop(deployments.fixed);
  await stop(deployments.control);
  await new Promise<void>((done) => (facilitator ? facilitator.close(() => done()) : done()));
  rmSync(BUILD, { recursive: true, force: true });
  try {
    rmdirSync(join(ROOT, ".test-build"));
  } catch {
    // Another test file still owns something in there.
  }
}, 60_000);

const CRAWLER = { "user-agent": "GPTBot/1.4", "x-forwarded-for": "132.196.86.5" };

describe("enforce mode in a standalone Next.js deployment", () => {
  it("runs outside this repository, so nothing above it can supply x402", () => {
    expect(deployments.fixed?.dir.startsWith(ROOT)).toBe(false);
    expect(deployments.control?.dir.startsWith(ROOT)).toBe(false);
  });

  it("with crawlmeter/x402: answers a crawler with a real, decodable x402 challenge", async () => {
    const response = await fetch(`${deployments.fixed!.base}/blog/hello`, { headers: CRAWLER });

    expect(response.status).toBe(402);
    expect(response.headers.get("crawler-price")).toBe("USD 0.01");
    const challenge = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    expect(challenge.accepts[0]?.amount).toBe("10000");
    expect(deployments.fixed!.log()).not.toContain("could not load the x402 packages");
  });

  it("control, without it: fails open, and says the bundle left x402 out", async () => {
    const response = await fetch(`${deployments.control!.base}/blog/hello`, { headers: CRAWLER });

    expect(response.status).toBe(200);
    // The message must name the real cause here. x402 IS installed; telling
    // the operator to install it would send them in circles.
    expect(deployments.control!.log()).toContain("the bundle left them out");
    expect(deployments.control!.log()).toContain('"crawlmeter/x402"');
  });

  it("lets ordinary visitors straight through either way", async () => {
    for (const deployment of [deployments.fixed!, deployments.control!]) {
      const response = await fetch(`${deployment.base}/blog/hello`, { headers: { "user-agent": "Mozilla/5.0" } });
      expect(response.status).toBe(200);
    }
  });
});

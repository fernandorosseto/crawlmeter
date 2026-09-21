import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ClientExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { crawlmeter } from "../../src/adapters/express.js";
import type { Detector } from "../../src/detect/index.js";
import { createMemoryStore, type MemoryStore } from "../../src/store/memory.js";

/**
 * A real payment, end to end, with nothing mocked but the blockchain.
 *
 * - The site runs crawlmeter in enforce mode with the REAL x402 loaded through
 *   the real lazy loader.
 * - The crawler is a REAL x402 client with a throwaway wallet, signing a real
 *   EIP-3009 authorization for real USDC on Base Sepolia.
 * - The facilitator is a local stand-in, because a real one would move real
 *   money. It records what it was asked and answers as scripted.
 *
 * So everything crawlmeter does — the challenge it builds, the price it puts in
 * it, how it reads the payment back, what it asks the facilitator, which
 * headers go on the 200 — is exercised against the library it will run with in
 * production, offline.
 */

const NETWORK = "eip155:84532"; // Base Sepolia: a testnet, and one x402 knows USDC on.
const PAY_TO = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0";
const SECRET = "end-to-end-secret";
const GPTBOT = "GPTBot/1.4";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* A stand-in facilitator                                                      */
/* -------------------------------------------------------------------------- */

interface FacilitatorScript {
  /** Answer `GET /supported`. Healthy unless this returns false. */
  healthy?: () => boolean;
  verify?: (body: FacilitatorCall) => { status: number; body: unknown };
  settle?: (body: FacilitatorCall) => { status: number; body: unknown };
}

interface FacilitatorCall {
  readonly paymentPayload: { readonly payload?: { readonly authorization?: { readonly from?: string } } };
  readonly paymentRequirements: { readonly amount: string; readonly payTo: string; readonly network: string };
}

async function startFacilitator(script: FacilitatorScript = {}) {
  const calls = { verify: [] as FacilitatorCall[], settle: [] as FacilitatorCall[] };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      const reply = (status: number, body: unknown, type = "application/json") => {
        response.writeHead(status, { "content-type": type });
        response.end(typeof body === "string" ? body : JSON.stringify(body));
      };

      if (request.method === "GET" && request.url === "/supported") {
        if (script.healthy?.() === false) {
          reply(503, "<html><body>Service Unavailable</body></html>", "text/html");
          return;
        }
        reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} });
        return;
      }

      const call = JSON.parse(raw || "{}") as FacilitatorCall;
      const payer = call.paymentPayload?.payload?.authorization?.from;

      if (request.method === "POST" && request.url === "/verify") {
        calls.verify.push(call);
        const scripted = script.verify?.(call);
        reply(scripted?.status ?? 200, scripted?.body ?? { isValid: true, payer });
        return;
      }

      if (request.method === "POST" && request.url === "/settle") {
        calls.settle.push(call);
        const scripted = script.settle?.(call);
        reply(
          scripted?.status ?? 200,
          scripted?.body ?? {
            success: true,
            transaction: `0x${"ab".repeat(32)}`,
            network: NETWORK,
            payer,
          },
        );
        return;
      }

      reply(404, { error: "not found" });
    });
  });

  const url = await listen(server);
  return { url, calls, server };
}

/* -------------------------------------------------------------------------- */
/* The site                                                                    */
/* -------------------------------------------------------------------------- */

const verifiedGptbot: Detector = () =>
  Promise.resolve({
    agent: "gptbot",
    operator: "openai",
    confidence: "ip-range",
    evidence: ["ua:gptbot", "ip:test"],
  });

async function startSite(facilitator: string, extra: { onError?: (error: unknown) => void } = {}) {
  const store: MemoryStore = createMemoryStore();
  const app = express();
  const meter = crawlmeter({
    mode: "enforce",
    price: "$0.01",
    routes: { "/cheap/*": "$0.001" },
    payTo: PAY_TO,
    network: NETWORK,
    facilitator,
    session: { secret: SECRET },
    detector: verifiedGptbot,
    store,
    onWarning: () => {},
    ...extra,
    // No `payment` option: this is the real gateway, loading the real x402.
  });
  app.use(meter);
  app.get("/blog/hello", (_request, response) => {
    response.type("text/plain").send("hello from the blog");
  });
  app.get("/cheap/thing", (_request, response) => {
    response.type("text/plain").send("cheap thing");
  });
  const url = await listen(createServer(app));
  await meter.ready;
  return { url, store };
}

/* -------------------------------------------------------------------------- */
/* The crawler                                                                 */
/* -------------------------------------------------------------------------- */

function wallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client().register(
    "eip155:*",
    new ClientExactEvmScheme(toClientEvmSigner(account)),
  );
  return { account, client };
}

/** Ask for a page, read the 402, sign what it asks for. */
async function payFor(url: string, crawler = wallet()) {
  const challenge = await fetch(url, { headers: { "user-agent": GPTBOT } });
  const header = challenge.headers.get("payment-required");
  if (header === null) throw new Error(`expected a challenge, got ${challenge.status}`);
  const paymentRequired = decodePaymentRequiredHeader(header);
  const payload = await crawler.client.createPaymentPayload(paymentRequired);
  return { challenge, paymentRequired, signature: encodePaymentSignatureHeader(payload), crawler };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/* -------------------------------------------------------------------------- */

describe("a real x402 payment, end to end", () => {
  it("challenges with a 402 that the real x402 client can read", async () => {
    const facilitator = await startFacilitator();
    const site = await startSite(facilitator.url);

    const response = await fetch(`${site.url}/blog/hello`, { headers: { "user-agent": GPTBOT } });

    expect(response.status).toBe(402);
    expect(response.headers.get("crawler-price")).toBe("USD 0.01");

    const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    expect(paymentRequired.x402Version).toBe(2);
    const [option] = paymentRequired.accepts;
    expect(option?.scheme).toBe("exact");
    expect(option?.network).toBe(NETWORK);
    expect(option?.payTo).toBe(PAY_TO);
    // Decision 6, all the way through: $0.01 is 10000 base units of USDC, exactly.
    expect(option?.amount).toBe("10000");
    expect(paymentRequired.resource.url).toMatch(/\/blog\/hello$/);
  });

  it("serves the page once the crawler pays, with every receipt on the 200", async () => {
    const facilitator = await startFacilitator();
    const site = await startSite(facilitator.url);
    const { signature, crawler } = await payFor(`${site.url}/blog/hello`);

    const response = await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the blog");
    expect(response.headers.get("crawler-charged")).toBe("USD 0.01");
    expect(response.headers.get("crawlmeter-session")).toMatch(/^cm1\./);

    const receipt = decodePaymentResponseHeader(response.headers.get("payment-response")!);
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBe(`0x${"ab".repeat(32)}`);

    // What the facilitator was asked: exactly the price crawlmeter set, paid by
    // the wallet that signed.
    expect(facilitator.calls.verify).toHaveLength(1);
    expect(facilitator.calls.settle).toHaveLength(1);
    expect(facilitator.calls.settle[0]?.paymentRequirements.amount).toBe("10000");
    expect(facilitator.calls.settle[0]?.paymentRequirements.payTo).toBe(PAY_TO);
    expect(facilitator.calls.settle[0]?.paymentPayload.payload?.authorization?.from?.toLowerCase()).toBe(
      crawler.account.address.toLowerCase(),
    );
  });

  it("records the paid request as charged", async () => {
    const facilitator = await startFacilitator();
    const site = await startSite(facilitator.url);
    const { signature } = await payFor(`${site.url}/blog/hello`);

    await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });
    await settle();

    const actions = site.store.events.map((event) => event.action);
    expect(actions).toEqual(["require-payment", "accept-payment"]);
  });

  it("refuses a payment made for a cheaper page, without asking the facilitator", async () => {
    // Pay $0.001 for /cheap, then present that payment at /blog, which costs $0.01.
    const facilitator = await startFacilitator();
    const site = await startSite(facilitator.url);
    const { signature } = await payFor(`${site.url}/cheap/thing`);

    const response = await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });

    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: string }).error).toBe("payment rejected");
    expect(response.headers.get("crawler-charged")).toBeNull();
    expect(facilitator.calls.verify).toHaveLength(0);
    expect(facilitator.calls.settle).toHaveLength(0);
  });

  it("refuses a payment the facilitator calls invalid", async () => {
    const facilitator = await startFacilitator({
      verify: () => ({ status: 200, body: { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" } }),
    });
    const site = await startSite(facilitator.url);
    const { signature } = await payFor(`${site.url}/blog/hello`);

    const response = await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });

    expect(response.status).toBe(402);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toBe("invalid_exact_evm_payload_signature");
    expect(facilitator.calls.settle).toHaveLength(0);
  });

  it("treats a 4xx verdict from the facilitator as a rejection, not an outage", async () => {
    // The real x402 client turns this into a VerifyError. Misreading it as an
    // outage would fail open and hand over the page for a bad payment.
    const facilitator = await startFacilitator({
      verify: () => ({ status: 400, body: { isValid: false, invalidReason: "invalid_scheme" } }),
    });
    const site = await startSite(facilitator.url);
    const { signature } = await payFor(`${site.url}/blog/hello`);

    const response = await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });

    expect(response.status).toBe(402);
  });

  it("refuses a replayed payment", async () => {
    let settled = 0;
    const facilitator = await startFacilitator({
      settle: (call) =>
        settled++ === 0
          ? {
              status: 200,
              body: {
                success: true,
                transaction: `0x${"cd".repeat(32)}`,
                network: NETWORK,
                payer: call.paymentPayload.payload?.authorization?.from,
              },
            }
          : {
              status: 200,
              body: { success: false, errorReason: "nonce_already_used", transaction: "", network: NETWORK },
            },
    });
    const site = await startSite(facilitator.url);
    const { signature } = await payFor(`${site.url}/blog/hello`);
    const paid = { "user-agent": GPTBOT, "payment-signature": signature };

    expect((await fetch(`${site.url}/blog/hello`, { headers: paid })).status).toBe(200);
    const replay = await fetch(`${site.url}/blog/hello`, { headers: paid });

    expect(replay.status).toBe(402);
    expect(((await replay.json()) as { reason: string }).reason).toBe("nonce_already_used");
  });

  it("refuses garbage in payment-signature without ever failing open", async () => {
    const facilitator = await startFacilitator();
    const site = await startSite(facilitator.url);

    for (const junk of ["garbage", "e30=", "eyJ4NDAyVmVyc2lvbiI6Mn0=", "%%%"]) {
      const response = await fetch(`${site.url}/blog/hello`, {
        headers: { "user-agent": GPTBOT, "payment-signature": junk },
      });
      expect(response.status, junk).toBe(402);
    }
    expect(facilitator.calls.verify).toHaveLength(0);
  });

  it("refuses a payment that makes an otherwise healthy facilitator fail", async () => {
    // The bypass this closes: a payment crafted to crash the facilitator's
    // verify used to read as an outage and fail open — free page. Now the
    // gateway asks the facilitator a question carrying no payment; it answers,
    // so the failure belongs to this payment.
    const facilitator = await startFacilitator({
      verify: () => ({ status: 500, body: "<html><body>Internal Server Error</body></html>" }),
    });
    const site = await startSite(facilitator.url, { onError: vi.fn() });
    const { signature } = await payFor(`${site.url}/blog/hello`);

    const response = await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });

    expect(response.status).toBe(402);
    expect(((await response.json()) as { reason: string }).reason).toBe(
      "the facilitator could not process this payment",
    );
    expect(facilitator.calls.settle).toHaveLength(0);
  });

  it("fails open when the facilitator is actually down", async () => {
    // Decision 7. Up at boot, then a real outage: verify fails AND the
    // payment-free health check fails. Serve the page, charge nothing.
    let healthy = true;
    const onError = vi.fn();
    const facilitator = await startFacilitator({
      healthy: () => healthy,
      verify: () => ({ status: 502, body: "<html><body>Bad Gateway</body></html>" }),
    });
    const site = await startSite(facilitator.url, { onError });
    const { signature } = await payFor(`${site.url}/blog/hello`);
    healthy = false;

    const response = await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });
    await settle();

    expect(response.status).toBe(200);
    expect(response.headers.get("crawler-charged")).toBeNull();
    expect(response.headers.get("crawlmeter-session")).toBeNull();
    expect(site.store.events.at(-1)?.reason).toBe("fail-open");
    expect(onError).toHaveBeenCalled();
  });

  it("fails open when the facilitator disappears mid-flight", async () => {
    const onError = vi.fn();
    const facilitator = await startFacilitator();
    const site = await startSite(facilitator.url, { onError });
    const { signature } = await payFor(`${site.url}/blog/hello`);

    facilitator.server.closeAllConnections();
    await new Promise<void>((resolve) => facilitator.server.close(() => resolve()));

    const response = await fetch(`${site.url}/blog/hello`, {
      headers: { "user-agent": GPTBOT, "payment-signature": signature },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("crawler-charged")).toBeNull();
  });
});

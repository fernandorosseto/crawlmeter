import { describe, expect, it } from "vitest";

import { issueSessionToken, verifySessionToken } from "../src/session.js";
import { ConfigError, normalizeConfig } from "../src/config.js";

const SECRET = "a-secret-nobody-should-guess";
const NOW = 1_789_000_000_000;
const TTL = 600;

async function token(overrides: { agent?: string; secret?: string; ttlSeconds?: number; now?: number } = {}) {
  return issueSessionToken(overrides.agent ?? "gptbot", {
    secret: overrides.secret ?? SECRET,
    ttlSeconds: overrides.ttlSeconds ?? TTL,
    now: overrides.now ?? NOW,
  });
}

describe("session tokens", () => {
  it("accepts a fresh token and reports who it was issued to", async () => {
    const session = await verifySessionToken(await token(), { secret: SECRET, now: NOW + 1_000 });

    expect(session?.agent).toBe("gptbot");
    expect(session?.expiresAt).toBe(NOW + TTL * 1000);
  });

  it("accepts a token right up to its expiry and refuses it after", async () => {
    const issued = await token();
    const expiry = NOW + TTL * 1000;

    expect(await verifySessionToken(issued, { secret: SECRET, now: expiry - 1 })).not.toBeNull();
    expect(await verifySessionToken(issued, { secret: SECRET, now: expiry })).toBeNull();
    expect(await verifySessionToken(issued, { secret: SECRET, now: expiry + 1 })).toBeNull();
  });

  it("refuses a token whose signature was tampered with", async () => {
    const issued = await token();
    const parts = issued.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -1)}${
      parts[2]!.endsWith("A") ? "B" : "A"
    }`;

    expect(await verifySessionToken(flipped, { secret: SECRET, now: NOW })).toBeNull();
  });

  it("refuses a token whose payload was edited", async () => {
    // The obvious attack: keep the signature, extend the expiry.
    const issued = await token();
    const [version, , signature] = issued.split(".") as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ agent: "gptbot", expiresAt: NOW + 10_000_000 }),
    ).toString("base64url");

    expect(
      await verifySessionToken(`${version}.${forged}.${signature}`, { secret: SECRET, now: NOW }),
    ).toBeNull();
  });

  it("refuses a token signed with another secret", async () => {
    const issued = await token({ secret: "some-other-secret" });
    expect(await verifySessionToken(issued, { secret: SECRET, now: NOW })).toBeNull();
  });

  it("refuses everything when no secret is configured", async () => {
    const issued = await token();
    expect(await verifySessionToken(issued, { secret: null, now: NOW })).toBeNull();
  });

  it("refuses malformed input without throwing", async () => {
    for (const bad of [
      null,
      undefined,
      "",
      "nonsense",
      "cm1.only-two-parts",
      "cm1.a.b.c.d",
      "cm0.abc.def",
      "cm1.!!!.???",
    ]) {
      expect(await verifySessionToken(bad, { secret: SECRET, now: NOW }), String(bad)).toBeNull();
    }
  });

  it("binds a token to one agent", async () => {
    // A receipt issued to GPTBot is not a free pass for ClaudeBot. The adapter
    // compares this against the identification before honouring the session.
    const session = await verifySessionToken(await token({ agent: "claudebot" }), {
      secret: SECRET,
      now: NOW,
    });
    expect(session?.agent).toBe("claudebot");
  });

  it("issues a token that is already expired when the ttl is zero", async () => {
    const issued = await token({ ttlSeconds: 0 });
    expect(await verifySessionToken(issued, { secret: SECRET, now: NOW })).toBeNull();
  });

  it("produces url-safe tokens", async () => {
    // They travel in a header and may end up in a cookie or a query string.
    expect(await token()).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("the secret is required before enforce can start", () => {
  it("is rejected at config time, not at request time", async () => {
    // Discovering there is no signing secret while a crawler is waiting is too
    // late. config.ts already refuses; this pins that it stays that way.
    expect(() =>
      normalizeConfig({
        mode: "enforce",
        price: "$0.01",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        network: "eip155:8453",
        facilitator: "https://x402.org/facilitator",
      }),
    ).toThrow(ConfigError);
  });

  it("does not require one in observe, where nothing is ever charged", () => {
    expect(() => normalizeConfig({ mode: "observe", price: "$0.01" })).not.toThrow();
  });
});

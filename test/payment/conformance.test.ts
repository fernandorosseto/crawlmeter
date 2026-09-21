import { describe, expect, it } from "vitest";

import { x402ResourceServer } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { SettleError, VerifyError } from "@x402/core/types";
import { convertToTokenAmount } from "@x402/core/utils";
import { ExactEvmScheme as RootExactEvmScheme } from "@x402/evm";
import { ExactEvmScheme as ServerExactEvmScheme } from "@x402/evm/exact/server";

import { loadX402, type X402, type X402ResourceServer } from "../../src/payment/x402.js";
import { money, toAssetAmount, toDecimalAmount } from "../../src/types.js";

/**
 * crawlmeter describes the slice of x402 it uses with its own interfaces, so its
 * published types never name a package the user might not have installed.
 * This file is what keeps those interfaces honest: it holds the real x402 up
 * against them.
 */

/* -------------------------------------------------------------------------- */
/* Compile-time: the real x402 fits crawlmeter's interfaces                    */
/* -------------------------------------------------------------------------- */

// These lines do their work in `tsc --noEmit`. If x402 changes a signature
// crawlmeter depends on, the typecheck fails here instead of in production.
function realServerFits(server: x402ResourceServer): X402ResourceServer {
  return server;
}
const realEncodeRequired: X402["encodePaymentRequiredHeader"] = encodePaymentRequiredHeader;
const realDecodeSignature: X402["decodePaymentSignatureHeader"] = decodePaymentSignatureHeader;
const realEncodeResponse: X402["encodePaymentResponseHeader"] = encodePaymentResponseHeader;

describe("the real x402 fits crawlmeter's interfaces", () => {
  it("type-checks against the installed version", () => {
    // Referenced so the compile-time checks above are not dead code.
    expect([realServerFits, realEncodeRequired, realDecodeSignature, realEncodeResponse]).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime: loadX402 finds everything where 2.26 actually puts it              */
/* -------------------------------------------------------------------------- */

describe("loadX402", () => {
  it("loads every symbol crawlmeter needs", async () => {
    const x402 = await loadX402();
    expect(typeof x402.createResourceServer).toBe("function");
    expect(typeof x402.encodePaymentRequiredHeader).toBe("function");
    expect(typeof x402.decodePaymentSignatureHeader).toBe("function");
    expect(typeof x402.encodePaymentResponseHeader).toBe("function");
  });

  it("recognises the real verdict errors, and only those", async () => {
    // This one predicate decides between "402 again" and "fail open". It has
    // to be tested against the real classes, not stand-ins.
    const { isVerdict } = await loadX402();

    expect(isVerdict(new VerifyError(400, { isValid: false, invalidReason: "invalid_signature" }))).toBe(true);
    expect(
      isVerdict(
        new SettleError(400, {
          success: false,
          errorReason: "insufficient_funds",
          transaction: "",
          network: "eip155:84532",
        }),
      ),
    ).toBe(true);

    expect(isVerdict(new Error("Facilitator verify failed (502): <html>"))).toBe(false);
    expect(isVerdict(new TypeError("fetch failed"))).toBe(false);
  });

  it("builds a health probe on the facilitator's payment-free endpoint", async () => {
    // The probe is what separates "facilitator down" (fail open) from "this
    // payment broke it" (402). It must fail when nothing is listening.
    const { createProbe } = await loadX402();
    const probe = createProbe({ facilitator: "http://127.0.0.1:9", timeoutMs: 1_000 });
    await expect(probe()).rejects.toBeDefined();
  });

  it("builds a resource server without touching the network", async () => {
    const x402 = await loadX402();
    const server = x402.createResourceServer({
      facilitator: "https://facilitator.invalid",
      timeoutMs: 1_000,
    });
    expect(typeof server.buildPaymentRequirements).toBe("function");
  });
});

describe("the ExactEvmScheme trap", () => {
  it("uses the server scheme, which the package root does not export", () => {
    // Both are called ExactEvmScheme. The root one is the CLIENT scheme: it
    // signs payments and needs a wallet. Registering it on a resource server
    // compiles, then fails. The server one parses prices.
    expect(typeof ServerExactEvmScheme.prototype.parsePrice).toBe("function");
    expect("parsePrice" in RootExactEvmScheme.prototype).toBe(false);
    expect(ServerExactEvmScheme).not.toBe(RootExactEvmScheme);
  });
});

/* -------------------------------------------------------------------------- */
/* Decision 6: the price survives the trip into x402 exactly                   */
/* -------------------------------------------------------------------------- */

describe("price conversion into x402", () => {
  it("round-trips every price through x402's own conversion, exactly", () => {
    // The prices that break float arithmetic are the ones that matter:
    // 0.07 * 1e6 is 70000.00000000001 in JavaScript.
    const micros = [1, 7, 10, 70_000, 290_000, 10_000, 999_999, 1_000_000, 1_230_000, 123_456_789];
    for (const value of micros) {
      const price = money(value);
      expect(convertToTokenAmount(toDecimalAmount(price), 6), String(value)).toBe(toAssetAmount(price));
    }
  });

  it("formats with exactly six decimals, so nothing is truncated on the way in", () => {
    // x402 truncates past the asset's decimals rather than rejecting. Six
    // decimals, always, means there is never anything to truncate.
    expect(toDecimalAmount(money(10_000))).toBe("0.010000");
    expect(toDecimalAmount(money(1))).toBe("0.000001");
    expect(toDecimalAmount(money(1_500_000))).toBe("1.500000");
  });
});

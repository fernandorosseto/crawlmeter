import { describe, expect, it } from "vitest";

import { detectSignature, parseSignatureAgent } from "../../src/detect/signature.js";
import { confidenceRank } from "../../src/types.js";

const SIGNATURE = "sig1=:dGVzdA==:";
const SIGNATURE_INPUT = 'sig1=("@authority" "@path");created=1789000000;keyid="abc";alg="ed25519"';

describe("detectSignature", () => {
  it("reports presence when both rfc 9421 headers are there", () => {
    expect(
      detectSignature({ signature: SIGNATURE, signatureInput: SIGNATURE_INPUT }),
    ).toEqual({ present: true, agentUrl: null });
  });

  it("reports absence when either header is missing", () => {
    expect(detectSignature({ signature: SIGNATURE }).present).toBe(false);
    expect(detectSignature({ signatureInput: SIGNATURE_INPUT }).present).toBe(false);
    expect(detectSignature({}).present).toBe(false);
  });

  it("ignores empty header values", () => {
    expect(detectSignature({ signature: "", signatureInput: SIGNATURE_INPUT }).present).toBe(false);
  });

  it("reads the signature-agent url", () => {
    const result = detectSignature({
      signature: SIGNATURE,
      signatureInput: SIGNATURE_INPUT,
      signatureAgent: '"https://crawler.example"',
    });
    expect(result.agentUrl).toBe("https://crawler.example");
  });

  it("does not throw on a malformed signature-agent", () => {
    const result = detectSignature({
      signature: SIGNATURE,
      signatureInput: SIGNATURE_INPUT,
      signatureAgent: "https://crawler.example",
    });
    expect(result.present).toBe(true);
    expect(result.agentUrl).toBeNull();
  });
});

describe("parseSignatureAgent", () => {
  it("unwraps a structured-field string", () => {
    expect(parseSignatureAgent('"https://a.example"')).toBe("https://a.example");
  });

  it("unescapes quotes and backslashes", () => {
    expect(parseSignatureAgent('"a\\"b"')).toBe('a"b');
    expect(parseSignatureAgent('"a\\\\b"')).toBe("a\\b");
  });

  it("rejects anything that is not one well-formed quoted string", () => {
    expect(parseSignatureAgent("unquoted")).toBeNull();
    expect(parseSignatureAgent('"a" "b"')).toBeNull();
    expect(parseSignatureAgent('"unterminated')).toBeNull();
    expect(parseSignatureAgent('"bad\\escape"')).toBeNull();
    expect(parseSignatureAgent('""')).toBeNull();
    expect(parseSignatureAgent(null)).toBeNull();
    expect(parseSignatureAgent(undefined)).toBeNull();
  });
});

describe("the rank of signed-unverified", () => {
  it("sits below ip-range, because an unverified header proves nothing", () => {
    // This is a product decision, not an implementation detail: attaching
    // RFC 9421 headers is as forgeable as setting a User-Agent. Presenting it
    // as strong evidence would build false confidence into the billing path.
    expect(confidenceRank("signed-unverified")).toBeLessThan(confidenceRank("ip-range"));
    expect(confidenceRank("signed-unverified")).toBeGreaterThan(confidenceRank("ua-only"));
  });
});

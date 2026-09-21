/**
 * Layer 4 by name, second-weakest by rank: HTTP Message Signatures (RFC 9421).
 *
 * Produces `signed-unverified`, and that name is the whole point. v0.1 detects
 * that the headers are there and reads `Signature-Agent`; it does NOT verify
 * the signature against the operator's published key. Attaching headers proves
 * nothing — it is as forgeable as a User-Agent — which is why this level sits
 * BELOW `ip-range` despite looking cryptographic.
 *
 * Full verification (JWKS fetch, signature base reconstruction, Ed25519) is
 * v0.2. Until then, nothing here may be presented as proof.
 */

export interface SignatureDetection {
  /** Both RFC 9421 headers are present. */
  readonly present: boolean;
  /**
   * The URL from the `Signature-Agent` header, when it carries one.
   *
   * Self-declared and unverified, like everything else in this layer. It goes
   * into `evidence` so an operator can see what the request claimed.
   */
  readonly agentUrl: string | null;
}

const ABSENT: SignatureDetection = { present: false, agentUrl: null };

export interface SignatureHeaders {
  readonly signature?: string | null;
  readonly signatureInput?: string | null;
  readonly signatureAgent?: string | null;
}

/**
 * Read the signature headers. Never throws — a malformed header is treated as
 * an absent one.
 */
export function detectSignature(headers: SignatureHeaders): SignatureDetection {
  const present =
    typeof headers.signature === "string" &&
    headers.signature.length > 0 &&
    typeof headers.signatureInput === "string" &&
    headers.signatureInput.length > 0;

  if (!present) return ABSENT;
  return { present: true, agentUrl: parseSignatureAgent(headers.signatureAgent) };
}

/**
 * Parse `Signature-Agent`, a structured-field String: the value is wrapped in
 * double quotes, with `\"` and `\\` escaped.
 *
 * Returns null for anything that is not a well-formed quoted string, rather
 * than guessing at the intent of a malformed header.
 */
export function parseSignatureAgent(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;

  let parsed = "";
  for (let i = 1; i < trimmed.length - 1; i += 1) {
    const char = trimmed[i]!;
    if (char === "\\") {
      const next = trimmed[i + 1];
      if (next !== '"' && next !== "\\") return null;
      parsed += next;
      i += 1;
    } else if (char === '"') {
      // An unescaped quote before the end means this is not one string.
      return null;
    } else {
      parsed += char;
    }
  }
  return parsed.length > 0 ? parsed : null;
}

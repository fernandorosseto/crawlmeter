/**
 * Paid sessions.
 *
 * A crawler that paid for one page should not be billed again for the twelve
 * assets that page pulls in. A session token says "this agent paid, and the
 * receipt is good until this timestamp", and `evaluate()` step 3 lets it
 * through without consulting price or confidence at all.
 *
 * Two choices worth stating:
 *
 * - **WebCrypto, not `node:crypto`.** The Next.js edge adapter has no
 *   `node:crypto`, and a token that only verifies on some runtimes is worse
 *   than no token. WebCrypto exists on Node 22+, Workers and Vercel Edge alike.
 *   The cost is that signing and verifying are async, which the adapter absorbs.
 * - **`crypto.subtle.verify`, not a string comparison.** Comparing signatures
 *   with `===` leaks their contents through timing. The primitive that does it
 *   in constant time is right there, so there is no reason to hand-roll it.
 *
 * The token is a receipt, not a credential: it carries no identity beyond the
 * agent id, and forging it costs an attacker the same effort as forging any
 * HMAC — the secret is the whole defence, which is why enforce mode refuses to
 * start without one.
 */

export interface Session {
  /** Agent id the session was issued to. */
  readonly agent: string;
  /** Epoch milliseconds after which the token is refused. */
  readonly expiresAt: number;
}

/** Token version, so the format can change without accepting old shapes. */
const VERSION = "cm1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Imported HMAC keys, cached by secret.
 *
 * Importing on every request would put a key derivation in the hot path for no
 * benefit — the secret does not change while the process is running.
 */
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const keys = new Map<string, Promise<HmacKey>>();

function keyFor(secret: string): Promise<HmacKey> {
  let key = keys.get(secret);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys.set(secret, key);
  }
  return key;
}

/* -------------------------------------------------------------------------- */
/* base64url                                                                   */
/* -------------------------------------------------------------------------- */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Issue and verify                                                            */
/* -------------------------------------------------------------------------- */

export interface IssueOptions {
  readonly secret: string;
  /** Session lifetime. */
  readonly ttlSeconds: number;
  /** Clock, injectable for tests. */
  readonly now?: number;
}

/** Mint a token for an agent. */
export async function issueSessionToken(
  agent: string,
  options: IssueOptions,
): Promise<string> {
  const now = options.now ?? Date.now();
  const session: Session = {
    agent,
    expiresAt: now + Math.max(0, options.ttlSeconds) * 1000,
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(session)));
  const payload = `${VERSION}.${body}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await keyFor(options.secret),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export interface VerifyOptions {
  /** HMAC secret. Null means sessions are not in use; every token is refused. */
  readonly secret: string | null;
  /** Clock, injectable for tests. */
  readonly now?: number;
}

/**
 * Check a token.
 *
 * Returns the session, or null for every kind of failure — missing, malformed,
 * wrong version, bad signature, signed with another secret, expired. Callers
 * get one answer to one question and cannot accidentally branch on the reason,
 * because to a verifier there is no useful difference between the ways a token
 * can be invalid.
 */
export async function verifySessionToken(
  token: string | null | undefined,
  options: VerifyOptions,
): Promise<Session | null> {
  if (typeof token !== "string" || options.secret === null) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, body, signature] = parts as [string, string, string];
  if (version !== VERSION) return null;

  const signatureBytes = fromBase64Url(signature);
  const bodyBytes = fromBase64Url(body);
  if (signatureBytes === null || bodyBytes === null) return null;

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await keyFor(options.secret),
      signatureBytes,
      encoder.encode(`${version}.${body}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const session = parseSession(bodyBytes);
  if (session === null) return null;

  const now = options.now ?? Date.now();
  return session.expiresAt > now ? session : null;
}

function parseSession(bytes: Uint8Array): Session | null {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { agent, expiresAt } = parsed as { agent?: unknown; expiresAt?: unknown };
    if (typeof agent !== "string" || agent === "") return null;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
    return { agent, expiresAt };
  } catch {
    return null;
  }
}

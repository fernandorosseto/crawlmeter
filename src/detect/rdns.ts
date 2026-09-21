/**
 * Layer 3: reverse DNS with forward confirmation.
 *
 * Produces `rdns`. Stronger than `ip-range` because it is tied to a name the
 * operator controls rather than to a cloud block they rent, and because the
 * forward lookup closes the loop: a PTR record alone proves nothing, since the
 * owner of an address can point it anywhere.
 *
 * This is the one layer that costs a DNS round trip on the request path, so it
 * runs last, under a deadline, and degrades instead of blocking.
 */

import { parseIp } from "./ipRanges.js";

export interface DnsResolver {
  /** PTR lookup: address to hostnames. */
  reverse(ip: string): Promise<readonly string[]>;
  /** Forward lookup: hostname to addresses (A and AAAA). */
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface RdnsResult {
  readonly verified: boolean;
  /** The hostname that matched, when one did. */
  readonly hostname: string | null;
}

const UNVERIFIED: RdnsResult = { verified: false, hostname: null };

/** Default budget for the whole reverse + forward round trip. */
export const DEFAULT_RDNS_TIMEOUT_MS = 500;

/**
 * Confirm that `ip` reverse-resolves into one of `suffixes` and that the name
 * resolves back to `ip`.
 *
 * Never throws and never rejects: a resolver that fails, a name that does not
 * exist and a lookup that runs past the deadline all come back unverified, and
 * the caller falls back to whatever the weaker layers established.
 */
export async function verifyRdns(
  ip: string,
  suffixes: readonly string[],
  resolver: DnsResolver,
  timeoutMs: number = DEFAULT_RDNS_TIMEOUT_MS,
): Promise<RdnsResult> {
  if (suffixes.length === 0) return UNVERIFIED;
  const expected = parseIp(ip);
  if (expected === null) return UNVERIFIED;

  const deadline = withDeadline(timeoutMs);

  const hostnames = await deadline(resolver.reverse(ip), []);
  const hostname = hostnames.find((candidate) => endsWithSuffix(candidate, suffixes));
  if (hostname === undefined) return UNVERIFIED;

  const addresses = await deadline(resolver.resolve(hostname), []);
  const confirmed = addresses.some((address) => sameAddress(address, ip));
  return confirmed ? { verified: true, hostname } : UNVERIFIED;
}

/**
 * True when `hostname` sits under one of the operator's domains.
 *
 * The dot is load-bearing. Without it `notgooglebot.com` ends with
 * `googlebot.com` and anybody who can name a domain can mint an identity.
 */
export function endsWithSuffix(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  return suffixes.some((raw) => {
    const suffix = raw.replace(/^\.|\.$/g, "").toLowerCase();
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

/** Compare two addresses by their bytes, so notation differences do not matter. */
function sameAddress(a: string, b: string): boolean {
  const left = parseIp(a);
  const right = parseIp(b);
  if (left === null || right === null) return false;
  return left.every((byte, index) => byte === right[index]);
}

/** Wrap a promise so it resolves to `fallback` on rejection or on timeout. */
function withDeadline(timeoutMs: number) {
  const start = Date.now();
  return async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), remaining);
          // Never hold the process open for a lookup nobody is waiting on.
          timer.unref?.();
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * Build a resolver from `node:dns`, or null where that module does not exist.
 *
 * Edge runtimes have no DNS. Returning null there is the honest answer: the
 * `rdns` layer is simply unavailable and detection tops out at `ip-range`.
 */
export async function createNodeResolver(): Promise<DnsResolver | null> {
  try {
    const dns = await import("node:dns/promises");
    return {
      reverse: (ip) => dns.reverse(ip),
      resolve: async (hostname) => {
        const [v4, v6] = await Promise.all([
          dns.resolve4(hostname).catch(() => [] as string[]),
          dns.resolve6(hostname).catch(() => [] as string[]),
        ]);
        return [...v4, ...v6];
      },
    };
  } catch {
    return null;
  }
}

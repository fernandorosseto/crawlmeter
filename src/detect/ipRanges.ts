/**
 * Layer 2: published IP ranges.
 *
 * Produces `ip-range`. Hard to forge — the packet really did come from that
 * address — but short of proof, because operators share cloud ranges and
 * published lists go stale.
 *
 * Addresses are normalized to 16 bytes and IPv4 is stored in its IPv4-mapped
 * form (`::ffff:a.b.c.d`). One comparison path, and `::ffff:1.2.3.4` matches an
 * IPv4 prefix for free, because that is the same host arriving over a dual
 * stack. A real IPv6 address still cannot match an IPv4 prefix: the mapping
 * pins the first 96 bits.
 *
 * Every published list seen so far — OpenAI, Anthropic, Google, Perplexity,
 * Apple — uses the same document shape: `{ creationTime, prefixes: [{ ipv4Prefix
 * | ipv6Prefix }] }`. That is the `"prefixes"` format in `agents.json`.
 */

/** An address as 16 bytes, IPv4 held in IPv4-mapped form. */
export type IpBytes = Uint8Array;

export interface Cidr {
  readonly bytes: IpBytes;
  /** Prefix length over the 128-bit space. An IPv4 `/24` is stored as `/120`. */
  readonly bits: number;
  /** The block exactly as published, kept so `evidence` can name what matched. */
  readonly source: string;
}

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** Parse an IPv4 or IPv6 address. Returns null for anything malformed. */
export function parseIp(input: string): IpBytes | null {
  const value = input.trim();
  if (value.length === 0) return null;
  return value.includes(":") ? parseIpv6(value) : parseIpv4(value);
}

function parseIpv4(input: string): IpBytes | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(16);
  bytes.set(V4_MAPPED_PREFIX, 0);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i]!;
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[12 + i] = octet;
  }
  return bytes;
}

function parseIpv6(input: string): IpBytes | null {
  // Zone ids (`%eth0`) carry no routing information for our purposes.
  const value = input.split("%")[0]!;
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : null;
  const groups: string[] = [];

  for (const group of [...head, ...(tail ?? [])]) {
    if (group.includes(".")) {
      // Trailing dotted-quad, as in `::ffff:1.2.3.4`.
      const embedded = parseIpv4(group);
      if (embedded === null) return null;
      groups.push(
        ((embedded[12]! << 8) | embedded[13]!).toString(16),
        ((embedded[14]! << 8) | embedded[15]!).toString(16),
      );
    } else {
      groups.push(group);
    }
  }

  const headLength = tail === null ? groups.length : countGroups(head);
  const tailLength = tail === null ? 0 : groups.length - headLength;
  if (tail === null && groups.length !== 8) return null;
  if (tail !== null && groups.length > 7) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const word = Number.parseInt(group, 16);
    // Head groups sit at the front; tail groups are right-aligned.
    const slot = i < headLength ? i : 8 - (tailLength - (i - headLength));
    bytes[slot * 2] = word >> 8;
    bytes[slot * 2 + 1] = word & 0xff;
  }
  return bytes;
}

/** How many 16-bit groups a dotted-quad-expanded half occupies. */
function countGroups(half: readonly string[]): number {
  let total = 0;
  for (const group of half) total += group.includes(".") ? 2 : 1;
  return total;
}

/** Parse a CIDR block such as `"20.171.0.0/16"` or `"2001:db8::/32"`. */
export function parseCidr(input: string): Cidr | null {
  const slash = input.lastIndexOf("/");
  if (slash === -1) return null;
  const address = input.slice(0, slash);
  const suffix = input.slice(slash + 1);
  if (!/^\d{1,3}$/.test(suffix)) return null;

  const bytes = parseIp(address);
  if (bytes === null) return null;

  const declared = Number(suffix);
  const isV4 = address.includes(".") && !address.includes(":");
  if (declared > (isV4 ? 32 : 128)) return null;
  // An IPv4 `/24` covers the same hosts as `::ffff:a.b.c.0/120`.
  return { bytes, bits: isV4 ? declared + 96 : declared, source: input };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/** True when `ip` falls inside `cidr`. */
export function inCidr(ip: IpBytes, cidr: Cidr): boolean {
  const whole = cidr.bits >> 3;
  for (let i = 0; i < whole; i += 1) {
    if (ip[i] !== cidr.bytes[i]) return false;
  }
  const remainder = cidr.bits & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return (ip[whole]! & mask) === (cidr.bytes[whole]! & mask);
}

/** The first block containing `ip`, or null. Returns the block so callers can
 * put the matched prefix into `evidence` rather than a bare boolean. */
export function findCidr(ip: IpBytes, cidrs: readonly Cidr[]): Cidr | null {
  return cidrs.find((cidr) => inCidr(ip, cidr)) ?? null;
}

/** True when `ip` falls inside any of the blocks. */
export function inAnyCidr(ip: IpBytes, cidrs: readonly Cidr[]): boolean {
  return findCidr(ip, cidrs) !== null;
}

/**
 * Read a published `"prefixes"` document into CIDR blocks.
 *
 * Unparseable rows are dropped rather than rejected wholesale: one bad prefix
 * in a list of two hundred must not blind us to the other hundred and ninety
 * nine.
 */
export function parsePrefixDocument(document: unknown): Cidr[] {
  if (typeof document !== "object" || document === null) return [];
  const prefixes = (document as { prefixes?: unknown }).prefixes;
  if (!Array.isArray(prefixes)) return [];

  const blocks: Cidr[] = [];
  for (const entry of prefixes) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { ipv4Prefix?: unknown; ipv6Prefix?: unknown };
    const raw = typeof row.ipv4Prefix === "string" ? row.ipv4Prefix : row.ipv6Prefix;
    if (typeof raw !== "string") continue;
    const cidr = parseCidr(raw);
    if (cidr !== null) blocks.push(cidr);
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

/** The slice of `fetch` this module needs. Injected, so tests touch no network. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface IpRangeCacheOptions {
  /** How long a fetched list is reused. Default 24h. */
  readonly ttlMs?: number;
  /** How long to wait before retrying after a failure. Default 5 min. */
  readonly retryAfterMs?: number;
  /**
   * The fetch to use, or `null` to disable network entirely.
   *
   * `null` is a supported production setting, not just a test hook: the only
   * outbound traffic this package ever makes is fetching these operator-published
   * lists, and an operator who wants zero outbound traffic turns it off here and
   * accepts that detection tops out at `ua-only`.
   */
  readonly fetch?: FetchLike | null;
  readonly now?: () => number;
}

export interface IpRangeCache {
  /** CIDR blocks for a published list, or an empty array when unavailable. */
  get(url: string): Promise<readonly Cidr[]>;
}

interface CacheEntry {
  readonly blocks: readonly Cidr[];
  readonly expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Cache of published CIDR lists.
 *
 * Never throws and never rejects. An operator having a bad day degrades the
 * request to the layer below — it does not surface as an error in somebody
 * else's request path.
 */
export function createIpRangeCache(options: IpRangeCacheOptions = {}): IpRangeCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const now = options.now ?? Date.now;
  const fetchImpl =
    options.fetch === undefined
      ? (globalThis.fetch as FetchLike | undefined) ?? null
      : options.fetch;

  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<readonly Cidr[]>>();

  async function load(url: string): Promise<readonly Cidr[]> {
    if (fetchImpl === null) return [];
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${String(response.ok)}`);
      const blocks = parsePrefixDocument(await response.json());
      entries.set(url, { blocks, expiresAt: now() + ttlMs });
      return blocks;
    } catch {
      // Negative result, cached briefly so a flapping endpoint is not hammered
      // once per request.
      entries.set(url, { blocks: [], expiresAt: now() + retryAfterMs });
      return [];
    }
  }

  return {
    async get(url) {
      const cached = entries.get(url);
      if (cached !== undefined && cached.expiresAt > now()) return cached.blocks;

      const pending = inFlight.get(url);
      if (pending !== undefined) return pending;

      const request = load(url).finally(() => inFlight.delete(url));
      inFlight.set(url, request);
      return request;
    },
  };
}

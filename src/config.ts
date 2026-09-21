/**
 * Config parsing, validation and normalization. Pure: no I/O.
 */

import {
  isConfidence,
  money,
  MICROS_PER_UNIT,
  type Confidence,
  type Money,
} from "./types.js";
import {
  compilePatterns,
  compileRoutes,
  type CompiledRoute,
} from "./pricing.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/* -------------------------------------------------------------------------- */
/* Public config                                                               */
/* -------------------------------------------------------------------------- */

export type Mode = "observe" | "enforce";

/** A price written by a human: `"$0.01"`, `"USD 0.01"`, `"0.01"` or `0.01`. */
export type PriceInput = string | number;

export interface SessionConfig {
  /** How long a paid session stays valid, so a crawler is not billed per asset. */
  readonly ttlSeconds?: number;
  /** HMAC secret for session tokens. Required in enforce mode. */
  readonly secret?: string;
}

export interface CrawlmeterConfig {
  /**
   * `"observe"` (default) records what would have been charged and never blocks.
   * `"enforce"` returns 402 and verifies payment.
   */
  readonly mode?: Mode;
  /** Fallback price for any path no route matches. */
  readonly price?: PriceInput;
  /** Glob to price. The most specific match wins. */
  readonly routes?: Readonly<Record<string, PriceInput>>;
  /**
   * More paths that are never charged, whoever asks. Added to the defaults
   * (`/robots.txt`, `/sitemap.xml`, `/.well-known/*`), never instead of them.
   */
  readonly free?: readonly string[];
  /** Agent ids that pass for free but are still recorded. */
  readonly allow?: readonly string[];
  /** Agent ids to charge. Empty means "every known AI crawler". */
  readonly charge?: readonly string[];
  /**
   * Weakest identification that may be billed. Default `"ip-range"`.
   *
   * The default deliberately excludes `ua-only`, because CCBot,
   * meta-externalagent and meta-externalfetcher publish no IP ranges and can
   * never rise above it. Billing on a forgeable User-Agent would let any script with a
   * fake UA collect 402s and pollute the operator's own numbers.
   */
  readonly minConfidenceToCharge?: Confidence;
  readonly session?: SessionConfig;

  /* Enforce-mode only. */
  readonly payTo?: string;
  readonly network?: string;
  readonly facilitator?: string;
}

/* -------------------------------------------------------------------------- */
/* Normalized config                                                           */
/* -------------------------------------------------------------------------- */

export interface NormalizedConfig {
  readonly mode: Mode;
  readonly defaultPrice: Money | null;
  readonly routes: readonly CompiledRoute[];
  readonly freeMatchers: ReadonlyArray<(path: string) => boolean>;
  readonly allow: ReadonlySet<string>;
  readonly charge: ReadonlySet<string>;
  readonly minConfidenceToCharge: Confidence;
  readonly session: { readonly ttlSeconds: number; readonly secret: string | null };
  readonly payTo: string | null;
  readonly network: string | null;
  readonly facilitator: string | null;
}

export const DEFAULT_FREE_PATHS = [
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known/*",
] as const;

export const DEFAULT_SESSION_TTL_SECONDS = 600;
export const DEFAULT_MIN_CONFIDENCE: Confidence = "ip-range";

/* -------------------------------------------------------------------------- */
/* Money parsing                                                               */
/* -------------------------------------------------------------------------- */

const PRICE_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a human-written price into integer micro-units.
 *
 * Parsing is done on the decimal string rather than via `Number`, so
 * `"0.07"` cannot arrive as `0.06999999999999999`. More than six decimal places
 * is rejected instead of silently rounded: USDC has six, and quietly dropping a
 * digit from a price is the kind of bug nobody finds until a settlement is off.
 */
export function parseMoney(input: PriceInput): Money {
  const raw = typeof input === "number" ? formatNumber(input) : input;

  const cleaned = raw
    .trim()
    .replace(/^USD\s*/i, "")
    .replace(/^\$/, "")
    .replace(/,/g, "")
    .trim();

  if (cleaned === "") {
    throw new ConfigError(`Invalid price: ${JSON.stringify(input)} is empty`);
  }

  const match = PRICE_PATTERN.exec(cleaned);
  if (!match) {
    throw new ConfigError(
      `Invalid price: ${JSON.stringify(input)}. Expected something like "$0.01", "USD 0.01", "0.01" or 0.01.`,
    );
  }

  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";

  if (frac.length > 6) {
    throw new ConfigError(
      `Invalid price: ${JSON.stringify(input)} has ${frac.length} decimal places. ` +
        `The maximum is 6, matching USDC precision.`,
    );
  }

  const micros = Number(whole) * MICROS_PER_UNIT + Number(frac.padEnd(6, "0") || "0");

  if (!Number.isSafeInteger(micros)) {
    throw new ConfigError(`Invalid price: ${JSON.stringify(input)} is too large.`);
  }

  return money(micros);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ConfigError(`Invalid price: ${value} is not a finite number`);
  }
  if (value < 0) {
    throw new ConfigError(`Invalid price: ${value} is negative`);
  }
  // toFixed(6) keeps us inside the precision the parser accepts and avoids
  // exponential notation for small values such as 1e-7.
  return value.toFixed(6);
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

function normalizeIds(ids: readonly string[] | undefined, field: string): Set<string> {
  const out = new Set<string>();
  for (const id of ids ?? []) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new ConfigError(`${field} contains an empty or non-string entry`);
    }
    out.add(id.trim().toLowerCase());
  }
  return out;
}

/**
 * Validate a raw config and compile it into the shape `evaluate` consumes.
 *
 * Throws `ConfigError` with an actionable message rather than failing later at
 * request time — a misconfigured toll should break the boot, not the traffic.
 */
export function normalizeConfig(config: CrawlmeterConfig = {}): NormalizedConfig {
  const mode: Mode = config.mode ?? "observe";
  if (mode !== "observe" && mode !== "enforce") {
    throw new ConfigError(`mode must be "observe" or "enforce", got ${JSON.stringify(mode)}`);
  }

  const minConfidenceToCharge = config.minConfidenceToCharge ?? DEFAULT_MIN_CONFIDENCE;
  if (!isConfidence(minConfidenceToCharge)) {
    throw new ConfigError(
      `minConfidenceToCharge must be one of "ua-only", "signed-unverified", "ip-range", ` +
        `"rdns", "signed-verified"; got ${JSON.stringify(minConfidenceToCharge)}`,
    );
  }

  const defaultPrice = config.price === undefined ? null : parseMoney(config.price);

  const routeMap = new Map<string, Money>();
  for (const [pattern, price] of Object.entries(config.routes ?? {})) {
    if (pattern.trim() === "") {
      throw new ConfigError("routes contains an empty pattern");
    }
    if (!pattern.startsWith("/")) {
      throw new ConfigError(
        `Route pattern ${JSON.stringify(pattern)} must start with "/" — patterns match the request pathname.`,
      );
    }
    routeMap.set(pattern, parseMoney(price));
  }

  // Added to the defaults, not a replacement for them. Replacing would mean
  // `free: ["/about"]` silently starts charging for robots.txt — the file that
  // declares your crawling policy — which is self-defeating.
  const free = [...DEFAULT_FREE_PATHS, ...(config.free ?? [])];
  for (const pattern of free) {
    if (typeof pattern !== "string" || !pattern.startsWith("/")) {
      throw new ConfigError(
        `free contains ${JSON.stringify(pattern)}; entries must be pathname patterns starting with "/"`,
      );
    }
  }

  const allow = normalizeIds(config.allow, "allow");
  const charge = normalizeIds(config.charge, "charge");

  const both = [...allow].filter((id) => charge.has(id));
  if (both.length > 0) {
    throw new ConfigError(
      `These agents appear in both allow and charge, which is ambiguous: ${both.join(", ")}. ` +
        `allow takes precedence, so remove them from one of the two lists.`,
    );
  }

  const ttlSeconds = config.session?.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new ConfigError(`session.ttlSeconds must be a positive integer, got ${ttlSeconds}`);
  }

  const normalized: NormalizedConfig = {
    mode,
    defaultPrice,
    routes: compileRoutes(routeMap),
    freeMatchers: compilePatterns(free),
    allow,
    charge,
    minConfidenceToCharge,
    session: { ttlSeconds, secret: config.session?.secret ?? null },
    payTo: config.payTo ?? null,
    network: config.network ?? null,
    facilitator: config.facilitator ?? null,
  };

  if (mode === "enforce") {
    assertEnforceReady(normalized);
  }

  return normalized;
}

/**
 * Enforce mode needs a wallet, a network, a facilitator and a session secret.
 * All four are reported at once so the fix is a single edit, not four reboots.
 */
function assertEnforceReady(config: NormalizedConfig): void {
  const missing: string[] = [];
  if (!config.payTo) missing.push("payTo");
  if (!config.network) missing.push("network");
  if (!config.facilitator) missing.push("facilitator");
  if (!config.session.secret) missing.push("session.secret");
  if (!config.defaultPrice && config.routes.length === 0) missing.push("price or routes");

  if (missing.length > 0) {
    throw new ConfigError(
      `mode "enforce" requires: ${missing.join(", ")}. ` +
        `Set them, or use mode "observe" to measure crawler traffic without charging.`,
    );
  }
}

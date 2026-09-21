/**
 * The only file in crawlmeter that touches `@x402/*`.
 *
 * Everything here is loaded through a dynamic import whose specifier is held in
 * a variable, for two reasons:
 *
 * 1. **Observe mode must never load a payment library.** That is the product's
 *    central promise — measurement with no wallet, no crypto, no account — and
 *    `@x402/evm` alone pulls in `viem`. A dynamic import that is only reached
 *    in enforce mode keeps it out of the process entirely.
 *    `test/observe-no-crypto.test.ts` proves this against the built package.
 * 2. **Bundlers must not follow it.** A literal `import("@x402/evm/...")` is an
 *    invitation for a bundler to pull the whole payment stack into an edge
 *    bundle that will never use it. A variable specifier is not.
 *
 * The x402 types are NOT imported, not even as types. The interfaces below
 * describe only the methods crawlmeter calls — the same approach as the Express
 * and SQLite adapters — so that crawlmeter's published `.d.ts` never names a
 * package the user may not have installed. `test/payment/conformance.test.ts`
 * assigns the real x402 classes to these interfaces, so if x402 changes a
 * signature, the typecheck fails instead of production.
 *
 * What this file deliberately does NOT do is describe the protocol. The shape of
 * a PaymentRequired object, the encoding of the `payment-required` header, the
 * EIP-712 domain for USDC — all of that stays inside x402 and is reached only
 * through its own functions. Copying the schema by hand would rot within weeks;
 * x402 ships a release every few days.
 */

/** What the user needs to run to get enforce mode working. */
export const INSTALL_HINT = "npm i @x402/core @x402/evm";

/* -------------------------------------------------------------------------- */
/* The slice of x402 crawlmeter uses                                           */
/* -------------------------------------------------------------------------- */

/** A payment option priced by crawlmeter, in the shape x402 builds from. */
export interface X402ResourceConfig {
  readonly scheme: string;
  readonly payTo: string;
  /** Exact decimal string, e.g. `"0.010000"`. See `toDecimalAmount`. */
  readonly price: string;
  readonly network: `${string}:${string}`;
}

/** What a 402 says it is charging for. */
export interface X402ResourceInfo {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** Outcome of asking the facilitator whether a payment is good. */
export interface X402VerifyResult {
  readonly isValid: boolean;
  readonly invalidReason?: string;
}

/** Outcome of asking the facilitator to execute a payment. */
export interface X402SettleResult {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly transaction: string;
  readonly network: string;
}

/**
 * The resource server, as crawlmeter drives it.
 *
 * Opaque x402 objects — requirements, payloads, the PaymentRequired body — are
 * typed `never` going in and `unknown` coming out. crawlmeter never looks inside
 * them; it only passes what x402 produced back into x402.
 */
export interface X402ResourceServer {
  initialize(): Promise<void>;
  buildPaymentRequirements(config: X402ResourceConfig): Promise<unknown[]>;
  createPaymentRequiredResponse(
    requirements: never[],
    resource: X402ResourceInfo,
  ): Promise<unknown>;
  findMatchingRequirements(available: never[], payload: never): unknown;
  verifyPayment(payload: never, requirements: never): Promise<X402VerifyResult>;
  settlePayment(payload: never, requirements: never): Promise<X402SettleResult>;
}

/** Everything the payment gateway needs from x402. */
export interface X402 {
  /** A resource server wired to one facilitator, with the EVM exact scheme registered. */
  createResourceServer(options: { facilitator: string; timeoutMs: number }): X402ResourceServer;
  /**
   * A health check that carries no payment: resolves if the facilitator answers
   * `GET /supported`, rejects if it does not.
   *
   * It exists to tell "the facilitator is down" apart from "this payment made
   * the facilitator fail". Only the first may fail open, and a request cannot
   * influence a call that does not include anything from the request.
   */
  createProbe(options: { facilitator: string; timeoutMs: number }): () => Promise<void>;
  encodePaymentRequiredHeader(paymentRequired: never): string;
  decodePaymentSignatureHeader(header: string): unknown;
  encodePaymentResponseHeader(settle: never): string;
  /**
   * True when an error carries the facilitator's verdict on a payment, as
   * opposed to a failure to reach the facilitator at all. The difference decides
   * between answering 402 again and failing open — see `gateway.ts`.
   */
  isVerdict(error: unknown): boolean;
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The four x402 modules crawlmeter reads from, as their namespace objects.
 *
 * Normally `loadX402` imports them lazily. When the app is bundled for
 * deployment — Vercel, Next.js `output: "standalone"`, serverless bundlers —
 * that lazy import is invisible to the bundler's file tracing and the packages
 * are left out of the bundle. `crawlmeter/x402` imports them statically instead
 * and exports this object; passing it as the `x402` option is what gets them
 * shipped.
 */
export interface X402Modules {
  /** `@x402/core/server` */
  readonly server: object;
  /** `@x402/core/http` */
  readonly http: object;
  /** `@x402/core/types` */
  readonly types: object;
  /** `@x402/evm/exact/server` */
  readonly scheme: object;
}

/** Raised when enforce mode is on but x402 cannot be loaded. */
export class PaymentLibraryMissingError extends Error {
  override readonly name = "PaymentLibraryMissingError";
}

/**
 * Why x402 could not be loaded, and both ways to fix it.
 *
 * "Not installed" is only one of the two causes. The other is a deployment
 * bundle that left the packages out, where the install command changes
 * nothing — verified against a Next.js standalone build run outside the
 * repository. A message that named only the first would send people in circles.
 */
export const LOAD_FAILURE_MESSAGE =
  `crawlmeter: enforce mode could not load the x402 packages. If they are not installed, run ` +
  `\`${INSTALL_HINT}\`. If they are installed but your deployment bundles the app ` +
  `(Vercel, Next.js output: "standalone", serverless bundlers), the bundle left them out: pass ` +
  `\`x402\` from "crawlmeter/x402" so the bundler includes them. Or switch back to mode: "observe".`;

/**
 * Import a module by a specifier the compiler and bundlers cannot see.
 *
 * Kept in one function so the rule is visible: nothing else in `src/` may
 * import `@x402/*`, and nothing here may do it with a literal.
 */
function load(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

type Constructor = new (...args: never[]) => unknown;

function member<T>(module: object, name: string, from: string): T {
  const value = (module as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new PaymentLibraryMissingError(
      `crawlmeter: ${from} loaded but does not export ${name}. crawlmeter was built against @x402 2.26; ` +
        `check the installed version, or reinstall with \`${INSTALL_HINT}\`.`,
    );
  }
  return value as T;
}

/**
 * Load x402, or explain exactly how to get it.
 *
 * Note the scheme import: `@x402/evm/exact/server`, not the package root. The
 * root also exports a class named `ExactEvmScheme`, but that one is the CLIENT
 * scheme — it signs payments and needs a wallet. Registering it on a resource
 * server compiles and then fails. The server scheme lives only at this subpath.
 */
export async function loadX402(): Promise<X402> {
  let modules: X402Modules;
  try {
    const [server, http, types, scheme] = await Promise.all([
      load(SERVER_PATH),
      load(HTTP_PATH),
      load(TYPES_PATH),
      load(SCHEME_PATH),
    ]);
    modules = { server, http, types, scheme };
  } catch (cause) {
    throw new PaymentLibraryMissingError(LOAD_FAILURE_MESSAGE, { cause });
  }
  return fromModules(modules);
}

// Each symbol is read from the subpath that actually exports it in 2.26 —
// checked against the installed package, not assumed. The error classes live in
// `/types`, not `/server`.
const SERVER_PATH = "@x402/core/server";
const HTTP_PATH = "@x402/core/http";
const TYPES_PATH = "@x402/core/types";
const SCHEME_PATH = "@x402/evm/exact/server";

/**
 * Build crawlmeter's view of x402 from the four module namespaces, however they
 * were obtained. Throws `PaymentLibraryMissingError` if a symbol crawlmeter
 * depends on is missing — an x402 version too far from the one it was built
 * against.
 */
export function fromModules(modules: X402Modules): X402 {
  const { server, http, types, scheme } = modules;
  const serverPath = SERVER_PATH;
  const httpPath = HTTP_PATH;
  const typesPath = TYPES_PATH;
  const schemePath = SCHEME_PATH;

  const ResourceServer = member<Constructor>(server, "x402ResourceServer", serverPath);
  const FacilitatorClient = member<Constructor>(server, "HTTPFacilitatorClient", serverPath);
  const ExactEvmScheme = member<Constructor>(scheme, "ExactEvmScheme", schemePath);
  const VerifyError = member<Constructor>(types, "VerifyError", typesPath);
  const SettleError = member<Constructor>(types, "SettleError", typesPath);

  return {
    createResourceServer({ facilitator, timeoutMs }) {
      const client = new (FacilitatorClient as new (config: {
        url: string;
        timeoutMs: number;
      }) => unknown)({ url: facilitator, timeoutMs });
      const resourceServer = new (ResourceServer as new (client: unknown) => X402ResourceServer & {
        register(network: string, scheme: unknown): unknown;
      })(client);
      // Wildcard: the network actually charged on is chosen per payment option,
      // from crawlmeter's config.
      resourceServer.register("eip155:*", new (ExactEvmScheme as new () => unknown)());
      return resourceServer;
    },
    createProbe({ facilitator, timeoutMs }) {
      // Its own client, so the probe's short timeout does not shorten the
      // timeout of real verify and settle calls.
      const client = new (FacilitatorClient as new (config: {
        url: string;
        timeoutMs: number;
      }) => { getSupported(): Promise<unknown> })({ url: facilitator, timeoutMs });
      return async () => {
        await client.getSupported();
      };
    },
    encodePaymentRequiredHeader: member(http, "encodePaymentRequiredHeader", httpPath),
    decodePaymentSignatureHeader: member(http, "decodePaymentSignatureHeader", httpPath),
    encodePaymentResponseHeader: member(http, "encodePaymentResponseHeader", httpPath),
    isVerdict: (error) => error instanceof VerifyError || error instanceof SettleError,
  };
}

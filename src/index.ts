/**
 * crawlmeter — see how much AI crawler traffic your site serves for free.
 *
 * This entry point is framework-agnostic and, by design, loads no payment
 * library. Nothing reachable from here imports `@x402/*`; that lives behind a
 * dynamic import in `src/payment/`, so `mode: "observe"` costs no crypto
 * dependency at install time or at runtime. `test/observe-no-crypto.test.ts`
 * enforces this.
 */

export {
  CONFIDENCE_ORDER,
  MICROS_PER_UNIT,
  NOT_A_CRAWLER,
  confidenceRank,
  isConfidence,
  meetsConfidence,
  money,
  toAssetAmount,
  toCrawlerPrice,
  toDecimalAmount,
  type Confidence,
  type Decision,
  type DecisionAction,
  type EvaluatedRequest,
  type Identification,
  type Money,
  type PassReason,
} from "./types.js";

export {
  ConfigError,
  DEFAULT_FREE_PATHS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_SESSION_TTL_SECONDS,
  normalizeConfig,
  parseMoney,
  type CrawlmeterConfig,
  type Mode,
  type NormalizedConfig,
  type PriceInput,
  type SessionConfig,
} from "./config.js";

export {
  compilePatterns,
  compileRoutes,
  createMatcher,
  isFree,
  resolvePrice,
  sortBySpecificity,
  type CompiledRoute,
  type ResolvedPrice,
} from "./pricing.js";

export { evaluate, failOpen } from "./evaluate.js";

export {
  AGENTS,
  CATALOG_VERSION,
  COMPILED_AGENTS,
  agentById,
  type AgentEntry,
  type CompiledAgent,
} from "./detect/agents.js";

export { matchUserAgent } from "./detect/ua.js";

export {
  createIpRangeCache,
  findCidr,
  inAnyCidr,
  inCidr,
  parseCidr,
  parseIp,
  parsePrefixDocument,
  type Cidr,
  type FetchLike,
  type IpBytes,
  type IpRangeCache,
  type IpRangeCacheOptions,
} from "./detect/ipRanges.js";

export {
  DEFAULT_RDNS_TIMEOUT_MS,
  createNodeResolver,
  endsWithSuffix,
  verifyRdns,
  type DnsResolver,
  type RdnsResult,
} from "./detect/rdns.js";

export {
  detectSignature,
  parseSignatureAgent,
  type SignatureDetection,
  type SignatureHeaders,
} from "./detect/signature.js";

export {
  createDetector,
  detect,
  type DetectInput,
  type Detector,
  type DetectorOptions,
} from "./detect/index.js";

export {
  EMPTY_SUMMARY,
  EMPTY_TOTALS,
  NOT_A_CRAWLER_KEY,
  aggregate,
  compareBuckets,
  eventFromDecision,
  inRange,
  type Bucket,
  type CrawlEvent,
  type Store,
  type Summary,
  type TimeRange,
  type Totals,
} from "./store/types.js";

export {
  createMemoryStore,
  type MemoryStore,
  type MemoryStoreOptions,
} from "./store/memory.js";

export { deferStore } from "./store/deferred.js";

export {
  createWriteQueue,
  type WriteQueue,
  type WriteQueueOptions,
} from "./store/writeQueue.js";

export { createSqliteStore, type SqliteStoreOptions } from "./store/sqlite.js";

export { createPostgresStore, type PostgresStoreOptions } from "./store/postgres.js";

export {
  issueSessionToken,
  verifySessionToken,
  type IssueOptions,
  type Session,
  type VerifyOptions,
} from "./session.js";

export {
  CRAWLER_CHARGED,
  CRAWLER_EXACT_PRICE,
  CRAWLER_MAX_PRICE,
  CRAWLER_PRICE,
  LEGACY_HEADERS,
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  SESSION,
  SIGNATURE,
  SIGNATURE_AGENT,
  SIGNATURE_INPUT,
  header,
  parsePriceHeader,
  readCrawlerHeaders,
  setCrawlerCharged,
  setCrawlerPrice,
  setSessionToken,
  type CrawlerHeaders,
  type HeaderBag,
  type HeaderSink,
} from "./headers.js";

export {
  clientAddress,
  createEngine,
  normalizeTrustProxy,
  resourceUrl,
  type Answer,
  type Engine,
  type EngineOptions,
  type EngineRequest,
  type Handled,
} from "./adapters/core.js";

export {
  PROXY_WARNING,
  addressOf,
  crawlmeter,
  onFinish,
  pathOf,
  urlOf,
  type AdapterRequest,
  type AdapterResponse,
  type CrawlmeterMiddleware,
  type CrawlmeterOptions,
  type NextFunction,
} from "./adapters/express.js";

export {
  PaymentUnavailableError,
  createPaymentGateway,
  type PaymentGateway,
  type PaymentGatewayOptions,
  type SettleOutcome,
} from "./payment/gateway.js";

export {
  INSTALL_HINT,
  LOAD_FAILURE_MESSAGE,
  PaymentLibraryMissingError,
  fromModules,
  loadX402,
  type X402Modules,
  type X402,
  type X402ResourceConfig,
  type X402ResourceInfo,
  type X402ResourceServer,
  type X402SettleResult,
  type X402VerifyResult,
} from "./payment/x402.js";

export {
  REASON_LABELS,
  buildReport,
  type Report,
  type ReportRow,
  type UnbilledRow,
} from "./report/index.js";

export { dataOf, formatBytes, formatReport } from "./report/format.js";

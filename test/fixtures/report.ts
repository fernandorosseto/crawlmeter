import type { Summary } from "../../src/store/types.js";

/**
 * A realistic week of crawler traffic, shared by the formatter's tests and the
 * README's.
 *
 * The README shows the report this summary produces, and `test/readme.test.ts`
 * requires that block to be exactly `formatReport` of it. The example on the
 * front page can therefore never drift from what the command really prints.
 *
 * The numbers add up by hand: GPTBot is 812 pages at $0.01 plus 120 API calls
 * at $0.05 = $14.12; ClaudeBot is 402 pages at $0.01 = $4.02; $18.14 in all.
 */
export const WEEK_OF_TRAFFIC: Summary = {
  totals: { hits: 1_429, bytes: 60_643_500, bytesMeasured: 1_429, potentialMicros: 18_140_000 },
  byAgent: [
    { key: "gptbot", hits: 932, bytes: 38_416_000, bytesMeasured: 932, potentialMicros: 14_120_000 },
    { key: "claudebot", hits: 402, bytes: 18_894_000, bytesMeasured: 402, potentialMicros: 4_020_000 },
    { key: "ccbot", hits: 70, bytes: 3_290_000, bytesMeasured: 70, potentialMicros: 0 },
    { key: "perplexitybot", hits: 25, bytes: 4_500, bytesMeasured: 25, potentialMicros: 0 },
  ],
  byOperator: [],
  byRoute: [
    { key: "*", hits: 1_214, bytes: 57_058_000, bytesMeasured: 1_214, potentialMicros: 12_140_000 },
    { key: "/api/*", hits: 120, bytes: 252_000, bytesMeasured: 120, potentialMicros: 6_000_000 },
  ],
  byReason: [
    { key: "observe-mode", hits: 1_334, bytes: 57_310_000, bytesMeasured: 1_334, potentialMicros: 18_140_000 },
    { key: "below-min-confidence", hits: 70, bytes: 3_290_000, bytesMeasured: 70, potentialMicros: 0 },
    { key: "free-path", hits: 25, bytes: 4_500, bytesMeasured: 25, potentialMicros: 0 },
  ],
};

import { describe, expect, it } from "vitest";

import { dataOf, formatBytes, formatReport } from "../../src/report/format.js";
import { buildReport } from "../../src/report/index.js";
import { EMPTY_SUMMARY } from "../../src/store/types.js";
import { WEEK_OF_TRAFFIC } from "../fixtures/report.js";

/**
 * The report is a deterministic function of its input, so its output is tested
 * exactly. If a change alters what an operator sees, the diff shows it here.
 */

const SUMMARY = WEEK_OF_TRAFFIC;

describe("formatReport", () => {
  it("prints the report exactly", () => {
    expect(formatReport(buildReport(SUMMARY), { source: "crawlmeter.db" })).toBe(
      [
        "crawlmeter report - crawlmeter.db - everything recorded",
        "",
        "  AI crawlers made 1,429 requests, 60.6 MB of data.",
        "  Had you been charging, they would have paid USD 18.14.",
        "",
        "  Crawler         Operator      Requests      Data   Potential",
        "  gptbot          openai             932   38.4 MB   USD 14.12",
        "  claudebot       anthropic          402   18.9 MB    USD 4.02",
        "  ccbot           commoncrawl         70    3.3 MB    USD 0.00",
        "  perplexitybot   perplexity          25    4.5 KB    USD 0.00",
        "",
        "  Route               Requests   Potential",
        "  /api/*                   120    USD 6.00",
        "  * (default price)      1,214   USD 12.14",
        "",
        "  Not billed, and why                                    Requests",
        "  identity not proven strongly enough to bill                  70",
        "  always-free paths (robots.txt, sitemap, .well-known)         25",
        "",
        "  Notes",
        "  - 70 crawler requests could not be proven to come from the crawler named",
        "    in the User-Agent, and are not counted toward potential revenue. That is",
        "    deliberate: a User-Agent can be forged by anyone.",
        "",
      ].join("\n"),
    );
  });

  it("is plain ASCII, so it survives any terminal or log", () => {
    const text = formatReport(buildReport(SUMMARY), { source: "crawlmeter.db" });
    expect([...text].every((char) => char.charCodeAt(0) < 128)).toBe(true);
  });

  it("prints the same text every time", () => {
    const report = buildReport(SUMMARY);
    expect(formatReport(report)).toBe(formatReport(report));
  });

  it("reads sensibly when nothing has been recorded", () => {
    const text = formatReport(buildReport(EMPTY_SUMMARY));
    expect(text).toContain("AI crawlers made 0 requests.");
    expect(text).toContain("they would have paid USD 0.00.");
    expect(text).toContain("No crawler traffic has been recorded yet");
    expect(text).not.toContain("NaN");
  });

  it("names the time window when there is one", () => {
    const report = buildReport(EMPTY_SUMMARY, { since: Date.parse("2026-09-01T00:00:00Z") });
    expect(formatReport(report).split("\n")[0]).toBe("crawlmeter report - since 2026-09-01");
  });

  it("keeps every line within a readable width", () => {
    const text = formatReport(buildReport(SUMMARY));
    for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });
});

describe("sizes", () => {
  it("uses SI units, as bandwidth is billed", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_000)).toBe("1.0 KB");
    expect(formatBytes(38_416_000)).toBe("38.4 MB");
    expect(formatBytes(2_500_000_000)).toBe("2.5 GB");
    expect(formatBytes(3_000_000_000_000)).toBe("3.0 TB");
  });

  it("says unknown rather than zero, and marks a partial figure as a floor", () => {
    expect(dataOf(null, 0, 10)).toBe("n/a");
    expect(dataOf(5_000, 10, 10)).toBe("5.0 KB");
    expect(dataOf(5_000, 4, 10)).toBe(">= 5.0 KB");
  });
});

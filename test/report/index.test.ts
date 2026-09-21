import { describe, expect, it } from "vitest";

import { buildReport } from "../../src/report/index.js";
import { createMemoryStore } from "../../src/store/memory.js";
import { eventFromDecision, type CrawlEvent } from "../../src/store/types.js";
import { money, type Decision, type PassReason } from "../../src/types.js";

/**
 * The report's numbers. The headline is potential revenue, and potential
 * revenue has exactly one definition: `Decision.potential`, summed. Every test
 * here is a way that number could quietly grow beyond that, or a slice of the
 * traffic could quietly disappear from view.
 */

const AT = Date.parse("2026-09-15T12:00:00Z");

function billable(route: string, micros: number): Decision {
  return { action: "pass", reason: "observe-mode", route, price: money(micros), potential: money(micros) };
}

function unbillable(reason: PassReason): Decision {
  return { action: "pass", reason, route: null, price: null, potential: null };
}

function event(
  decision: Decision,
  agent: string | null,
  bytes: number | null = 1_000,
  operator: string | null = agent === null ? null : "op",
): CrawlEvent {
  return eventFromDecision(decision, {
    method: "GET",
    path: "/p",
    agent,
    operator,
    confidence: agent === null ? null : "ip-range",
    bytes,
    at: AT,
  });
}

async function reportOf(events: CrawlEvent[]) {
  const store = createMemoryStore();
  for (const each of events) store.record(each);
  return buildReport(await store.summary());
}

describe("the headline", () => {
  it("is the sum of potential revenue, and nothing else", async () => {
    const report = await reportOf([
      event(billable("*", 10_000), "gptbot"),
      event(billable("/api/*", 50_000), "gptbot"),
      event(unbillable("below-min-confidence"), "ccbot"),
      event(unbillable("free-path"), "gptbot"),
      event(unbillable("allowlisted"), "googleother"),
    ]);
    expect(report.totals.potentialMicros).toBe(60_000);
  });

  it("stays an integer, however many small prices are added", async () => {
    // 0.07 is where floating point starts to lie.
    const events = Array.from({ length: 100 }, () => event(billable("*", 70_000), "gptbot"));
    const report = await reportOf(events);
    expect(report.totals.potentialMicros).toBe(7_000_000);
    expect(Number.isInteger(report.totals.potentialMicros)).toBe(true);
  });

  it("counts crawler requests only", async () => {
    // Adapters never record humans, but a store might hold such events. They
    // are not crawler traffic and must not inflate a report about crawlers.
    const report = await reportOf([
      event(billable("*", 10_000), "gptbot"),
      event(unbillable("not-a-crawler"), null, 5_000),
    ]);
    expect(report.totals.hits).toBe(1);
    expect(report.totals.bytes).toBe(1_000);
    expect(report.crawlers.map((row) => row.key)).toEqual(["gptbot"]);
    expect(report.unbilled.map((row) => row.reason)).not.toContain("not-a-crawler");
  });
});

describe("rows", () => {
  it("groups by crawler, with the operator from the catalog", async () => {
    const report = await reportOf([
      event(billable("*", 10_000), "gptbot"),
      event(billable("*", 10_000), "gptbot"),
      event(billable("*", 10_000), "claudebot"),
    ]);
    expect(report.crawlers.map((row) => [row.key, row.operator, row.hits])).toEqual([
      ["gptbot", "openai", 2],
      ["claudebot", "anthropic", 1],
    ]);
  });

  it("keeps the default price apart from route rules", async () => {
    const report = await reportOf([
      event(billable("*", 10_000), "gptbot"),
      event(billable("/api/*", 50_000), "gptbot"),
    ]);
    expect(report.routes.map((row) => row.key)).toEqual(["/api/*"]);
    expect(report.fallbackRoute?.key).toBe("*");
    expect(report.fallbackRoute?.potentialMicros).toBe(10_000);
  });

  it("shows what was not billed, and why, in plain language", async () => {
    const report = await reportOf([
      event(unbillable("below-min-confidence"), "ccbot"),
      event(unbillable("below-min-confidence"), "ccbot"),
      event(unbillable("free-path"), "gptbot"),
    ]);
    expect(report.unbilled.map((row) => [row.reason, row.hits, row.label])).toEqual([
      ["below-min-confidence", 2, "identity not proven strongly enough to bill"],
      ["free-path", 1, "always-free paths (robots.txt, sitemap, .well-known)"],
    ]);
  });

  it("marks sizes as unknown rather than zero when nothing was measured", async () => {
    const report = await reportOf([event(billable("*", 10_000), "gptbot", null)]);
    expect(report.totals.bytes).toBeNull();
    expect(report.crawlers[0]?.bytes).toBeNull();
  });
});

describe("notes", () => {
  it("says so when nothing has been recorded, without dividing by zero", async () => {
    const report = await reportOf([]);
    expect(report.totals).toEqual({ hits: 0, bytes: null, bytesMeasured: 0, potentialMicros: 0 });
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toContain("No crawler traffic has been recorded yet");
  });

  it("names the proxy as the likely cause when everything is weakly identified", async () => {
    // The silent zero: behind a proxy nobody told crawlmeter to trust, every
    // crawler is seen at the proxy's address and nothing is ever billable.
    const events = Array.from({ length: 50 }, () => event(unbillable("below-min-confidence"), "gptbot"));
    const report = await reportOf(events);

    expect(report.totals.potentialMicros).toBe(0);
    expect(report.notes[0]).toContain("trustProxy");
  });

  it("does not blame the proxy when real revenue is being recorded", async () => {
    const report = await reportOf([
      event(billable("*", 10_000), "gptbot"),
      event(unbillable("below-min-confidence"), "ccbot"),
    ]);
    expect(report.notes.join(" ")).not.toContain("trustProxy");
    expect(report.notes[0]).toContain("could not be proven");
  });

  it("explains partially measured bandwidth", async () => {
    const report = await reportOf([
      event(billable("*", 10_000), "gptbot", 1_000),
      event(billable("*", 10_000), "gptbot", null),
    ]);
    expect(report.notes.join(" ")).toContain("measured for 1 of 2 requests");
  });

  it("points at fail-open requests", async () => {
    const report = await reportOf([
      event(billable("*", 10_000), "gptbot"),
      event(unbillable("fail-open"), "gptbot"),
    ]);
    expect(report.notes.join(" ")).toContain("fail-open");
  });
});

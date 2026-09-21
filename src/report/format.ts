/**
 * The report as a person reads it in a terminal.
 *
 * Plain ASCII, so it reads the same in a Windows console, a CI log and an
 * email. Deterministic: the same report always prints the same text, which is
 * what lets it be tested exactly and diffed between runs.
 *
 * Money goes through `toCrawlerPrice`, the same rendering as the `crawler-price`
 * header, so the report and the wire never disagree about a price.
 */

import { money, toCrawlerPrice } from "../types.js";
import type { Report, ReportRow } from "./index.js";

export function formatReport(report: Report, options: { readonly source?: string } = {}): string {
  const lines: string[] = [];
  const { totals } = report;

  const title = ["crawlmeter report", options.source, sinceLabel(report.since)].filter(Boolean);
  lines.push(title.join(" - "));
  lines.push("");
  lines.push(
    `  AI crawlers made ${count(totals.hits)} ${totals.hits === 1 ? "request" : "requests"}` +
      (totals.bytes === null ? "." : `, ${dataOf(totals.bytes, totals.bytesMeasured, totals.hits)} of data.`),
  );
  lines.push(`  Had you been charging, they would have paid ${usd(totals.potentialMicros)}.`);

  if (report.crawlers.length > 0) {
    lines.push("");
    lines.push(
      ...table(
        ["Crawler", "Operator", "Requests", "Data", "Potential"],
        ["left", "left", "right", "right", "right"],
        report.crawlers.map((each) => [
          each.key,
          each.operator ?? "",
          count(each.hits),
          dataOf(each.bytes, each.bytesMeasured, each.hits),
          usd(each.potentialMicros),
        ]),
      ),
    );
  }

  const priced: ReportRow[] = [...report.routes];
  if (report.fallbackRoute !== null) priced.push(report.fallbackRoute);
  if (priced.length > 0) {
    lines.push("");
    lines.push(
      ...table(
        ["Route", "Requests", "Potential"],
        ["left", "right", "right"],
        priced.map((each) => [
          each.key === "*" ? "* (default price)" : each.key,
          count(each.hits),
          usd(each.potentialMicros),
        ]),
      ),
    );
  }

  if (report.unbilled.length > 0) {
    lines.push("");
    lines.push(
      ...table(
        ["Not billed, and why", "Requests"],
        ["left", "right"],
        report.unbilled.map((each) => [each.label, count(each.hits)]),
      ),
    );
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("  Notes");
    for (const note of report.notes) lines.push(...wrap(note, 76, "  - ", "    "));
  }

  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function sinceLabel(since: number | null): string {
  return since === null ? "everything recorded" : `since ${new Date(since).toISOString().slice(0, 10)}`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function usd(micros: number): string {
  return toCrawlerPrice(money(micros));
}

/**
 * Sizes in SI units, as bandwidth is billed. Unknown is "n/a", never "0 B".
 * When only some hits were measured the figure is a floor, and says so.
 */
export function dataOf(bytes: number | null, measured: number, hits: number): string {
  if (bytes === null || measured === 0) return "n/a";
  const size = formatBytes(bytes);
  return measured < hits ? `>= ${size}` : size;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

type Align = "left" | "right";

function table(header: readonly string[], align: readonly Align[], rows: readonly string[][]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((each) => (each[column] ?? "").length)),
  );
  const render = (cells: readonly string[]) =>
    `  ${cells
      .map((cell, column) => {
        const width = widths[column] ?? 0;
        return align[column] === "right" ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("   ")
      .trimEnd()}`;
  return [render(header), ...rows.map(render)];
}

/** Word-wrap a paragraph with a first-line and a continuation prefix. */
function wrap(text: string, width: number, first: string, rest: string): string[] {
  const lines: string[] = [];
  let current = first;
  for (const word of text.split(/\s+/)) {
    const prefix = lines.length === 0 ? first : rest;
    if (current.length > prefix.length && current.length + 1 + word.length > width) {
      lines.push(current);
      current = rest + word;
    } else {
      current = current.length > prefix.length ? `${current} ${word}` : current + word;
    }
  }
  lines.push(current);
  return lines;
}

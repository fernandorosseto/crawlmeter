#!/usr/bin/env node
/**
 * The `crawlmeter` binary. Everything it does lives in `./report/cli.ts`; this
 * file only connects it to the real process.
 */

import { readFileSync } from "node:fs";

import { main } from "./report/cli.js";

// Node prints an ExperimentalWarning the first time node:sqlite loads. That is
// fair warning for a library user wiring up a server, and noise in a report a
// person asked for. Silenced here, in this process only — never in a server
// that embeds crawlmeter.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(text)) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

/**
 * The version, for `--version`. Read defensively: a report must not fail to
 * print because the binary was bundled or copied somewhere its package.json
 * did not follow.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const version = readVersion();

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  now: Date.now,
  version,
});

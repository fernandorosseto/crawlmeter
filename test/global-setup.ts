/**
 * Build `dist/` once, before any test file runs.
 *
 * Several suites need the package as it ships — the real Next.js server, the
 * standalone deploy, the README's quickstart — and resolve `crawlmeter` through
 * the package's own `exports` into `dist/`. When each of them rebuilt `dist/`
 * in its own `beforeAll`, the builds ran in parallel over the same files, and a
 * `next build` could read a module halfway through being rewritten. One build,
 * up front, removes the race.
 *
 * Suites that need an isolated copy (observe-no-crypto, the CLI binary) still
 * build into directories of their own.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: root, stdio: "pipe" },
  );
}

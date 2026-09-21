import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * What gets published, checked against what was written.
 *
 * `dist/` is built once by test/global-setup.ts. These tests look at it the way
 * npm will ship it: every entry point resolves, the build exports everything
 * the source does, the binary is executable, and the tarball carries nothing
 * but the build and the documents a user needs.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  exports: Record<string, { types: string; import: string }>;
  bin: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
};

describe("the published package", () => {
  it("has a built file and type declarations for every entry point", () => {
    for (const [entry, target] of Object.entries(PACKAGE.exports)) {
      expect(existsSync(join(ROOT, target.import)), `${entry} import`).toBe(true);
      expect(existsSync(join(ROOT, target.types)), `${entry} types`).toBe(true);
    }
  });

  it("exports from the build everything the source exports", async () => {
    const source = await import("../src/index.js");
    const built = (await import(pathToFileURL(join(ROOT, "dist", "index.js")).href)) as Record<string, unknown>;
    const missing = Object.keys(source).filter((name) => !(name in built));
    expect(missing).toEqual([]);
  });

  it("ships the crawler catalog the detector reads at runtime", () => {
    expect(existsSync(join(ROOT, "dist", "data", "agents.json"))).toBe(true);
  });

  it("has an executable binary", () => {
    for (const target of Object.values(PACKAGE.bin)) {
      const file = join(ROOT, target);
      expect(existsSync(file), target).toBe(true);
      expect(readFileSync(file, "utf8").startsWith("#!/usr/bin/env node"), target).toBe(true);
    }
  });

  it("has no runtime dependencies", () => {
    // Observe mode is one package. Anything heavy is an optional peer.
    expect(PACKAGE.dependencies ?? {}).toEqual({});
  });

  // Spawning npm takes seconds on Windows while the rest of the suite runs.
  it("packs only the build and the documents a user needs", { timeout: 60_000 }, () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: true,
    });
    expect(result.status, result.stderr).toBe(0);
    const [packed] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = (packed?.files ?? []).map((each) => each.path.replace(/\\/g, "/"));

    const unexpected = paths.filter(
      (path) => !path.startsWith("dist/") && !["package.json", "README.md", "LICENSE"].includes(path),
    );
    expect(unexpected).toEqual([]);
    for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/cli.js"]) {
      expect(paths, required).toContain(required);
    }
  });
});

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository's own conventions, from .editorconfig.
 *
 * These exist because they were broken without anyone noticing: scripts run on
 * Windows wrote CRLF into 39 files, and nothing that compiles or tests code
 * cares about line endings — until a test compared the README's text and
 * found `\r\n` where it expected `\n`. A diff full of invisible changes is how
 * real changes get missed in review.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".test-build", ".git"]);
const TEXT = new Set([".ts", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const NAMED = new Set(["LICENSE", ".gitignore", ".gitattributes", ".editorconfig"]);

function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return textFiles(path);
    return TEXT.has(extname(entry.name)) || NAMED.has(entry.name) ? [path] : [];
  });
}

const FILES = textFiles(ROOT).map((path) => ({
  name: relative(ROOT, path).split("\\").join("/"),
  text: readFileSync(path, "utf8"),
}));

describe("repository conventions", () => {
  it("finds the files it is checking", () => {
    expect(FILES.map((file) => file.name)).toContain("README.md");
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("uses LF line endings everywhere", () => {
    expect(FILES.filter((file) => file.text.includes("\r")).map((file) => file.name)).toEqual([]);
  });

  it("has no raw control characters", () => {
    // A NUL byte makes git treat the file as binary: its diffs stop showing,
    // and a change nobody can read is a change nobody reviews. Use an escape.
    const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
    expect(FILES.filter((file) => control.test(file.text)).map((file) => file.name)).toEqual([]);
  });

  it("ends every file with a newline", () => {
    expect(FILES.filter((file) => file.text.length > 0 && !file.text.endsWith("\n")).map((file) => file.name)).toEqual([]);
  });
});

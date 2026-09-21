import { describe, expect, it } from "vitest";
import {
  compilePatterns,
  compileRoutes,
  createMatcher,
  isFree,
  resolvePrice,
  sortBySpecificity,
} from "../src/pricing.js";
import { parseMoney } from "../src/config.js";
import { money } from "../src/types.js";

describe("createMatcher", () => {
  it("matches exact paths", () => {
    const matches = createMatcher("/robots.txt");
    expect(matches("/robots.txt")).toBe(true);
    expect(matches("/robots.txt.bak")).toBe(false);
    expect(matches("/a/robots.txt")).toBe(false);
  });

  it("matches across path segments, so /api/* covers the subtree", () => {
    const matches = createMatcher("/api/*");
    expect(matches("/api/users")).toBe(true);
    expect(matches("/api/v1/users")).toBe(true);
    expect(matches("/api/")).toBe(true);
    expect(matches("/apix/users")).toBe(false);
  });

  it("treats ** as an alias for *", () => {
    expect(createMatcher("/api/**")("/api/v1/users")).toBe(true);
  });

  it("anchors at both ends", () => {
    const matches = createMatcher("/blog/*");
    expect(matches("/x/blog/post")).toBe(false);
  });

  it("treats regex metacharacters as literals", () => {
    expect(createMatcher("/a.b")("/a.b")).toBe(true);
    expect(createMatcher("/a.b")("/axb")).toBe(false);
    expect(createMatcher("/a+b")("/a+b")).toBe(true);
    expect(createMatcher("/q?x")("/q?x")).toBe(true);
    expect(createMatcher("/(a)")("/(a)")).toBe(true);
    expect(createMatcher("/a[b]")("/a[b]")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(createMatcher("/API/*")("/api/x")).toBe(false);
  });
});

describe("sortBySpecificity", () => {
  it("puts more literal characters first", () => {
    expect(sortBySpecificity(["/api/*", "/api/public/*", "/*"])).toEqual([
      "/api/public/*",
      "/api/*",
      "/*",
    ]);
  });

  it("is deterministic for equally specific patterns", () => {
    const input = ["/b/*", "/a/*", "/c/*"];
    const first = sortBySpecificity(input);
    for (let i = 0; i < 20; i++) {
      expect(sortBySpecificity([...input].reverse())).toEqual(first);
    }
  });

  it("does not mutate the input", () => {
    const input = ["/b/*", "/a/*"];
    sortBySpecificity(input);
    expect(input).toEqual(["/b/*", "/a/*"]);
  });
});

describe("resolvePrice", () => {
  const routes = compileRoutes(
    new Map([
      ["/api/*", parseMoney("$0.05")],
      ["/api/public/*", parseMoney("$0.001")],
      ["/blog/*", parseMoney("$0.002")],
    ]),
  );

  it("returns the most specific match", () => {
    expect(resolvePrice("/api/public/health", routes, null)).toEqual({
      route: "/api/public/*",
      price: money(1_000),
    });
  });

  it("falls back to the default price with route *", () => {
    expect(resolvePrice("/about", routes, parseMoney("$0.01"))).toEqual({
      route: "*",
      price: money(10_000),
    });
  });

  it("returns null when nothing matches and there is no default", () => {
    expect(resolvePrice("/about", routes, null)).toBeNull();
  });

  it("returns null for an empty table with no default", () => {
    expect(resolvePrice("/x", [], null)).toBeNull();
  });
});

describe("isFree", () => {
  const free = compilePatterns(["/robots.txt", "/sitemap.xml", "/.well-known/*"]);

  it("matches the default free paths", () => {
    expect(isFree("/robots.txt", free)).toBe(true);
    expect(isFree("/.well-known/ai.txt", free)).toBe(true);
  });

  it("does not match ordinary content", () => {
    expect(isFree("/blog/post", free)).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(isFree("/robots.txt", [])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { matchUserAgent } from "../../src/detect/ua.js";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("matchUserAgent", () => {
  it("matches a known crawler to its agent and operator", () => {
    const agent = matchUserAgent("Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.4; +https://openai.com/gptbot)");
    expect(agent?.id).toBe("gptbot");
    expect(agent?.operator).toBe("openai");
  });

  it("returns null for an ordinary browser", () => {
    expect(matchUserAgent(CHROME)).toBeNull();
  });

  it("matches case-insensitively but reports a lowercase id", () => {
    const agent = matchUserAgent("gptbot/1.4");
    expect(agent?.id).toBe("gptbot");
  });

  it("does not break on an empty or missing user agent", () => {
    expect(matchUserAgent("")).toBeNull();
    expect(matchUserAgent(null)).toBeNull();
    expect(matchUserAgent(undefined)).toBeNull();
  });

  it("keeps sibling tokens of one operator apart", () => {
    expect(matchUserAgent("ClaudeBot/1.0")?.id).toBe("claudebot");
    expect(matchUserAgent("Claude-User/1.0")?.id).toBe("claude-user");
    expect(matchUserAgent("Claude-SearchBot/1.0")?.id).toBe("claude-searchbot");
  });

  it("prefers the most specific token when one contains another", () => {
    // `Perplexity-User` contains no shorter catalog token, but `OAI-SearchBot`
    // and `OAI-AdsBot` share a prefix, and `ChatGPT-User` must not fall to a
    // shorter OpenAI row. Longest-pattern-first is what keeps these separate.
    expect(matchUserAgent("OAI-SearchBot/1.4")?.id).toBe("oai-searchbot");
    expect(matchUserAgent("OAI-AdsBot/1.0")?.id).toBe("oai-adsbot");
    expect(matchUserAgent("ChatGPT-User/1.0")?.id).toBe("chatgpt-user");
  });

  it("matches the meta tokens as published, in lowercase", () => {
    expect(matchUserAgent("meta-externalagent/1.1")?.id).toBe("meta-externalagent");
    expect(matchUserAgent("meta-externalfetcher/1.1")?.id).toBe("meta-externalfetcher");
  });

  it("matches applebot inside apple's full safari-shaped user agent", () => {
    const applebot =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)";
    expect(matchUserAgent(applebot)?.id).toBe("applebot");
  });
});

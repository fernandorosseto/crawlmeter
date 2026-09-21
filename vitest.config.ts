import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // The examples import "crawlmeter" and "crawlmeter/next" exactly as a user
    // would, so the code in them is copy-pasteable into the README. Tests
    // resolve those names to source. Anchored regexes, because a plain
    // "crawlmeter" key would also rewrite "crawlmeter/next" by prefix.
    alias: [
      { find: /^crawlmeter\/next$/, replacement: source("./src/adapters/next.ts") },
      { find: /^crawlmeter\/x402$/, replacement: source("./src/payment/modules.ts") },
      { find: /^crawlmeter$/, replacement: source("./src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Builds dist/ once for every suite that needs the package as it ships.
    globalSetup: ["test/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});

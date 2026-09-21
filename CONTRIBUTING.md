# Contributing to crawlmeter

Thank you for helping. crawlmeter sits in front of other people's websites, so the bar for changes is correctness first: every change keeps the test suite green, and every behaviour that matters has a test that would fail without it.

## Setup

Node.js 22.13 or later.

```bash
npm install
npm run typecheck && npm test && npm run build
```

All three must pass before a pull request is ready. The suite builds the package and runs it inside a real Express server, a real Next.js server and a standalone Next.js deployment, so it takes about half a minute.

The Postgres store has its own tests, skipped unless you point them at a database:

```bash
CRAWLMETER_TEST_POSTGRES_URL=postgres://user:password@localhost:5432/crawlmeter_test npm test
```

## Updating the crawler catalog

The most useful contribution. [`src/data/agents.json`](src/data/agents.json) lists every crawler crawlmeter recognises, and it goes stale as operators launch crawlers and change their address ranges.

Each entry needs, from the **operator's own documentation**, never a third-party list or a blog post:

- `id`: lowercase and unique, e.g. `gptbot`.
- `operator`: lowercase, e.g. `openai`.
- `uaPattern`: the token that appears in the User-Agent, e.g. `GPTBot`.
- `ipRangesUrl` and `ipRangesFormat`: where the operator publishes its addresses, or `null` if it does not.
- `rdnsSuffixes`: the operator's reverse-DNS domains, if it documents any.
- `maxConfidence`: the strongest proof the crawler allows. `ua-only` if it publishes nothing, `ip-range` with a published list, `rdns` with a documented DNS domain as well.
- `docs`: a link to the operator's page where all of the above can be checked.

Link that page in the pull request. `test/detect/agents.test.ts` checks the file's shape; a reviewer checks the facts against the link.

Two things that look like crawlers are not: `Google-Extended` and `Applebot-Extended` are robots.txt tokens, and no request ever carries them.

## Rules the code depends on

These are enforced by tests. A change that needs to break one is a design discussion, not a pull request.

- **Observe mode loads no payment code.** Nothing reachable from `crawlmeter`, `crawlmeter/next` or the `crawlmeter` binary may import `@x402/*`. Only `src/payment/x402.ts` (lazily) and `src/payment/modules.ts` (the opt-in `crawlmeter/x402` entry) may name it. `test/observe-no-crypto.test.ts` checks this both statically and by running the built package with x402 made impossible to load.
- **`evaluate()` is pure.** No clock, network, DNS or filesystem. The order of its checks decides who is billed and what the report says; each step has a test.
- **Failures open.** Any failure in identification, storage or payment serves the request. Nothing a crawler sends may be able to trigger that path: a malformed or wrong payment is refused, never waved through.
- **Money is integer micro-units.** Never a float.
- **Potential revenue is what enforce mode would have charged, and nothing else.**
- **Nothing phones home.** The only outbound traffic is the operators' published address lists, reverse-DNS lookups, and in enforce mode the facilitator the site owner chose.
- **Human visitors cost nothing.** A request that is not a known crawler leaves before any work is done, and is never recorded.

## Conventions

- Code, comments, commit messages, issues and documentation in English.
- TypeScript in strict mode, ESM, no new runtime dependencies. Anything heavy is an optional peer dependency loaded only when used.
- Comments explain why, especially where the obvious alternative would be wrong.
- Record user-visible changes with `npx changeset`.

## Reporting a security problem

Do not open a public issue. Report it privately at https://github.com/fernandorosseto/crawlmeter/security/advisories/new (see [SECURITY.md](SECURITY.md)). Useful reports include a way for a crawler to be billed without paying, a way to make crawlmeter fail open on purpose, or a way to forge an identification stronger than `ua-only`.

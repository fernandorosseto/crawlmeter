# crawlmeter

See how much AI crawler traffic your site serves for free.

AI bots made 4.2% of all HTML requests on Cloudflare's network in 2025, nearly as many as Googlebot's 4.5%, and by June 2026, 52% of all crawler requests were for AI training, up from 22% a year earlier ([Cloudflare Radar 2025 Year in Review](https://blog.cloudflare.com/radar-2025-year-in-review/); [Cloudflare, July 2026](https://blog.cloudflare.com/agentic-internet-bot-report/)). Unlike search engines, they rarely send anyone back: during 2025, Anthropic crawled as many as 500,000 pages for every visitor it referred, and OpenAI as many as 3,700 ([Cloudflare Radar 2025 Year in Review](https://blog.cloudflare.com/radar-2025-year-in-review/)). Cloudflare and AWS now let their own customers see this traffic and put a price on it; if your site runs anywhere else, you have no easy way to know how much of your bandwidth it takes.

## Quickstart

```bash
npm i crawlmeter
```

```js
import express from "express";
import { crawlmeter, createSqliteStore } from "crawlmeter";

const app = express();
app.use(crawlmeter({ price: "$0.01", store: createSqliteStore({ path: "crawlmeter.db" }) }));
```

Once crawlers have visited, from the same directory:

```bash
npx crawlmeter report
```

**Behind a proxy** (Vercel, Fly, Render, Cloudflare, nginx, a load balancer)? Add `trustProxy: true`. Without it, crawlmeter sees your proxy's address instead of the crawler's, cannot prove who is crawling, and reports a potential of zero. It warns you the first time it notices.

**Next.js 16:**

```js
// proxy.js
import { createSqliteStore } from "crawlmeter";
import { crawlmeter } from "crawlmeter/next";

export const proxy = crawlmeter({ price: "$0.01", store: createSqliteStore({ path: "crawlmeter.db" }) });
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

On Vercel, where the filesystem does not persist, use `createPostgresStore({ url: process.env.DATABASE_URL })` instead, and point `npx crawlmeter report --db "$DATABASE_URL"` at the same database.

## What you get

```text
crawlmeter report - crawlmeter.db - everything recorded

  AI crawlers made 1,429 requests, 60.6 MB of data.
  Had you been charging, they would have paid USD 18.14.

  Crawler         Operator      Requests      Data   Potential
  gptbot          openai             932   38.4 MB   USD 14.12
  claudebot       anthropic          402   18.9 MB    USD 4.02
  ccbot           commoncrawl         70    3.3 MB    USD 0.00
  perplexitybot   perplexity          25    4.5 KB    USD 0.00

  Route               Requests   Potential
  /api/*                   120    USD 6.00
  * (default price)      1,214   USD 12.14

  Not billed, and why                                    Requests
  identity not proven strongly enough to bill                  70
  always-free paths (robots.txt, sitemap, .well-known)         25

  Notes
  - 70 crawler requests could not be proven to come from the crawler named
    in the User-Agent, and are not counted toward potential revenue. That is
    deliberate: a User-Agent can be forged by anyone.
```

"Potential" is exactly what crawlmeter would have charged for each of those requests, with your prices, had you turned charging on. Nothing else is counted: a request that could not be billed contributes nothing, and is listed under "Not billed, and why" instead of disappearing.

## Why install this today

To find out how much AI traffic you serve for free, and what it would be worth, with no wallet, no crypto and no account.

The default mode, `observe`, never blocks a request and never charges anyone. It is one package with no dependencies. Human visitors leave the middleware before any work is done and are never recorded. And it reports to nobody. Its only outbound traffic is fetching the IP address lists that OpenAI, Anthropic, Google, Perplexity and Apple publish about their own crawlers, and DNS lookups to confirm Google's and Apple's, all to check that a request claiming to be GPTBot really came from OpenAI. Both can be turned off with `detector: createDetector({ ipRanges: null, resolver: null })`, at the cost of never proving any crawler's identity.

## State of the market

Charging crawlers is possible today, over HTTP 402 and the [x402](https://www.x402.org/) payment protocol. Very little money moves that way yet. In March 2026, the entire x402 protocol processed about $28,000 a day, roughly half of it self-dealing and wash trading rather than real purchases ([CoinDesk, citing Artemis](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet)). Cloudflare's Pay Per Crawl is in closed beta ([Cloudflare docs](https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/what-is-pay-per-crawl/)), and AWS WAF added AI traffic monetization on June 15, 2026, for CloudFront only ([AWS](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-waf-ai-traffic-monetization/)).

crawlmeter's `enforce` mode works today and is covered by the same tests as everything else. It is there for when the market changes. Until then, the number worth having is the one `observe` gives you.

## How it works

```text
request
   |
   v
User-Agent names a known AI crawler? --- no ---> your app      (not recorded, not delayed)
   | yes
   v
identify   User-Agent -> signature headers -> published IP ranges -> reverse DNS
           the strongest proof wins, capped by what the operator publishes
   |
   v
decide     always-free path? paid session? allowlisted? proven enough? priced?
   |
   +-- observe (default) ---> your app, and record what it would have been worth
   |
   +-- enforce ------------> 402 with the price and an x402 challenge,
   |                         or verify and settle the payment, then your app
   v
store      memory, SQLite or Postgres  --->  npx crawlmeter report
```

**Identification** is the whole game, so crawlmeter says exactly how sure it is:

| Confidence | What it means | Billable by default |
| --- | --- | --- |
| `ua-only` | The User-Agent matched a known crawler. Anyone can forge it with one `curl` flag. | no |
| `signed-unverified` | [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) signature headers are present but not checked. Just as forgeable. | no |
| `ip-range` | The address is inside a range the operator publishes for that crawler. | yes |
| `rdns` | Reverse DNS points to the operator's domain, and forward DNS confirms it. | yes |
| `signed-verified` | The signature is verified against the operator's key. Not in v0.1. | yes |

The catalog of crawlers, their published ranges and the strongest proof each one allows lives in [`src/data/agents.json`](src/data/agents.json), built from the operators' own documentation and updated by pull request.

**Failures open.** If identification, the store or a payment facilitator has a problem, the request is served and the problem is reported to `onError`. crawlmeter sits in front of somebody else's site; a dependency having a bad day must never take it offline.

## Configuration

```js
crawlmeter({
  mode: "observe",
  price: "$0.01",
  routes: { "/api/*": "$0.05", "/docs/*": "$0.02" },
  store: createSqliteStore({ path: "crawlmeter.db" }),
  trustProxy: true,
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `"observe"` | `"observe"` records what would have been charged and never blocks. `"enforce"` answers 402 and takes payment. |
| `price` | none | Price for any path no route matches, e.g. `"$0.01"`, `"USD 0.01"` or `0.01`. More than six decimal places is rejected, not rounded. |
| `routes` | `{}` | Path patterns and their prices. The most specific pattern wins. `*` matches anything, including `/`. |
| `free` | `[]` | Paths never charged, **added to** `/robots.txt`, `/sitemap.xml` and `/.well-known/*`, which are always free. |
| `allow` | `[]` | Crawler ids that pass free but are still recorded, e.g. `["googleother"]`. |
| `charge` | `[]` | Crawler ids to charge. Empty means every known AI crawler. |
| `minConfidenceToCharge` | `"ip-range"` | The weakest identification that may be billed. See the table above. |
| `trustProxy` | `false` (Express), `1` (Next.js) | How many proxies in front of the app to trust for `X-Forwarded-For`. See below. |
| `store` | in memory | Where decisions go: `createSqliteStore(...)`, `createPostgresStore(...)`, or a promise of either. |
| `detector` | built in | Identification. `createDetector({ ipRanges: null, resolver: null })` turns off all outbound traffic. |
| `onWarning` | `console.warn` | One-off setup warnings, such as a proxy crawlmeter was not told to trust. |
| `onError` | none | Every error that crawlmeter recovered from by serving the request. |
| `session` | `{ ttlSeconds: 600 }` | In enforce mode, `secret` (required) signs the receipt that lets a crawler that paid for a page fetch its assets without paying again. |
| `payTo`, `network`, `facilitator` | none | Enforce mode: your wallet address, a CAIP-2 network such as `"eip155:8453"`, and the facilitator URL. |
| `x402` | none | Enforce mode in a bundled deployment. See below. |

Crawler ids are the `id` fields in [`src/data/agents.json`](src/data/agents.json), such as `gptbot`, `claudebot`, `perplexitybot` and `ccbot`.

### `trustProxy`

With no trusted proxy, crawlmeter identifies a request by the address of the TCP connection, the one value a client cannot set. Behind a proxy that address is the proxy's, so you need to tell crawlmeter how many proxies you run: `true` for one, or a number for a chain.

crawlmeter then reads the `X-Forwarded-For` entry that **your** proxy added, counting from the right. Not the leftmost entry: nginx, AWS load balancers, Cloudflare and Fly append to whatever the client sent, so the leftmost entry is whatever the client wants it to be. This is not Express's `trust proxy` setting, which crawlmeter does not read and which takes the leftmost entry when set to `true`.

The Next.js proxy has no TCP address at all, so there `trustProxy` defaults to `1`. That is right on Vercel, which overwrites `X-Forwarded-For`, and behind any proxy that appends to it.

## Enforce mode

```bash
npm i @x402/core @x402/evm
```

```js
const meter = crawlmeter({
  mode: "enforce",
  price: "$0.01",
  payTo: "0xYourWallet",
  network: "eip155:8453",
  facilitator: "https://your-facilitator.example",
  session: { secret: process.env.CRAWLMETER_SECRET },
  store: createSqliteStore({ path: "crawlmeter.db" }),
});

app.use(meter);
await meter.ready; // fail the deploy, not the traffic, if payment cannot work
```

A crawler that has not paid gets `402` with a `crawler-price` header and an x402 `payment-required` challenge. Once it pays, it gets the page with `crawler-charged`, an x402 `payment-response` receipt, and a `crawlmeter-session` header that covers the page's assets for `session.ttlSeconds`.

- **Only x402 v2 headers** are emitted: `payment-required`, `payment-signature`, `payment-response`. Not the v1 `x-payment` headers.
- **`crawler-max-price` and `crawler-exact-price` are recorded but never grant access.** Cloudflare can serve on them because it is the merchant of record and bills the crawler afterwards. crawlmeter holds no such position, so only a verified payment opens the page.
- **Payment is settled before the page is served,** so `crawler-charged` is true when it is sent. A crawler pays for the request, not for a successful response.
- **A bad payment gets `402` again; an unreachable facilitator fails open.** A payment that will not decode, pays the wrong amount, or is rejected by the facilitator is refused. The page is served free only when the facilitator itself is down, which crawlmeter checks with a request that carries nothing from the crawler, so a crawler cannot fake an outage.
- **Bundled deployments** (Vercel, Next.js `output: "standalone"`, serverless bundlers) leave out packages loaded lazily, which is how crawlmeter keeps x402 out of observe mode. Import it explicitly so the bundler includes it:

  ```js
  import { x402 } from "crawlmeter/x402";

  export const proxy = crawlmeter({ mode: "enforce", /* ... */ x402 });
  ```

  Without it, enforce mode cannot load x402 and fails open on every request, and says so.

## The report

```bash
npx crawlmeter report                                  # ./crawlmeter.db
npx crawlmeter report --db data/crawlmeter.db --since 30d
npx crawlmeter report --db "$DATABASE_URL" --json      # Postgres, as JSON
```

`--since` takes `24h`, `7d`, `30d`, a date such as `2026-09-01`, or `all` (the default). The database can also come from `$CRAWLMETER_DB`. A database password is never printed. The command refuses to report on a SQLite file that does not exist, rather than create an empty one and report zero.

The in-memory store cannot be read from the command: it lives inside your server process. Use `createSqliteStore` on a server with a disk, or `createPostgresStore` (after `npm i postgres`) anywhere.

## Known limitations

- **A User-Agent proves nothing.** Anyone can claim to be GPTBot. That is why `ua-only` is never billed by default.
- **Signature headers are not verified yet.** RFC 9421 headers are detected and their `Signature-Agent` is read, but the signature is not checked against the operator's key, so they prove nothing either. Verification is planned for v0.2.
- **Some crawlers can never be proven.** CCBot, Meta's `meta-externalagent` and `meta-externalfetcher`, Bytespider, Amazonbot and others publish no address ranges, so they never rise above `ua-only`. They are counted, but not billed by default.
- **Reverse DNS adds latency** to requests from the crawlers that publish a DNS domain (Google, Apple), bounded at 500 ms. It never runs for anything else.
- **`next start` exposed directly to the internet trusts the client's `X-Forwarded-For`.** Next.js only fills that header when the client did not send one, so with no proxy in front, a request can claim any address. Put a proxy in front, as you need one for TLS anyway.
- **The Next.js proxy cannot see page sizes.** It runs before the page renders. Those requests are counted, and the report says their bandwidth is unknown rather than zero.

## Requirements

Node.js 22.13 or later. Tested with Express 5 and Next.js 16. Next.js 15.5 should work with `middleware.js` and the Node.js runtime, but is not tested.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The most useful contribution is keeping [`src/data/agents.json`](src/data/agents.json) accurate as operators publish new crawlers and address ranges.

## License

[MIT](LICENSE)

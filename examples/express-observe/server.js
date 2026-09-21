/**
 * crawlmeter in observe mode — the five-minute version.
 *
 * Nothing is blocked and nothing is charged. Every AI crawler that hits this
 * server is identified, priced as if you were charging, and recorded. The
 * summary at the bottom is the number the whole thing exists to show: what this
 * traffic would have been worth.
 *
 * Run it:
 *   node examples/express-observe/server.js
 *
 * Then, in another terminal:
 *   curl -A "GPTBot/1.4" localhost:3000/blog/hello
 *   curl localhost:3000/report
 */

import express from "express";
import { buildReport, crawlmeter, formatReport } from "crawlmeter";

export function createServer() {
  const app = express();

  const meter = crawlmeter({
    // observe is the default: measure, never block.
    price: "$0.01",
    routes: {
      "/api/*": "$0.05",
    },

    // Deploying behind a proxy — Vercel, Fly, Render, Cloudflare, plain nginx?
    // Uncomment this. Without it crawlmeter sees your proxy's address instead
    // of the crawler's, identification never rises above "ua-only", and the
    // report shows zero forever. crawlmeter says so on the first crawler
    // request, but it is cheaper to read it here.
    //
    // Only turn it on when the proxy setting X-Forwarded-For is one you
    // control: the header is attacker-controlled otherwise, and trusting it
    // lets anyone claim an address inside OpenAI's published range.
    //
    // trustProxy: true,
  });

  app.use(meter);

  app.get("/blog/hello", (request, response) => {
    response.type("text/plain").send("hello from the blog");
  });

  app.get("/api/things", (request, response) => {
    response.json({ things: ["one", "two", "three"] });
  });

  // The same report `npx crawlmeter report` prints. That command reads a
  // database file; this quickstart keeps everything in memory, so the app
  // prints it itself. For history that survives a restart, pass
  // `store: createSqliteStore({ path: "crawlmeter.db" })` and use the command.
  //
  // Curling this from your own machine will show potential revenue of zero, and
  // that is correct. A request from 127.0.0.1 is not inside any range OpenAI
  // publishes, so it only ever reaches `ua-only` confidence, which sits below
  // the default `minConfidenceToCharge`. Turning enforce on would not have
  // billed it, so counting it would be a lie. The report says so, under
  // "Not billed, and why".
  app.get("/report", async (request, response) => {
    const report = buildReport(await meter.store.summary());
    response.type("text/plain").send(formatReport(report));
  });

  return app;
}

// Only listen when run directly, so tests can import this file.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`crawlmeter example listening on http://localhost:${port}`);
    console.log(`try:  curl -A "GPTBot/1.4" localhost:${port}/blog/hello`);
    console.log(`then: curl localhost:${port}/report`);
  });
}

/**
 * crawlmeter in a Next.js app, observe mode.
 *
 * Nothing is blocked and nothing is charged. Every AI crawler that reaches the
 * app is identified, priced as if you were charging, and written to
 * `crawlmeter.db`. Read it with `npx crawlmeter report`.
 *
 * A persistent store, not the in-memory default: Next.js runs this file apart
 * from the rest of the app, so nothing in the app could read an in-memory
 * store — and on Vercel it would vanish with each instance. On a server with a
 * disk, SQLite is enough. On Vercel, use createPostgresStore instead.
 */

import { createSqliteStore } from "crawlmeter";
import { crawlmeter } from "crawlmeter/next";

export const proxy = crawlmeter({
  // observe is the default: measure, never block.
  price: "$0.01",
  routes: {
    "/api/*": "$0.05",
  },
  // No await needed: the store is opened in the background.
  store: createSqliteStore({ path: process.env.CRAWLMETER_DB ?? "crawlmeter.db" }),

  // X-Forwarded-For is trusted for one proxy by default, because the Next.js
  // proxy has no other way to see the client address. That is right on Vercel
  // and behind nginx, Cloudflare or a load balancer. It is NOT right for
  // `next start` exposed straight to the internet, where any client can claim
  // any address — put a proxy in front (you need one for TLS anyway).
});

export const config = {
  // Skip Next's own static assets: crawlers read pages, and every proxy
  // invocation is work. robots.txt stays in, so you can see who reads it.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

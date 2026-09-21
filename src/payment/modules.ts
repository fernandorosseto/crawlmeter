/**
 * `crawlmeter/x402` — the payment library, imported so a bundler can see it.
 *
 *     import { crawlmeter } from "crawlmeter/next";
 *     import { x402 } from "crawlmeter/x402";
 *
 *     export const proxy = crawlmeter({ mode: "enforce", ..., x402 });
 *
 * crawlmeter normally loads x402 lazily, through an import the compiler and
 * bundlers cannot see — that is what keeps observe mode free of any crypto
 * library. The cost of that invisibility shows up when an app is bundled for
 * deployment: Vercel, Next.js `output: "standalone"` and serverless bundlers
 * trace which files the app uses and ship only those, and a lazy import they
 * cannot see is a package they leave out. Enforce mode then cannot load x402
 * and fails open on every request — verified with a standalone Next.js build
 * run outside the repository.
 *
 * This module is the fix. It imports x402 statically, so a bundler that reaches
 * it through your code traces x402 and everything x402 depends on into the
 * bundle. It is a separate entry point, never imported by `crawlmeter` itself:
 * only an app that asks for enforce mode this way ever pulls it in.
 * `test/observe-no-crypto.test.ts` holds both halves of that.
 */

import * as scheme from "@x402/evm/exact/server";
import * as http from "@x402/core/http";
import * as server from "@x402/core/server";
import * as types from "@x402/core/types";

import type { X402Modules } from "./x402.js";

export type { X402Modules };

export const x402: X402Modules = { server, http, types, scheme };

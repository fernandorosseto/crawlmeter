import type { Confidence, EvaluatedRequest, Identification } from "../src/types.js";

export function identify(
  agent: string | null,
  confidence: Confidence | null = "ip-range",
  operator: string | null = "test-operator",
): Identification {
  if (agent === null) {
    return { agent: null, operator: null, confidence: null, evidence: [] };
  }
  return { agent, operator, confidence, evidence: [`ua:${agent}`] };
}

export function request(overrides: Partial<EvaluatedRequest> = {}): EvaluatedRequest {
  return {
    method: "GET",
    path: "/blog/hello",
    identification: identify("gptbot"),
    hasPaymentSignature: false,
    hasValidSession: false,
    maxPriceMicros: null,
    ...overrides,
  };
}

/** Full enforce-mode config, so tests only vary what they care about. */
export const ENFORCE_BASE = {
  mode: "enforce" as const,
  payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
  network: "eip155:8453",
  facilitator: "https://x402.org/facilitator",
  session: { secret: "test-secret" },
};

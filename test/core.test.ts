import { describe, it, expect } from "vitest";
import { mapStatus } from "../src/services/intents.js";
import { reconcile, signWebhook } from "../src/lib/core.js";

describe("intents status mapping", () => {
  it("maps success to paid and never earlier", () => {
    expect(mapStatus("PENDING_DEPOSIT")).toBe("open");
    expect(mapStatus("PROCESSING")).toBe("processing");
    expect(mapStatus("SUCCESS")).toBe("paid");
    expect(mapStatus("REFUNDED")).toBe("refunded");
  });
});

describe("reconciliation", () => {
  const inv: any = { id: "inv_1", amount: "1000000", amountOut: "1000000" };
  it("matches exact amount", () => { expect(reconcile(inv, "1000000").matched).toBe(true); });
  it("flags overpayment", () => { expect(reconcile(inv, "2000000").reason).toBe("overpaid"); });
  it("flags partial payment", () => { expect(reconcile(inv, "500000").reason).toBe("partially_paid"); });
});

describe("webhook signing", () => {
  it("produces stable hmac", () => {
    expect(signWebhook("secret", "{}")).toHaveLength(64);
    expect(signWebhook("secret", "{}")).toBe(signWebhook("secret", "{}"));
  });
});

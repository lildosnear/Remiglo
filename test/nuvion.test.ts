import { describe, it, expect } from "vitest";
import {
  MockNuvion,
  getNuvionClient,
  mapNuvionPayoutStatus,
  convertDecimals,
  nuvionUnitsToChainUnits,
  chainUnitsToNuvionUnits,
} from "../src/services/nuvion.js";

describe("mock nuvion end to end", () => {
  it("runs entity, account, counterparty, quote and transfer to settled", async () => {
    const mock = new MockNuvion();
    mock.fxRate = 1500; // stand in for a naira per dollar rate

    const entity = await mock.createEntity({ name: "Acme Ltd" }, "business");
    expect(entity.status).toBe("pending");
    const approved = await mock.getEntity(entity.id);
    expect(approved.status).toBe("approved");

    const account = await mock.createAccount({ entity_id: entity.id, currency: "USC" });
    expect(account.balance).toBe(0);
    const accounts = await mock.listAccounts(entity.id);
    expect(accounts.map((a) => a.id)).toEqual([account.id]);

    const details = await mock.createAccountDetails({ account_id: account.id, chain: "base" });
    expect(details.status).toBe("active");
    expect(details.wallet_address).toBeTruthy();

    const counterparty = await mock.createCounterparty({ entity_id: entity.id, name: "Ada Contractor" });
    const paymentDetail = await mock.createPaymentDetails({
      counterparty_id: counterparty.id,
      payment_method: "bank-transfer",
      scheme: "nip",
      currency: "NGN",
      country: "NG",
    });

    const quote = await mock.createFxQuote({ from_currency: "USC", to_currency: "NGN", amount_from: 10000, entity_id: entity.id });
    expect(quote.amount_from).toBe(10000);
    expect(quote.amount_to).toBe(15000000);
    expect(quote.rate).toBe(1500);
    const reread = await mock.getFxQuote(quote.id);
    expect(reread.id).toBe(quote.id);

    const transfer = await mock.createTransfer({
      account_id: account.id,
      payment_detail_id: paymentDetail.id,
      counterparty_id: counterparty.id,
      currency: "NGN",
      amount: 15000000,
      type: "bank-transfer",
      narration: "Invoice TP PAY 1",
      unique_reference: "pay_test_1",
      fx_quote_id: quote.id,
      entity_id: entity.id,
    });
    expect(transfer.status).toBe("pending");

    const firstPoll = await mock.getTransfer(transfer.id);
    expect(firstPoll.status).toBe("pending");
    const secondPoll = await mock.getTransfer(transfer.id);
    expect(secondPoll.status).toBe("successful");
    expect(mapNuvionPayoutStatus(secondPoll.status)).toBe("settled");

    const listed = await mock.listTransfers({ entity_id: entity.id });
    expect(listed.map((t) => t.id)).toEqual([transfer.id]);
  });

  it("refuses a reused unique reference, even across rails", async () => {
    const mock = new MockNuvion();
    const body = {
      account_id: "mock_account_x",
      payment_detail_id: "mock_payment_detail_x",
      counterparty_id: "mock_counterparty_x",
      currency: "NGN",
      amount: 100,
      type: "bank-transfer" as const,
      narration: "first",
      unique_reference: "pay_dup_1",
    };
    await mock.createTransfer(body);
    await expect(mock.createTransfer({ ...body, narration: "retry with same reference" })).rejects.toThrow(/409/);
  });
});

describe("mock nuvion forced failure", () => {
  it("maps a forced failed transfer to failed", async () => {
    const mock = new MockNuvion();
    const transfer = await mock.createTransfer({
      account_id: "mock_account_x",
      payment_detail_id: "mock_payment_detail_x",
      counterparty_id: "mock_counterparty_x",
      currency: "NGN",
      amount: 500,
      type: "bank-transfer",
      narration: "will fail",
      unique_reference: "pay_fail_1",
    });
    mock.failTransfer(transfer.id);
    const polled = await mock.getTransfer(transfer.id);
    expect(polled.status).toBe("failed");
    expect(mapNuvionPayoutStatus(polled.status)).toBe("failed");
    const again = await mock.getTransfer(transfer.id);
    expect(again.status).toBe("failed");
  });
});

describe("nuvion status mapping", () => {
  it("covers the whole table", () => {
    expect(mapNuvionPayoutStatus("new")).toBe("sent");
    expect(mapNuvionPayoutStatus("pending")).toBe("processing");
    expect(mapNuvionPayoutStatus("processing")).toBe("processing");
    expect(mapNuvionPayoutStatus("successful")).toBe("settled");
    expect(mapNuvionPayoutStatus("failed")).toBe("failed");
    expect(mapNuvionPayoutStatus("reversed")).toBe("refunded");
    expect(mapNuvionPayoutStatus("cancelled")).toBe("failed");
  });
});

describe("nuvion amount conversion", () => {
  it("scales nuvion cents up to chain units", () => {
    expect(nuvionUnitsToChainUnits("10000")).toBe("100000000"); // 100.00 USDC
    expect(nuvionUnitsToChainUnits("1")).toBe("10000"); // one cent
    expect(nuvionUnitsToChainUnits("0")).toBe("0");
  });

  it("scales chain units down when exact to the cent", () => {
    expect(chainUnitsToNuvionUnits("100000000")).toBe("10000");
    expect(chainUnitsToNuvionUnits("10000")).toBe("1");
    expect(chainUnitsToNuvionUnits("0")).toBe("0");
  });

  it("throws on precision loss below a cent", () => {
    expect(() => chainUnitsToNuvionUnits("100000001")).toThrow(/not exact/);
    expect(() => chainUnitsToNuvionUnits("1")).toThrow(/not exact/);
    expect(() => convertDecimals("150", 2, 0)).toThrow(/not exact/);
  });

  it("round trips whole cent amounts", () => {
    for (const cents of ["0", "1", "99", "10000", "123456789"]) {
      expect(chainUnitsToNuvionUnits(nuvionUnitsToChainUnits(cents))).toBe(cents);
    }
  });

  it("converts generically in both directions", () => {
    expect(convertDecimals("15", 1, 3)).toBe("1500");
    expect(convertDecimals("1500", 3, 1)).toBe("15");
    expect(convertDecimals("42", 6, 6)).toBe("42");
  });
});

describe("getNuvionClient", () => {
  it("returns the mock it is handed", () => {
    const mock = new MockNuvion();
    expect(getNuvionClient(mock)).toBe(mock);
  });
});

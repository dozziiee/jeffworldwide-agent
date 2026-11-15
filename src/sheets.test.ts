import { describe, expect, it, vi } from "vitest";
import { parseSettings } from "./sheets";

const ROWS = [
  ["setting", "value"],
  ["fx_rate_ngn_per_usd", "1,500"],
  ["margin_pct", "10%"],
  ["deposit_pct_in_stock", "0.3"],
  ["deposit_pct_pre_order", "50"],
  ["hold_hours_in_stock", "48"],
];

describe("parseSettings", () => {
  it("reads doorstep_delivery_ngn and accepts percentages in any form", () => {
    expect(parseSettings([...ROWS, ["doorstep_delivery_ngn", "100,000"], ["max_discount_ngn", "500000"]])).toEqual({
      fxRateNgnPerUsd: 1500,
      marginPct: 0.1,
      depositPctInStock: 0.3,
      depositPctPreOrder: 0.5,
      holdHoursInStock: 48,
      doorstepDeliveryNgn: 100_000,
      maxDiscountNgn: 500_000,
    });
  });

  it("treats a missing or invalid doorstep_delivery_ngn as 0 and logs a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSettings(ROWS)).toMatchObject({ doorstepDeliveryNgn: 0, maxDiscountNgn: 0 });
    expect(warn.mock.calls.map(([message]) => message).join(" ")).toMatch(/doorstep_delivery_ngn.*max_discount_ngn/);
    warn.mockClear();
    expect(parseSettings([...ROWS, ["doorstep_delivery_ngn", "tbc"], ["max_discount_ngn", "500000"]])).toMatchObject({
      doorstepDeliveryNgn: 0,
      maxDiscountNgn: 500_000,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still fails clearly when a required setting is missing", () => {
    expect(() => parseSettings(ROWS.slice(0, 3))).toThrow(/Settings tab/);
  });
});

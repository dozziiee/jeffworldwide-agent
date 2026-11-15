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
  it("reads the optional settings and accepts percentages in any form", () => {
    expect(parseSettings([...ROWS, ["doorstep_delivery_ngn", "100,000"], ["discount_pct", "0.015"], ["discount_min_ngn", "200,000"], ["discount_max_ngn", "2000000"]])).toEqual({
      fxRateNgnPerUsd: 1500,
      marginPct: 0.1,
      depositPctInStock: 0.3,
      depositPctPreOrder: 0.5,
      holdHoursInStock: 48,
      doorstepDeliveryNgn: 100_000,
      discountPct: 0.015,
      discountMinNgn: 200_000,
      discountMaxNgn: 2_000_000,
    });
    expect(parseSettings([...ROWS, ["doorstep_delivery_ngn", "100000"], ["discount_pct", "1.5%"], ["discount_min_ngn", "200000"], ["discount_max_ngn", "2000000"]]).discountPct).toBe(0.015);
  });

  it("treats a missing or invalid doorstep_delivery_ngn as 0 and logs a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSettings([...ROWS, ["doorstep_delivery_ngn", "tbc"], ["discount_pct", "0.015"], ["discount_min_ngn", "200,000"], ["discount_max_ngn", "2000000"]])).toMatchObject({ doorstepDeliveryNgn: 0, discountPct: 0.015 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("doorstep_delivery_ngn");
    warn.mockRestore();
  });

  it.each(["discount_pct", "discount_min_ngn", "discount_max_ngn"])("missing %s: no discount at all, with a warning", (name) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [...ROWS, ["doorstep_delivery_ngn", "100000"], ["discount_pct", "0.015"], ["discount_min_ngn", "200,000"], ["discount_max_ngn", "2000000"]].filter((row) => row[0] !== name);
    expect(parseSettings(rows)).toMatchObject({ discountPct: 0, discountMinNgn: 0, discountMaxNgn: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(name);
    warn.mockRestore();
  });

  it("an invalid discount value also means no discount", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [...ROWS, ["doorstep_delivery_ngn", "100000"], ["discount_pct", "tbc"], ["discount_min_ngn", "200000"], ["discount_max_ngn", "2000000"]];
    expect(parseSettings(rows)).toMatchObject({ discountPct: 0, discountMinNgn: 0, discountMaxNgn: 0 });
    warn.mockRestore();
  });

  it("ignores the old max_discount_ngn row", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseSettings([...ROWS, ["doorstep_delivery_ngn", "100000"], ["max_discount_ngn", "500000"], ["discount_pct", "0.015"], ["discount_min_ngn", "200,000"], ["discount_max_ngn", "2000000"]]);
    expect(parsed).not.toHaveProperty("maxDiscountNgn");
    expect(parsed.discountMaxNgn).toBe(2_000_000);
    warn.mockRestore();
  });

  it("still fails clearly when a required setting is missing", () => {
    expect(() => parseSettings(ROWS.slice(0, 3))).toThrow(/Settings tab/);
  });
});

import { describe, expect, it } from "vitest";
import { depositNgn, discountNgn, firstOfferNgn, formatMillions, formatNaira, preOrderPriceNgn, quote, roundX9, type Settings } from "./pricing";

const m = (millions: number) => Math.round(millions * 1_000_000);

const settings: Settings = {
  fxRateNgnPerUsd: 1500,
  marginPct: 0.1,
  depositPctInStock: 0.3,
  depositPctPreOrder: 0.5,
  holdHoursInStock: 48,
  doorstepDeliveryNgn: 0,
  discountPct: 0.015,
  discountMinNgn: 200_000,
  discountMaxNgn: 2_000_000,
};

describe("roundX9", () => {
  it.each([
    [57.3, 57.9],
    [57.9, 57.9],
    [57.95, 57.99],
    [57.995, 58.9],
  ])("brief example: %sm -> %sm", (input, expected) => {
    expect(roundX9(m(input))).toBe(m(expected));
  });

  it.each([
    [57.0, 57.9],
    [57.000001, 57.9],
    [57.900001, 57.99],
    [57.99, 57.99],
    [57.990001, 58.9],
    [0.2, 0.9],
    [99.999999, 100.9],
  ])("boundary: %sm -> %sm", (input, expected) => {
    expect(roundX9(m(input))).toBe(m(expected));
  });

  it("ignores sub-naira float noise at a boundary", () => {
    expect(roundX9(57_900_000.0000001)).toBe(57_900_000);
  });
});

describe("pre-order pricing", () => {
  const costs = { auctionPrice: 20_000, auctionFees: 1_500, groundShipping: 800, oceanShipping: 2_200, clearing: 10_000 };

  it("sums the costs, applies FX and margin, then X.9 rounding", () => {
    // 34,500 USD x 1500 x 1.10 = 56,925,000 -> 56.99m
    expect(preOrderPriceNgn(costs, settings)).toBe(56_990_000);
  });

  it("picks up a changed FX rate", () => {
    // 34,500 x 1600 x 1.10 = 60,720,000 -> 60.9m
    expect(preOrderPriceNgn(costs, { ...settings, fxRateNgnPerUsd: 1600 })).toBe(60_900_000);
  });
});

describe("doorstep delivery on pre-orders", () => {
  const costs = { auctionPrice: 20_000, auctionFees: 1_500, groundShipping: 800, oceanShipping: 2_200, clearing: 10_000 };
  const withDoorstep = { ...settings, doorstepDeliveryNgn: 100_000 };

  it("adds the doorstep fee before X.9 rounding", () => {
    // 34,500 USD x 1500 x 1.10 = 56,925,000; + 100,000 = 57,025,000 -> 57.9m (without the fee: 56.99m)
    expect(preOrderPriceNgn(costs, withDoorstep)).toBe(57_900_000);
    expect(preOrderPriceNgn(costs, settings)).toBe(56_990_000);
  });

  it("flows into the pre-order quote and deposit", () => {
    expect(quote({ status: "in_us", price_ngn: null, costs }, withDoorstep)).toEqual({
      stock_type: "pre_order",
      price_basis: "to_your_doorstep",
      price_ngn: 57_900_000,
      price_display: "57.9m",
      lowest_price_ngn: 57_040_000,
      lowest_price_display: "57.04m",
      first_offer_ngn: 57_550_000,
      first_offer_display: "57.55m",
      deposit_pct: 50,
      deposit_ngn: 28_950_000,
      deposit_display: "₦28,950,000",
    });
  });

  it("does not touch in-stock prices", () => {
    const q = quote({ status: "in_stock", price_ngn: 59_900_000, costs: null }, withDoorstep);
    expect(q).toMatchObject({ price_ngn: 59_900_000, price_basis: "on_ground_lagos" });
  });
});

describe("negotiation room", () => {
  const m = (millions: number) => Math.round(millions * 1_000_000);

  it.each([
    [18.9, 280_000],
    [30.9, 460_000],
    [107.9, 1_610_000],
    [487.99, 2_000_000],
  ])("brief example: %sm -> discount %i", (price, discount) => {
    expect(discountNgn(m(price), settings)).toBe(discount);
  });

  it("is price x discount_pct, rounded down to the nearest 10,000", () => {
    expect(discountNgn(m(59.9), settings)).toBe(890_000); // 898,500
    expect(discountNgn(m(20), settings)).toBe(300_000); // exactly on a boundary, despite floating-point error
  });

  it("is never below discount_min_ngn or above discount_max_ngn", () => {
    expect(discountNgn(m(9.9), settings)).toBe(200_000); // 148,500 raised to the minimum
    expect(discountNgn(m(13.33), settings)).toBe(200_000); // 199,950 raised to the minimum
    expect(discountNgn(m(133.4), settings)).toBe(2_000_000); // 2,001,000 capped
    expect(discountNgn(m(133.3), settings)).toBe(1_990_000); // 1,999,500 rounded down
  });

  it("lowest price is price minus discount, for in-stock and pre-orders alike", () => {
    const inStock = quote({ status: "in_stock", price_ngn: 18_900_000, costs: null }, settings);
    expect(inStock).toMatchObject({ price_ngn: 18_900_000, lowest_price_ngn: 18_620_000, lowest_price_display: "18.62m" });

    const costs = { auctionPrice: 20_000, auctionFees: 1_500, groundShipping: 800, oceanShipping: 2_200, clearing: 10_000 };
    const preOrder = quote({ status: "on_water", price_ngn: null, costs }, settings);
    expect(preOrder).toMatchObject({ price_ngn: 56_990_000, lowest_price_ngn: 56_140_000, lowest_price_display: "56.14m" });
  });

  it("first offer is price minus 40% of the discount, rounded down to the nearest 10,000", () => {
    // 18.9m: discount 280,000; 40% = 112,000; 18,788,000 rounded down.
    expect(quote({ status: "in_stock", price_ngn: 18_900_000, costs: null }, settings)).toMatchObject({
      first_offer_ngn: 18_780_000,
      first_offer_display: "18.78m",
    });
    expect(firstOfferNgn(m(30.9), 460_000)).toBe(30_710_000); // 30,716,000
    expect(firstOfferNgn(m(107.9), 1_610_000)).toBe(107_250_000); // 107,256,000
    expect(firstOfferNgn(m(487.99), 2_000_000)).toBe(487_190_000); // exact
  });

  it("first offer sits between the lowest price and the price", () => {
    for (const price of [9.9, 18.9, 30.9, 59.9, 107.9, 487.99].map(m)) {
      const q = quote({ status: "in_stock", price_ngn: price, costs: null }, settings);
      expect(q.first_offer_ngn).toBeGreaterThan(q.lowest_price_ngn);
      expect(q.first_offer_ngn).toBeLessThan(q.price_ngn);
    }
  });

  it("no discount settings: lowest price and first offer are the price", () => {
    const none = { ...settings, discountPct: 0, discountMinNgn: 0, discountMaxNgn: 0 };
    const q = quote({ status: "in_stock", price_ngn: 59_900_000, costs: null }, none);
    expect(q).toMatchObject({ lowest_price_ngn: 59_900_000, first_offer_ngn: 59_900_000, first_offer_display: "59.9m" });
  });
});

describe("deposit and display", () => {
  it("formats the deposit as full naira with commas", () => {
    expect(formatNaira(28_796_000)).toBe("₦28,796,000");
    expect(formatNaira(5_199_000)).toBe("₦5,199,000");
    expect(formatNaira(950_000)).toBe("₦950,000");
  });

  it("rounds the deposit to the nearest naira", () => {
    expect(depositNgn(59_900_000, 0.3)).toBe(17_970_000);
    expect(depositNgn(57_990_001, 0.125)).toBe(7_248_750);
  });

  it("formats in Jeff's style", () => {
    expect(formatMillions(59_900_000)).toBe("59.9m");
    expect(formatMillions(57_990_000)).toBe("57.99m");
    expect(formatMillions(60_000_000)).toBe("60m");
    expect(formatMillions(17_970_000)).toBe("17.97m");
  });
});

describe("quote", () => {
  it("in stock: uses the sheet price and the in-stock deposit", () => {
    expect(quote({ status: "in_stock", price_ngn: 59_900_000, costs: null }, settings)).toEqual({
      stock_type: "in_stock",
      price_basis: "on_ground_lagos",
      price_ngn: 59_900_000,
      price_display: "59.9m",
      lowest_price_ngn: 59_010_000,
      lowest_price_display: "59.01m",
      first_offer_ngn: 59_540_000,
      first_offer_display: "59.54m",
      deposit_pct: 30,
      deposit_ngn: 17_970_000,
      deposit_display: "₦17,970,000",
    });
  });

  it("pre-order: computes the price and uses the pre-order deposit", () => {
    const costs = { auctionPrice: 20_000, auctionFees: 1_500, groundShipping: 800, oceanShipping: 2_200, clearing: 10_000 };
    for (const status of ["in_us", "on_water"] as const) {
      expect(quote({ status, price_ngn: null, costs }, settings)).toEqual({
        stock_type: "pre_order",
        price_basis: "to_your_doorstep",
        price_ngn: 56_990_000,
        price_display: "56.99m",
        lowest_price_ngn: 56_140_000,
        lowest_price_display: "56.14m",
        first_offer_ngn: 56_650_000,
        first_offer_display: "56.65m",
        deposit_pct: 50,
        deposit_ngn: 28_495_000,
        deposit_display: "₦28,495,000",
      });
    }
  });

  it("only exposes final naira figures", () => {
    const q = quote({ status: "in_stock", price_ngn: 10_000_000, costs: null }, settings);
    expect(Object.keys(q).sort()).toEqual(
      ["deposit_display", "deposit_ngn", "deposit_pct", "first_offer_display", "first_offer_ngn", "lowest_price_display", "lowest_price_ngn", "price_basis", "price_display", "price_ngn", "stock_type"].sort(),
    );
  });

  it("throws when price data is missing", () => {
    expect(() => quote({ status: "in_stock", price_ngn: null, costs: null }, settings)).toThrow();
    expect(() => quote({ status: "on_water", price_ngn: null, costs: null }, settings)).toThrow();
  });
});

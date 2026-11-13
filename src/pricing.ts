// Pricing rules for Jeffworldwide. Pure functions, no I/O.

export type Settings = {
  fxRateNgnPerUsd: number;
  marginPct: number; // fraction, e.g. 0.15
  depositPctInStock: number; // fraction
  depositPctPreOrder: number; // fraction
  holdHoursInStock: number;
  doorstepDeliveryNgn: number; // flat naira amount added to every pre-order
};

export type CostsUsd = {
  auctionPrice: number;
  auctionFees: number;
  groundShipping: number;
  oceanShipping: number;
  clearing: number;
};

export type StockType = "in_stock" | "pre_order";

export type PriceBasis = "to_your_doorstep" | "on_ground_lagos";

export type Quote = {
  stock_type: StockType;
  price_basis: PriceBasis; // pre-orders are priced delivered; in-stock cars as they stand in Lagos
  price_ngn: number;
  price_display: string;
  deposit_pct: number; // percent, e.g. 30
  deposit_ngn: number;
  deposit_display: string;
};

const MILLION = 1_000_000;

/**
 * X.9 rounding rule, in millions of naira with f = floor(m):
 *   m <= f + 0.9  -> f + 0.9
 *   m <= f + 0.99 -> f + 0.99
 *   otherwise     -> f + 1.9
 * Done in whole naira so the comparisons are exact.
 */
export function roundX9(naira: number): number {
  const n = Math.round(naira);
  const floor = Math.floor(n / MILLION) * MILLION;
  const rest = n - floor;
  if (rest <= 900_000) return floor + 900_000;
  if (rest <= 990_000) return floor + 990_000;
  return floor + 1_900_000;
}

export function preOrderPriceNgn(costs: CostsUsd, settings: Settings): number {
  const totalUsd =
    costs.auctionPrice + costs.auctionFees + costs.groundShipping + costs.oceanShipping + costs.clearing;
  return roundX9(totalUsd * settings.fxRateNgnPerUsd * (1 + settings.marginPct) + settings.doorstepDeliveryNgn);
}

export function depositNgn(priceNgn: number, depositPct: number): number {
  return Math.round(priceNgn * depositPct);
}

/** Jeff's style: 59900000 -> "59.9m", 57990000 -> "57.99m". */
export function formatMillions(naira: number): string {
  return `${Math.round(naira / 1000) / 1000}m`;
}

/** Full naira with commas: 28796000 -> "₦28,796,000". */
export function formatNaira(naira: number): string {
  return `₦${Math.round(naira).toLocaleString("en-US")}`;
}

/** Final customer-facing figures for a car. Never includes costs, FX rate or margin. */
export function quote(
  car: { status: "in_stock" | "in_us" | "on_water"; price_ngn: number | null; costs: CostsUsd | null },
  settings: Settings,
): Quote {
  const inStock = car.status === "in_stock";
  const price = inStock ? car.price_ngn : car.costs && preOrderPriceNgn(car.costs, settings);
  if (price == null || !Number.isFinite(price) || price <= 0) {
    throw new Error("Car has no usable price data");
  }
  const pct = inStock ? settings.depositPctInStock : settings.depositPctPreOrder;
  const deposit = depositNgn(price, pct);
  return {
    stock_type: inStock ? "in_stock" : "pre_order",
    price_basis: inStock ? "on_ground_lagos" : "to_your_doorstep",
    price_ngn: price,
    price_display: formatMillions(price),
    deposit_pct: Math.round(pct * 10_000) / 100,
    deposit_ngn: deposit,
    deposit_display: formatNaira(deposit),
  };
}

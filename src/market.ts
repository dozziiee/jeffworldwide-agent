// Compares one of Jeff's cars with market asking prices from the Market tab. Pure, no I/O.

import { formatMillions, type Quote } from "./pricing";
import { normalise, title } from "./search";
import type { Car, MarketRow } from "./sheets";
import type { ToolResult } from "./tools";

export const MARKET_NOTE = "These are asking prices for cars on ground in Nigeria, usually negotiable.";

const SOURCE_NAMES: Record<string, string> = {
  "jiji.ng": "Jiji",
  "cars45.com": "Cars45",
  "autochek.africa": "Autochek",
  "afrotools.com": "Afrotools",
};

/** "https://www.cars45.com/listing/..." -> "Cars45". Unknown sites fall back to their domain. */
export function sourceName(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
  const known = Object.keys(SOURCE_NAMES).find((domain) => host === domain || host.endsWith(`.${domain}`));
  return known ? SOURCE_NAMES[known] : host;
}

/** Distinct non-empty values, in first-seen order, as "a, b". */
const listDistinct = (values: string[]) => [...new Set(values.filter(Boolean))].join(", ");

export function compareMarket(car: Car, q: Quote, market: MarketRow[]): ToolResult {
  const jeff = {
    car_id: car.car_id,
    title: title(car),
    jeff_price_ngn: q.price_ngn,
    jeff_price_display: q.price_display,
    price_basis: q.price_basis,
  };

  const sameModel = market.filter(
    (row) => normalise(row.make) === normalise(car.make) && normalise(row.model) === normalise(car.model),
  );
  // Same year first; otherwise one year older, then one year newer.
  const year = [car.year, car.year - 1, car.year + 1].find((y) => sameModel.some((row) => row.year === y));
  if (year === undefined) {
    return {
      status: "no_comparison",
      message: `No market listings for a ${car.make} ${car.model} from ${car.year - 1} to ${car.year + 1}.`,
      ...jeff,
    };
  }

  // Several rows for one year (different conditions or sources) are combined into one range.
  const rows = sameModel.filter((row) => row.year === year);
  const latest = rows.reduce((a, b) => (b.collected_on > a.collected_on ? b : a));
  const low = Math.min(...rows.map((row) => row.low_ngn));
  const high = Math.max(...rows.map((row) => row.high_ngn));
  const exact = year === car.year;

  return {
    status: "ok",
    ...(!exact && {
      message: `No market listings for ${car.year}; compared with ${year} listings, the nearest year.`,
    }),
    ...jeff,
    market_low_ngn: low,
    market_high_ngn: high,
    market_low_display: formatMillions(low),
    market_high_display: formatMillions(high),
    listings_count: rows.reduce((sum, row) => sum + row.listings_count, 0),
    source_name: listDistinct(rows.map((row) => sourceName(row.source_url))),
    condition: listDistinct(rows.map((row) => row.condition)),
    year_matched: year,
    exact_year_match: exact,
    collected_on: latest.collected_on,
    source_url: latest.source_url,
    difference_vs_low_ngn: q.price_ngn - low,
    note: MARKET_NOTE,
  };
}

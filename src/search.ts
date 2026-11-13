// Inventory search: query normalisation, matching, ordering and result shaping. Pure, no I/O.

import { quote, type Quote, type Settings } from "./pricing";
import type { Car } from "./sheets";
import type { ToolResult } from "./tools";

export type SearchInput = {
  query?: string;
  make?: string;
  model?: string;
  year?: number | string;
  max_price_ngn?: number | string;
  stock_type?: string;
};

const MAX_RESULTS = 5;

// Filler words, English and Pidgin, that say nothing about which car is wanted.
const FILLERS = new Set(
  (
    "how far that this the a an is it its still dey available avail abeg please pls what about " +
    "wetin na much hm price you sure do have any car cars oga boss e i want wan for me get sell selling"
  ).split(" "),
);

// Applied to the normalised query text, before it is split into words.
// "_" keeps a multi-word alias together as one phrase, so "g wagon" does not also match "GLE 63 S AMG".
const PHRASE_ALIASES: [RegExp, string][] = [
  [/\bcyber truck\b/g, "cybertruck"],
  [/\bg ?wagon\b/g, "g_63_amg"],
];

// Applied to single words.
const WORD_ALIASES: Record<string, string> = {
  benz: "mercedes benz",
  merc: "mercedes benz",
  mercedes: "mercedes benz",
  lambo: "lamborghini",
};

/** Lowercase, drop apostrophes, turn all other punctuation into spaces. "G-Wagon" -> "g wagon". */
export const normalise = (text: unknown) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "How far that Benz GLE still dey?" -> ["mercedes benz", "gle"] */
export function queryTerms(query: unknown): string[] {
  let text = normalise(query);
  for (const [pattern, replacement] of PHRASE_ALIASES) text = text.replace(pattern, replacement);
  return text
    .split(" ")
    .filter((word) => word && !FILLERS.has(word))
    .map((word) => WORD_ALIASES[word] ?? word.replaceAll("_", " "));
}

export const title = (car: Car) => [car.year, car.make, car.model, car.trim].filter(Boolean).join(" ");

function carView(car: Car, q: Quote) {
  return {
    car_id: car.car_id,
    title: title(car),
    colour: car.colour,
    interior: car.interior,
    mileage: car.mileage,
    ...q,
    location: car.location,
    highlights: car.highlights,
    ...(q.stock_type === "pre_order" && {
      status: car.status,
      shipping_type: car.shipping_type,
      origin_port: car.origin_port,
      destination_port: car.destination_port,
      expected_berth: car.expected_berth,
    }),
  };
}

/** [{ value, count }], most common first. */
function countBy<T>(items: T[], key: (item: T) => string | number) {
  const counts = new Map<string | number, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

export function searchCars(cars: Car[], settings: Settings, input: SearchInput): ToolResult {
  // Reserved cars are never shown.
  const available = cars
    .filter((car) => car.reservation_status !== "reserved")
    .map((car) => ({
      car,
      q: quote(car, settings),
      model: normalise(car.model),
      // The last entry lets a phrase span model and trim ("G 63" + "AMG").
      fields: [car.make, car.model, car.trim, car.colour, car.interior, car.year, `${car.model} ${car.trim}`].map(normalise),
    }));
  type Entry = (typeof available)[number];

  const words = queryTerms(input.query);
  const terms = [...new Set(words)];
  const make = normalise(WORD_ALIASES[normalise(input.make)] ?? input.make);
  const model = normalise(input.model);
  const year = Number(input.year) || null;
  const maxPrice = Number(input.max_price_ngn) || null;
  const stockType = String(input.stock_type ?? "").trim().toLowerCase();

  // Nothing to search on: describe the stock instead of listing arbitrary cars.
  if (!terms.length && !make && !model && !year && !maxPrice && !stockType) {
    const byMake = new Map<string, Entry[]>();
    for (const entry of available) byMake.set(entry.car.make, [...(byMake.get(entry.car.make) ?? []), entry]);
    return {
      status: "summary",
      message:
        "No search terms were given, so this is a summary of available stock, not a car list. Ask the buyer for a make, model or budget and search again.",
      total_matches: available.length,
      returned: 0,
      truncated: false,
      results: [],
      by_make: [...byMake]
        .map(([name, entries]) => ({
          make: name,
          count: entries.length,
          models: countBy(entries, (e) => e.car.model).map(({ value, count }) => ({ model: value, count })),
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  const hasTerm = (entry: Entry, term: string) => entry.fields.some((field) => field.includes(term));
  const matches = available.filter(
    (entry) =>
      terms.every((term) => hasTerm(entry, term)) &&
      (!make || normalise(entry.car.make).includes(make)) &&
      (!model || entry.model.includes(model)) &&
      (!year || entry.car.year === year) &&
      (!stockType || entry.q.stock_type === stockType) &&
      (!maxPrice || entry.q.price_ngn <= maxPrice),
  );

  if (!matches.length) {
    const unmatched = terms.filter((term) => !available.some((entry) => hasTerm(entry, term)));
    return {
      status: "no_match",
      message: unmatched.length
        ? `No available car matches: ${unmatched.join(", ")}.`
        : "Each word matches some cars, but no single available car matches all the words and filters together.",
      total_matches: 0,
      returned: 0,
      truncated: false,
      unmatched_terms: unmatched,
      results: [],
    };
  }

  // Exact model matches first (the model named in the query or the model filter), then cheapest first.
  const queryText = ` ${words.join(" ")} `;
  const exact = (entry: Entry) => entry.model === model || queryText.includes(` ${entry.model} `);
  matches.sort((a, b) => Number(exact(b)) - Number(exact(a)) || a.q.price_ngn - b.q.price_ngn);

  const results = matches.slice(0, MAX_RESULTS).map((entry) => carView(entry.car, entry.q));
  const truncated = matches.length > MAX_RESULTS;
  return {
    status: "ok",
    total_matches: matches.length,
    returned: results.length,
    truncated,
    results,
    ...(truncated && {
      refine_options: {
        model: countBy(matches, (e) => e.car.model),
        year: countBy(matches, (e) => e.car.year),
        stock_type: countBy(matches, (e) => e.q.stock_type),
      },
    }),
  };
}

import { beforeAll, describe, expect, it, vi } from "vitest";
import { mileageDisplay, queryTerms, searchCars } from "./search";
import { parseInventory, type Car } from "./sheets";

const HEADER =
  "car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status".split(
    ", ",
  );

const settings = { fxRateNgnPerUsd: 1500, marginPct: 0.1, depositPctInStock: 0.3, depositPctPreOrder: 0.5, holdHoursInStock: 48, doorstepDeliveryNgn: 0, maxDiscountNgn: 500_000 };

const inStock = (id: string, make: string, model: string, year: number, trim: string, colour: string, interior: string, price: number, reservation = "available") =>
  [id, make, model, year, trim, colour, interior, "30,000", "in_stock", price, "Lagos", "", "", "", "", "", "", "", "", "", "", "", reservation];

const ROWS = [
  HEADER,
  inStock("H1", "Honda", "Accord", 2020, "Sport 2.0T", "Black", "Black", 52_000_000),
  inStock("H2", "Honda", "Accord", 2019, "EX-L", "White", "Tan", 40_000_000),
  inStock("H3", "Honda", "Civic", 2021, "Touring", "Blue", "Black", 30_000_000),
  inStock("H4", "Honda", "Accord", 2020, "Touring", "Grey", "Black", 45_000_000, "reserved"),
  inStock("H5", "Honda", "Accord Hybrid", 2021, "", "Red", "Black", 25_000_000),
  inStock("E1", "Cadillac", "Escalade", 2023, "Sport AWD", "White", "Jet Black", 185_000_000),
  inStock("E2", "Cadillac", "Escalade", 2023, "Sport Platinum", "Black", "Black", 175_000_000),
  inStock("M1", "Mercedes-Benz", "GLE 450", 2020, "4MATIC", "Black", "Black", 89_000_000),
  inStock("M2", "Mercedes-Benz", "GLE 63 S AMG", 2024, "4MATIC+", "Black", "Red", 204_000_000),
  inStock("M3", "Mercedes-Benz", "GLC 43", 2018, "AMG Coupe", "White", "Red", 60_000_000),
  inStock("M4", "Mercedes-Benz", "G 63 AMG", 2022, "", "Black", "Black", 350_000_000),
  inStock("M5", "Mercedes-Benz", "S 580", 2021, "4MATIC", "Black", "Beige", 136_000_000),
  inStock("M6", "Mercedes-Benz", "C 300", 2019, "", "White", "Black", 35_000_000),
  // Pre-order: 34,500 USD x 1500 x 1.10 -> 56.99m
  ["M7", "Mercedes-Benz", "E 350", 2020, "", "Silver", "Black", "20,000", "on_water", "", "", 20000, 1500, 800, 2200, 10000, "Newark", "Lagos", "RoRo", "2026-12-20", "", "", ""],
  inStock("L1", "Lamborghini", "Urus", 2022, "", "Yellow", "Black", 400_000_000),
  inStock("T1", "Tesla", "Cybertruck", 2024, "AWD", "Silver", "Black", 250_000_000),
];

let cars: Car[];
beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  cars = parseInventory(ROWS).cars;
});

const search = (input: Parameters<typeof searchCars>[2]) => searchCars(cars, settings, input);
const ids = (result: ReturnType<typeof search>) => (result.results as { car_id: string }[]).map((c) => c.car_id);

describe("queryTerms", () => {
  it("lowercases, strips punctuation and drops English and Pidgin filler words", () => {
    expect(queryTerms("How far, that HONDA still dey?!")).toEqual(["honda"]);
    expect(queryTerms("abeg wetin be the price for white Escalade")).toEqual(["be", "white", "escalade"]);
    expect(queryTerms("oga, it's available?")).toEqual([]);
  });

  it("applies aliases", () => {
    expect(queryTerms("benz")).toEqual(["mercedes benz"]);
    expect(queryTerms("Merc GLE")).toEqual(["mercedes benz", "gle"]);
    expect(queryTerms("mercedes")).toEqual(["mercedes benz"]);
    expect(queryTerms("lambo")).toEqual(["lamborghini"]);
    expect(queryTerms("cyber truck")).toEqual(["cybertruck"]);
    expect(queryTerms("G-Wagon")).toEqual(["g 63 amg"]);
    expect(queryTerms("g wagon")).toEqual(["g 63 amg"]);
  });
});

describe("searchCars: the required queries", () => {
  it('"honda": every available Honda, cheapest first, reserved one excluded', () => {
    const res = search({ query: "honda" });
    expect(res).toMatchObject({ status: "ok", total_matches: 4, returned: 4, truncated: false });
    expect(ids(res)).toEqual(["H5", "H3", "H2", "H1"]);
    expect(res.refine_options).toBeUndefined();
  });

  it('"honda accord 2020": the one available 2020 Accord', () => {
    const res = search({ query: "honda accord 2020" });
    expect(res).toMatchObject({ status: "ok", total_matches: 1, returned: 1, truncated: false });
    expect(ids(res)).toEqual(["H1"]);
  });

  it('"how far that honda still dey": same as "honda"', () => {
    const res = search({ query: "how far that honda still dey" });
    expect(res).toMatchObject({ status: "ok", total_matches: 4 });
    expect(ids(res)).toEqual(ids(search({ query: "honda" })));
  });

  it('"white escalade": words can match different fields', () => {
    expect(ids(search({ query: "white escalade" }))).toEqual(["E1"]);
  });

  it('"benz gle": alias plus substring match on the model', () => {
    const res = search({ query: "benz gle" });
    expect(res).toMatchObject({ status: "ok", total_matches: 2, returned: 2, truncated: false });
    expect(ids(res)).toEqual(["M1", "M2"]); // GLE 450 (89m) before GLE 63 S AMG (204m)
  });

  it('"lambo" and "cyber truck"', () => {
    expect(ids(search({ query: "lambo" }))).toEqual(["L1"]);
    expect(ids(search({ query: "cyber truck" }))).toEqual(["T1"]);
    expect(ids(search({ query: "cybertruck" }))).toEqual(["T1"]);
  });

  it("g wagon / g-wagon -> G 63 AMG", () => {
    expect(ids(search({ query: "g wagon" }))).toEqual(["M4"]);
    expect(ids(search({ query: "abeg that G-Wagon still dey?" }))).toEqual(["M4"]);
  });

  it("empty search: a summary by make and model, never a car list", () => {
    for (const input of [{}, { query: "" }, { query: "how far, wetin you get?" }]) {
      const res = search(input);
      expect(res).toMatchObject({ status: "summary", total_matches: 15, returned: 0, truncated: false, results: [] });
      const byMake = res.by_make as { make: string; count: number; models: { model: string; count: number }[] }[];
      expect(byMake[0]).toMatchObject({ make: "Mercedes-Benz", count: 7 });
      expect(byMake.find((m) => m.make === "Honda")).toEqual({
        make: "Honda",
        count: 4, // the reserved Accord is not counted
        models: [
          { model: "Accord", count: 2 },
          { model: "Civic", count: 1 },
          { model: "Accord Hybrid", count: 1 },
        ],
      });
    }
  });

  it("nonsense word: no_match with unmatched_terms", () => {
    const res = search({ query: "honda xyzzy" });
    expect(res).toMatchObject({ status: "no_match", total_matches: 0, returned: 0, truncated: false, results: [], unmatched_terms: ["xyzzy"] });
    expect(search({ query: "ferrari purosangue" }).unmatched_terms).toEqual(["ferrari", "purosangue"]);
  });

  it("no_match when each word matches something but no car matches all", () => {
    const res = search({ query: "yellow accord" });
    expect(res).toMatchObject({ status: "no_match", unmatched_terms: [] });
  });

  it("more than 5 matches: truncated with refine_options", () => {
    const res = search({ query: "benz" });
    expect(res).toMatchObject({ status: "ok", total_matches: 7, returned: 5, truncated: true });
    expect(ids(res)).toEqual(["M6", "M7", "M3", "M1", "M5"]); // cheapest five
    const refine = res.refine_options as Record<string, { value: string | number; count: number }[]>;
    expect(refine.model).toHaveLength(7);
    expect(refine.model).toContainEqual({ value: "GLE 450", count: 1 });
    expect(refine.year[0]).toEqual({ value: 2020, count: 2 });
    expect(refine.stock_type).toEqual([
      { value: "in_stock", count: 6 },
      { value: "pre_order", count: 1 },
    ]);
  });
});

describe("searchCars: photo links", () => {
  const photos = [
    { make: "Honda", model: "Accord", photo_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Accord.jpg/1280px-Accord.jpg", page_url: "https://commons.wikimedia.org/wiki/File:Accord.jpg", author: "Jane Doe", licence: "CC BY-SA 4.0" },
    { make: "mercedes-benz", model: "g 63 amg", photo_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/G63.jpg/1280px-G63.jpg", page_url: "", author: "", licence: "CC0" },
    { make: "Honda", model: "Civic", photo_url: "", page_url: "", author: "", licence: "" }, // nothing suitable was found
  ];
  const BASE = "https://jeff.example.com";
  const find = (query: string) => (searchCars(cars, settings, { query }, photos, BASE).results as any[])[0];

  it("photo found: photo_link is <base url>/car/<car_id>, matched on make + model", () => {
    expect(find("honda accord 2020")).toMatchObject({ car_id: "H1", photo_link: "https://jeff.example.com/car/H1" });
    // Case and punctuation in the Photos tab do not matter.
    expect(find("g wagon")).toMatchObject({ car_id: "M4", photo_link: "https://jeff.example.com/car/M4" });
    // A trailing slash on the base URL does not double up.
    expect((searchCars(cars, settings, { query: "g wagon" }, photos, `${BASE}/`).results as any[])[0].photo_link).toBe("https://jeff.example.com/car/M4");
  });

  it("photo missing: photo_link is empty", () => {
    expect(find("civic").photo_link).toBe(""); // row with an empty photo_url
    expect(find("lambo").photo_link).toBe(""); // no row at all
    expect(find("accord hybrid").photo_link).toBe(""); // "Accord" must not match "Accord Hybrid"
    expect((search({ query: "honda accord 2020" }).results as any[])[0].photo_link).toBe(""); // no Photos data
  });

  it("no longer returns the raw photo fields", () => {
    const car = find("honda accord 2020");
    for (const removed of ["photo_url", "photo_page_url", "photo_credit"]) expect(car).not.toHaveProperty(removed);
  });

  it("returns the vehicle history fields", () => {
    const withHistory = cars.map((car) => (car.car_id === "H1" ? { ...car, vin: "1HGDEMO12LAJW0001", title_status: "Clean", owners: "2", accidents_reported: "1 minor (rear bumper, repaired)" } : car));
    const [car] = searchCars(withHistory, settings, { query: "honda accord 2020" }).results as any[];
    expect(car).toMatchObject({ vin: "1HGDEMO12LAJW0001", title_status: "Clean", owners: "2", accidents_reported: "1 minor (rear bumper, repaired)" });
    // Cars without history data get empty strings, not missing fields.
    expect((search({ query: "civic" }).results as any[])[0]).toMatchObject({ vin: "", title_status: "", owners: "", accidents_reported: "" });
  });
});

describe("searchCars: display fields", () => {
  it("adds the lowest price to each car", () => {
    const [car] = search({ query: "honda accord 2020" }).results as any[];
    expect(car).toMatchObject({ price_ngn: 52_000_000, price_display: "52m", lowest_price_ngn: 51_500_000, lowest_price_display: "51.5m" });
  });

  it("adds mileage_display and keeps the raw mileage", () => {
    const [car] = search({ query: "honda accord 2020" }).results as any[];
    expect(car).toMatchObject({ mileage: "30,000", mileage_display: "30,000 miles" });
    expect(mileageDisplay("42800")).toBe("42,800 miles");
    expect(mileageDisplay("177500")).toBe("177,500 miles");
    expect(mileageDisplay("")).toBe("");
    expect(mileageDisplay("unknown")).toBe("unknown");
  });
});

describe("searchCars: ordering and filters", () => {
  it("puts exact model matches first, then price ascending", () => {
    // "Accord Hybrid" is cheapest but is not an exact match for "accord".
    expect(ids(search({ query: "accord" }))).toEqual(["H2", "H1", "H5"]);
    expect(ids(search({ model: "accord" }))).toEqual(["H2", "H1", "H5"]);
  });

  it("combines structured filters with the query using AND", () => {
    expect(ids(search({ query: "benz", max_price_ngn: 60_000_000 }))).toEqual(["M6", "M7", "M3"]);
    expect(ids(search({ query: "benz", stock_type: "pre_order" }))).toEqual(["M7"]);
    expect(ids(search({ query: "black", make: "Honda" }))).toEqual(["H5", "H3", "H1"]);
    expect(ids(search({ make: "benz", year: "2020" }))).toEqual(["M7", "M1"]);
    expect(search({ query: "honda", year: 2015 })).toMatchObject({ status: "no_match", unmatched_terms: [] });
  });

  it("filters alone are a search, not a summary", () => {
    const res = search({ stock_type: "pre_order" });
    expect(res.status).toBe("ok");
    expect(ids(res)).toEqual(["M7"]);
    expect((res.results as any[])[0]).toMatchObject({ status: "on_water", shipping_type: "RoRo", price_display: "56.99m" });
  });

  it("never leaks costs, FX or margin", () => {
    expect(JSON.stringify(search({ query: "benz" }))).not.toMatch(/usd|fx|margin/i);
  });
});

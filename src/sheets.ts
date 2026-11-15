// Google Sheets access: the sheet is the only data store.
// Uses the Sheets REST API directly with a service-account JWT (no heavy SDK).

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { HEADERS } from "./config/constants";
import { requestJson, requireEnv, ServiceUnavailable } from "./http";
import type { CostsUsd, Settings } from "./pricing";

export type ReservationStatus = "available" | "pending_payment" | "reserved" | "payment_review";

export type Car = {
  row: number; // 1-based row number in the Inventory tab
  car_id: string;
  make: string;
  model: string;
  year: number;
  trim: string;
  colour: string;
  interior: string;
  mileage: string;
  status: "in_stock" | "in_us" | "on_water";
  price_ngn: number | null;
  costs: CostsUsd | null;
  location: string;
  origin_port: string;
  destination_port: string;
  shipping_type: string;
  expected_berth: string;
  highlights: string;
  reservation_ref: string;
  reservation_status: ReservationStatus; // an expired payment_review is read as "available"
  payment_url: string; // the Paystack link for the pending payment, if any
  vin: string;
  title_status: string; // e.g. "Clean"
  owners: string; // number of previous owners, as written in the sheet
  accidents_reported: string; // e.g. "None reported"
  review_until: string; // ISO time a payment_review hold ends
};

/** Reserved, or on hold while a disputed payment is reviewed: not for sale either way. */
export const isHeld = (car: Car) => car.reservation_status === "reserved" || car.reservation_status === "payment_review";

export type Sheet = { cars: Car[]; settings: Settings; columns: Record<string, number> };

const API = "https://sheets.googleapis.com/v4/spreadsheets";

// ---------- parsing (pure, exported for tests) ----------

/** "59,900,000", "₦59.9", "$1,200" -> number; blank or junk -> NaN. */
export function toNumber(cell: unknown): number {
  const cleaned = String(cell ?? "").replace(/[^0-9.\-]/g, "");
  return cleaned === "" ? NaN : Number(cleaned);
}

/** Accepts 0.3, 30 or "30%" and returns a fraction. */
export function toFraction(cell: unknown): number {
  const n = toNumber(cell);
  return String(cell).includes("%") || n > 1 ? n / 100 : n;
}

export function parseSettings(rows: unknown[][]): Settings {
  const map = new Map(rows.map((r) => [String(r[0] ?? "").trim().toLowerCase(), r[1]]));
  // Optional settings: a missing or invalid value counts as 0, with a warning.
  const optional = (name: string) => {
    const value = toNumber(map.get(name));
    if (Number.isFinite(value) && value >= 0) return value;
    console.warn(`[sheet] Settings tab has no valid ${name} row; using 0`);
    return 0;
  };
  // The discount needs all three rows. If any is missing or invalid, there is no discount.
  const discountRows = { discount_pct: toFraction(map.get("discount_pct")), discount_min_ngn: toNumber(map.get("discount_min_ngn")), discount_max_ngn: toNumber(map.get("discount_max_ngn")) };
  const badDiscount = Object.entries(discountRows).filter(([, value]) => !Number.isFinite(value) || value < 0).map(([name]) => name);
  if (badDiscount.length) {
    console.warn(`[sheet] Settings tab has no valid ${badDiscount.join(", ")} row; using no discount`);
  }
  const discount = badDiscount.length ? { discountPct: 0, discountMinNgn: 0, discountMaxNgn: 0 } : {
    discountPct: discountRows.discount_pct,
    discountMinNgn: discountRows.discount_min_ngn,
    discountMaxNgn: discountRows.discount_max_ngn,
  };
  const settings: Settings = {
    doorstepDeliveryNgn: optional("doorstep_delivery_ngn"),
    ...discount,
    fxRateNgnPerUsd: toNumber(map.get("fx_rate_ngn_per_usd")),
    marginPct: toFraction(map.get("margin_pct")),
    depositPctInStock: toFraction(map.get("deposit_pct_in_stock")),
    depositPctPreOrder: toFraction(map.get("deposit_pct_pre_order")),
    holdHoursInStock: toNumber(map.get("hold_hours_in_stock")),
  };
  for (const [key, value] of Object.entries(settings)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ServiceUnavailable(`Settings tab has a missing or invalid value for ${key}`);
    }
  }
  return settings;
}

/** Returns a Car, or a string explaining why the row is malformed. */
export function parseCar(columns: Record<string, number>, cells: unknown[], row: number): Car | string {
  const get = (name: string) => String(cells[columns[name]] ?? "").trim();

  const car_id = get("car_id");
  if (!car_id) return "missing car_id";

  const status = get("status").toLowerCase();
  if (status !== "in_stock" && status !== "in_us" && status !== "on_water") return `unknown status "${status}"`;

  let reservation_status = get("reservation_status").toLowerCase() || "available";
  if (!["available", "pending_payment", "reserved", "payment_review"].includes(reservation_status)) {
    return `unknown reservation_status "${reservation_status}"`;
  }
  // A payment review holds the car only until review_until; after that the car is for sale again.
  if (reservation_status === "payment_review" && !(Date.parse(get("review_until")) > Date.now())) {
    reservation_status = "available";
  }

  const year = toNumber(get("year"));
  if (!get("make") || !get("model") || !Number.isInteger(year)) return "missing make, model or year";

  let price_ngn: number | null = null;
  let costs: CostsUsd | null = null;
  if (status === "in_stock") {
    price_ngn = toNumber(get("price_ngn"));
    if (!(price_ngn > 0)) return "in-stock car without a valid price_ngn";
  } else {
    costs = {
      auctionPrice: toNumber(get("auction_price_usd")),
      auctionFees: toNumber(get("auction_fees_usd")),
      groundShipping: toNumber(get("ground_shipping_usd")),
      oceanShipping: toNumber(get("ocean_shipping_usd")),
      clearing: toNumber(get("clearing_usd")),
    };
    if (Object.values(costs).some((v) => !Number.isFinite(v) || v < 0)) return "pre-order car with invalid cost columns";
  }

  return {
    row,
    car_id,
    make: get("make"),
    model: get("model"),
    year,
    trim: get("trim"),
    colour: get("colour"),
    interior: get("interior"),
    mileage: get("mileage"),
    status,
    price_ngn,
    costs,
    location: get("location"),
    origin_port: get("origin_port"),
    destination_port: get("destination_port"),
    shipping_type: get("shipping_type"),
    expected_berth: get("expected_berth"),
    highlights: get("highlights"),
    reservation_ref: get("reservation_ref"),
    reservation_status: reservation_status as ReservationStatus,
    payment_url: get("payment_url"),
    review_until: get("review_until"),
    vin: get("vin"),
    title_status: get("title_status"),
    owners: get("owners"),
    accidents_reported: get("accidents_reported"),
  };
}

export function parseInventory(rows: unknown[][]): { cars: Car[]; columns: Record<string, number> } {
  const [header = [], ...data] = rows;
  const columns: Record<string, number> = {};
  header.forEach((name, i) => (columns[String(name).trim().toLowerCase()] = i));
  for (const required of ["car_id", "status", "reservation_ref", "reservation_status"]) {
    if (!(required in columns)) throw new ServiceUnavailable(`Inventory tab is missing the ${required} column`);
  }

  const cars: Car[] = [];
  data.forEach((cells, i) => {
    const row = i + 2;
    if (!cells || cells.every((c) => String(c ?? "").trim() === "")) return; // blank line
    const parsed = parseCar(columns, cells, row);
    if (typeof parsed === "string") console.warn(`[sheet] skipping Inventory row ${row}: ${parsed}`);
    else cars.push(parsed);
  });
  return { cars, columns };
}

// ---------- Photos and Market rows (parsing) ----------

export const PHOTO_HEADERS = ["make", "model", "photo_url", "page_url", "author", "licence"];

export type PhotoRow = { make: string; model: string; photo_url: string; page_url: string; author: string; licence: string };

export function parsePhotos(rows: unknown[][]): PhotoRow[] {
  const [header = [], ...data] = rows;
  const columns: Record<string, number> = {};
  header.forEach((name, i) => (columns[String(name).trim().toLowerCase()] = i));
  const get = (cells: unknown[], name: string) => String(cells[columns[name]] ?? "").trim();
  return data
    .filter((cells) => cells && get(cells, "make") && get(cells, "model"))
    .map((cells) => ({
      make: get(cells, "make"),
      model: get(cells, "model"),
      photo_url: get(cells, "photo_url"),
      page_url: get(cells, "page_url"),
      author: get(cells, "author"),
      licence: get(cells, "licence"),
    }));
}

export const MARKET_HEADERS = [
  "make",
  "model",
  "year",
  "condition",
  "low_ngn",
  "high_ngn",
  "listings_count",
  "source_url",
  "collected_on",
];

export type MarketRow = {
  make: string;
  model: string;
  year: number;
  condition: string;
  low_ngn: number;
  high_ngn: number;
  listings_count: number;
  source_url: string;
  collected_on: string;
};

/** Parses the Market tab. Rows without make, model, year or a usable price range are skipped and logged. */
export function parseMarket(rows: unknown[][]): MarketRow[] {
  const [header = [], ...data] = rows;
  const columns: Record<string, number> = {};
  header.forEach((name, i) => (columns[String(name).trim().toLowerCase()] = i));

  const market: MarketRow[] = [];
  data.forEach((cells, i) => {
    if (!cells || cells.every((c) => String(c ?? "").trim() === "")) return; // blank line
    const get = (name: string) => String(cells[columns[name]] ?? "").trim();
    const year = toNumber(get("year"));
    const low = toNumber(get("low_ngn"));
    const high = toNumber(get("high_ngn"));
    if (!get("make") || !get("model") || !Number.isInteger(year) || !(low > 0) || !(high >= low)) {
      console.warn(`[sheet] skipping Market row ${i + 2}: missing make, model, year or price range`);
      return;
    }
    market.push({
      make: get("make"),
      model: get("model"),
      year,
      condition: get("condition"),
      low_ngn: low,
      high_ngn: high,
      listings_count: toNumber(get("listings_count")) || 0,
      source_url: get("source_url"),
      collected_on: get("collected_on"),
    });
  });
  return market;
}

export const LOG_HEADERS = [
  "timestamp_utc",
  "tool",
  "inputs_json",
  "status",
  "total_matches",
  "reference",
  "duration_ms",
  "error_message",
];

export const REQUEST_HEADERS = ["timestamp_utc", "car_id", "title", "request_type", "reason", "note", "status", "reference"];

// ---------- Google auth: one client per server instance ----------

/** A failed Sheets API call, with Google's HTTP status and message. Still counts as "service unavailable". */
export class SheetsApiError extends ServiceUnavailable {
  constructor(
    readonly status: number,
    readonly apiMessage: string,
  ) {
    super(`Google Sheets error: ${apiMessage || status}`);
  }
}

/** True only when Google explicitly says the tab does not exist. A timeout or any other failure is not that. */
export const isMissingTab = (err: unknown): err is SheetsApiError =>
  err instanceof SheetsApiError && err.status === 400 && /unable to parse range/i.test(err.apiMessage);

/** Google calls go through here: on a timeout, network error or 5xx, try once more before giving up. */
async function googleRequest(service: string, url: string, init: RequestInit, retry = true) {
  try {
    return await requestJson(service, url, init);
  } catch (err) {
    if (!retry || !(err instanceof ServiceUnavailable)) throw err;
    console.warn(`[google] ${err.message}; retrying once`);
    return requestJson(service, url, init);
  }
}

// Created once and reused by every call this server instance handles.
const googleAuth: { key: KeyObject | null; token: string; expiresAt: number; pending: Promise<string> | null } = {
  key: null,
  token: "",
  expiresAt: 0,
  pending: null,
};

async function fetchToken(): Promise<string> {
  const email = requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  try {
    googleAuth.key ??= createPrivateKey(requireEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n"));
  } catch (err) {
    if (err instanceof ServiceUnavailable) throw err;
    throw new ServiceUnavailable("GOOGLE_PRIVATE_KEY is not a valid private key");
  }
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(googleAuth.key, "base64url");

  const res = await googleRequest("Google", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { [HEADERS.CONTENT_TYPE]: "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new ServiceUnavailable(`Google auth failed: ${res.body?.error_description ?? res.status}`);

  googleAuth.token = res.body.access_token;
  googleAuth.expiresAt = Date.now() + res.body.expires_in * 1000;
  return googleAuth.token;
}

/** The current access token; fetched at most once at a time and reused until it is about to expire. */
async function accessToken(): Promise<string> {
  if (googleAuth.token && googleAuth.expiresAt > Date.now() + 60_000) return googleAuth.token;
  googleAuth.pending ??= fetchToken().finally(() => (googleAuth.pending = null));
  return googleAuth.pending;
}

/**
 * One authenticated call to the Sheets API for this spreadsheet. Exported for the one-off scripts.
 * retry: pass false for calls that must not be repeated (appending a row twice would duplicate it).
 */
export async function sheetsRequest(path: string, init: RequestInit = {}, retry = true): Promise<any> {
  const token = await accessToken();
  // Paths like "values/..." hang off the spreadsheet; ":batchUpdate" and "?fields=" act on it directly.
  const separator = path.startsWith(":") || path.startsWith("?") ? "" : "/";
  const res = await googleRequest(
    "Google Sheets",
    `${API}/${requireEnv("GOOGLE_SHEET_ID")}${separator}${path}`,
    { ...init, headers: { [HEADERS.AUTHORIZATION]: `Bearer ${token}`, [HEADERS.CONTENT_TYPE]: "application/json" } },
    retry,
  );
  if (!res.ok) throw new SheetsApiError(res.status, String(res.body?.error?.message ?? ""));
  return res.body;
}

// ---------- reading tabs: one request, cached in memory ----------

type TabName = "Inventory" | "Settings" | "Market" | "Photos";

// How long each tab's rows are reused, and the header row for tabs the server may create.
const TABS: Record<TabName, { ttlMs: number; headers?: string[] }> = {
  Inventory: { ttlMs: 15_000 },
  Settings: { ttlMs: 15_000 },
  Market: { ttlMs: 15_000, headers: MARKET_HEADERS },
  Photos: { ttlMs: 10 * 60_000, headers: PHOTO_HEADERS },
};

const cache = new Map<TabName, { rows: unknown[][]; at: number }>();

/** Forgets cached rows: one tab, or everything. The next read fetches them again. */
export function clearCache(tab?: TabName): void {
  if (tab) cache.delete(tab);
  else cache.clear();
}

/** For tests: forget the cache and the Google token. */
export function resetSheetsState(): void {
  cache.clear();
  Object.assign(googleAuth, { key: null, token: "", expiresAt: 0, pending: null });
}

async function createTab(title: string, headers: string[]): Promise<void> {
  await sheetsRequest(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  await sheetsRequest(`values/${title}!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [headers] }),
  });
}

/** Fetches the given tabs in ONE batchGet and caches them. */
async function fetchTabs(names: TabName[]): Promise<void> {
  try {
    const body = await sheetsRequest(`values:batchGet?${names.map((name) => `ranges=${name}`).join("&")}`);
    const at = Date.now();
    names.forEach((name, i) => cache.set(name, { rows: body.valueRanges?.[i]?.values ?? [], at }));
  } catch (err) {
    // A tab is created only when Google explicitly reports that it does not exist, and only if
    // it is one the server owns (Market, Photos). Timeouts and other errors are never a reason to create one.
    const missing = isMissingTab(err)
      ? names.find((name) => TABS[name].headers && new RegExp(`:\\s*'?${name}\\b`, "i").test(err.apiMessage))
      : undefined;
    if (!missing) throw err;
    const headers = TABS[missing].headers!;
    console.warn(`[sheet] the ${missing} tab does not exist; creating it`);
    await createTab(missing, headers);
    cache.set(missing, { rows: [headers], at: Date.now() });
    const rest = names.filter((name) => name !== missing);
    if (rest.length) await fetchTabs(rest);
  }
}

/** Rows for the given tabs: from the cache while fresh, otherwise all stale ones in a single request. */
async function readTabs(names: TabName[]): Promise<Record<TabName, unknown[][]>> {
  const now = Date.now();
  const stale = names.filter((name) => {
    const hit = cache.get(name);
    return !hit || now - hit.at >= TABS[name].ttlMs;
  });
  if (stale.length) await fetchTabs(stale);
  return Object.fromEntries(names.map((name) => [name, cache.get(name)!.rows])) as Record<TabName, unknown[][]>;
}

export type SheetData = { sheet: Sheet; photos: PhotoRow[]; market: MarketRow[] };

/**
 * Everything a tool needs, in one request: Inventory and Settings, plus Photos and/or Market if asked for.
 * fresh: read Inventory from Google even if a cached copy is available. Use it before changing a reservation.
 */
export async function loadData(extra: ("Photos" | "Market")[] = [], options: { fresh?: boolean } = {}): Promise<SheetData> {
  if (options.fresh) clearCache("Inventory");
  const rows = await readTabs(["Inventory", "Settings", ...extra]);
  return {
    sheet: { ...parseInventory(rows.Inventory), settings: parseSettings(rows.Settings) },
    photos: extra.includes("Photos") ? parsePhotos(rows.Photos) : [],
    market: extra.includes("Market") ? parseMarket(rows.Market) : [],
  };
}

export const loadSheet = async (options: { fresh?: boolean } = {}): Promise<Sheet> => (await loadData([], options)).sheet;
export const loadPhotos = async (): Promise<PhotoRow[]> => parsePhotos((await readTabs(["Photos"])).Photos);
export const loadMarket = async (): Promise<MarketRow[]> => parseMarket((await readTabs(["Market"])).Market);

/** Signs in to Google and loads every cached tab, so the next tool call is fast. Used by GET /health. */
export async function warmUp(): Promise<void> {
  await readTabs(["Inventory", "Settings", "Market", "Photos"]);
}

// ---------- writing ----------

function columnLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

export type RowFields = Partial<
  Record<"reservation_ref" | "reservation_status" | "agreed_price_ngn" | "payment_url" | "review_until", string | number>
>;

/**
 * Writes the given reservation columns on one car's row. "" clears a cell.
 * A column that does not exist yet is added to the Inventory tab, unless it is only being cleared.
 * The Inventory cache is cleared straight away, so no later read sees the old state.
 */
export async function writeReservation(sheet: Sheet, car: Car, fields: RowFields): Promise<void> {
  clearCache("Inventory");
  try {
    const data = [];
    for (const [name, value] of Object.entries(fields)) {
      if (!(name in sheet.columns)) {
        if (value === "") continue; // nothing to clear
        const index = Math.max(...Object.values(sheet.columns)) + 1; // first free column
        await sheetsRequest(`values/Inventory!${columnLetter(index)}1?valueInputOption=RAW`, {
          method: "PUT",
          body: JSON.stringify({ values: [[name]] }),
        });
        sheet.columns[name] = index;
      }
      data.push({ range: `Inventory!${columnLetter(sheet.columns[name])}${car.row}`, values: [[value]] });
    }
    if (!data.length) return;
    await sheetsRequest("values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    });
  } finally {
    clearCache("Inventory"); // also drop anything read while the write was in flight
  }
}

/**
 * Appends one row to a tab. Values are plain text, never formulas.
 * If Google reports that the tab does not exist, it is created with its headers and the row is appended.
 * The append is not repeated after a timeout, because the first attempt may have gone through.
 */
async function appendRow(title: string, headers: string[], row: (string | number)[]): Promise<void> {
  const append = () =>
    sheetsRequest(
      `values/${title}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [row] }) },
      false,
    );
  try {
    await append();
  } catch (err) {
    if (!isMissingTab(err)) throw err;
    console.warn(`[sheet] the ${title} tab does not exist; creating it`);
    await createTab(title, headers);
    await append();
  }
}

export const appendLog = (row: (string | number)[]) => appendRow("Logs", LOG_HEADERS, row);

/** Records a request for the team. Requests can change what happens to a car, so the Inventory cache is cleared. */
export async function appendRequest(row: (string | number)[]): Promise<void> {
  clearCache("Inventory");
  await appendRow("Requests", REQUEST_HEADERS, row);
}

/** Replaces a whole tab with a header row plus the given rows. Used by one-off scripts, not by the server. */
export async function replaceTab(title: string, headers: string[], rows: (string | number)[][]): Promise<void> {
  try {
    await sheetsRequest(`values/${title}:clear`, { method: "POST", body: "{}" });
  } catch (err) {
    if (!isMissingTab(err)) throw err;
    await createTab(title, headers);
  }
  await sheetsRequest(`values/${title}!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [headers, ...rows] }),
  });
  clearCache();
}

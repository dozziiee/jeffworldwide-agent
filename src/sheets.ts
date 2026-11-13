// Google Sheets access: the sheet is the only data store.
// Uses the Sheets REST API directly with a service-account JWT (no heavy SDK).

import { createSign } from "node:crypto";
import { requestJson, requireEnv, ServiceUnavailable } from "./http";
import type { CostsUsd, Settings } from "./pricing";

export type ReservationStatus = "available" | "pending_payment" | "reserved";

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
  reservation_status: ReservationStatus;
};

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
  const settings: Settings = {
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

  const reservation_status = get("reservation_status").toLowerCase() || "available";
  if (!["available", "pending_payment", "reserved"].includes(reservation_status)) {
    return `unknown reservation_status "${reservation_status}"`;
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

// ---------- Google auth ----------

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const email = requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const key = requireEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;

  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
  } catch {
    throw new ServiceUnavailable("GOOGLE_PRIVATE_KEY is not a valid private key");
  }

  const res = await requestJson("Google", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new ServiceUnavailable(`Google auth failed: ${res.body?.error_description ?? res.status}`);

  cachedToken = { value: res.body.access_token, expiresAt: Date.now() + res.body.expires_in * 1000 };
  return cachedToken.value;
}

async function sheetsRequest(path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken();
  // Paths like "values/..." hang off the spreadsheet; ":batchUpdate" is an action on it.
  const separator = path.startsWith(":") ? "" : "/";
  const res = await requestJson("Google Sheets", `${API}/${requireEnv("GOOGLE_SHEET_ID")}${separator}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new ServiceUnavailable(`Google Sheets error: ${res.body?.error?.message ?? res.status}`);
  return res.body;
}

// ---------- public API ----------

/** Reads Inventory and Settings fresh, in one request. */
export async function loadSheet(): Promise<Sheet> {
  const body = await sheetsRequest("values:batchGet?ranges=Inventory&ranges=Settings");
  const [inventory, settings] = body.valueRanges ?? [];
  return { ...parseInventory(inventory?.values ?? []), settings: parseSettings(settings?.values ?? []) };
}

function columnLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/** Writes reservation_ref and reservation_status on one car's row. */
export async function writeReservation(sheet: Sheet, car: Car, ref: string, status: ReservationStatus): Promise<void> {
  const cell = (name: string) => `Inventory!${columnLetter(sheet.columns[name])}${car.row}`;
  await sheetsRequest("values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        { range: cell("reservation_ref"), values: [[ref]] },
        { range: cell("reservation_status"), values: [[status]] },
      ],
    }),
  });
}

// ---------- Logs tab ----------

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

let logsTabReady = false; // checked once per server instance

/** Creates the Logs tab and its header row if either is missing. */
async function ensureLogsTab(): Promise<void> {
  let header: unknown[] | undefined;
  try {
    header = (await sheetsRequest("values/Logs!A1:H1")).values?.[0];
  } catch {
    // Reading failed, most likely because the tab does not exist yet.
    await sheetsRequest(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "Logs" } } }] }),
    });
  }
  if (!header?.length) {
    await sheetsRequest("values/Logs!A1:H1?valueInputOption=RAW", {
      method: "PUT",
      body: JSON.stringify({ values: [LOG_HEADERS] }),
    });
  }
  logsTabReady = true;
}

/** Appends one row to the Logs tab. Values are written as plain text, never as formulas. */
export async function appendLog(row: (string | number)[]): Promise<void> {
  if (!logsTabReady) await ensureLogsTab();
  await sheetsRequest("values/Logs!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
    method: "POST",
    body: JSON.stringify({ values: [row] }),
  });
}

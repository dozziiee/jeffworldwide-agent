// The three MCP tools. Each returns a plain object with a `status` the agent can act on.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceUnavailable } from "./http";
import { compareMarket } from "./market";
import { initializeTransaction, verifyTransaction } from "./paystack";
import { quote } from "./pricing";
import { searchCars, title, type SearchInput } from "./search";
import { appendLog, loadMarket, loadSheet, writeReservation, type Car } from "./sheets";

export type ToolResult = { status: string; message?: string; [key: string]: unknown };

const PENDING_HOLD_MS = 30 * 60 * 1000;

const findCar = (cars: Car[], carId: unknown) =>
  cars.find((c) => c.car_id.toLowerCase() === String(carId ?? "").trim().toLowerCase());

/** "JW-013-1731400000000" -> 1731400000000 (NaN if the reference has no timestamp). */
const referenceTime = (ref: string) => Number(ref.split("-").pop());

// ---------- 1. search_inventory ----------

export async function searchInventory(input: SearchInput): Promise<ToolResult> {
  const { cars, settings } = await loadSheet();
  return searchCars(cars, settings, input);
}

// ---------- 2. create_reservation ----------

export type CreateInput = { car_id: string; customer_name: string; customer_email: string };

export async function createReservation(input: CreateInput): Promise<ToolResult> {
  const name = String(input.customer_name ?? "").trim();
  const email = String(input.customer_email ?? "").trim();
  if (!input.car_id || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: "invalid_input", message: "car_id, customer_name and a valid customer_email are required." };
  }

  const sheet = await loadSheet();
  const car = findCar(sheet.cars, input.car_id);
  if (!car) return { status: "car_not_found", message: `No car with id ${input.car_id}.` };

  if (car.reservation_status === "reserved") {
    return { status: "car_unavailable", message: "This car is already reserved." };
  }
  if (car.reservation_status === "pending_payment" && Date.now() - referenceTime(car.reservation_ref) < PENDING_HOLD_MS) {
    return { status: "car_unavailable", message: "Another customer started paying for this car in the last 30 minutes." };
  }

  // Price and deposit are fixed here; they travel in Paystack metadata, which locks the FX rate.
  const q = quote(car, sheet.settings);
  const idPart = car.car_id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^JW-/i, "");
  const reference = `JW-${idPart}-${Date.now()}`;

  const init = await initializeTransaction({
    email,
    amountNgn: q.deposit_ngn,
    reference,
    metadata: {
      car_id: car.car_id,
      customer_name: name,
      price_ngn: q.price_ngn,
      deposit_ngn: q.deposit_ngn,
      stock_type: q.stock_type,
    },
  });
  if (!init.ok) return { status: "payment_init_failed", message: init.message };

  await writeReservation(sheet, car, reference, "pending_payment");
  return {
    status: "link_created",
    payment_url: init.payment_url,
    reference,
    deposit_ngn: q.deposit_ngn,
    deposit_display: q.deposit_display,
    price_display: q.price_display,
  };
}

// ---------- 3. confirm_reservation ----------

export async function confirmReservation(input: { reference: string }): Promise<ToolResult> {
  const reference = String(input.reference ?? "").trim();
  if (!reference) return { status: "invalid_input", message: "reference is required." };

  const tx = await verifyTransaction(reference);
  if (!tx.found) return { status: "reference_not_found", message: "Paystack does not know this reference." };

  // Paystack calls a link nobody has paid yet "abandoned". Keep the car held until the
  // 30-minute window has passed, so an early check does not release it.
  const heldUntil = referenceTime(reference) + PENDING_HOLD_MS;
  if (tx.status === "abandoned" && Date.now() < heldUntil) {
    return {
      status: "pending",
      message: "Payment has not been completed yet. The car stays held for 30 minutes from when the link was created.",
      held_until: new Date(heldUntil).toISOString(),
    };
  }

  const paid = tx.status === "success";
  const dead = tx.status === "failed" || tx.status === "abandoned" || tx.status === "reversed";
  if (!paid && !dead) return { status: "pending", message: `Payment is still in progress (${tx.status}).` };

  const depositNgn = Number(tx.metadata.deposit_ngn);
  if (paid && tx.amountNgn !== depositNgn) {
    return { status: "amount_mismatch", message: "The amount paid does not match the deposit. Not reserved." };
  }

  const sheet = await loadSheet();
  const car = findCar(sheet.cars, tx.metadata.car_id);
  if (!car) return { status: "car_not_found", message: "The car for this payment is no longer in the sheet." };
  const ownsRow = car.reservation_ref === reference;

  if (dead) {
    // Only release the row if it still belongs to this payment.
    if (ownsRow && car.reservation_status !== "available") await writeReservation(sheet, car, "", "available");
    const status = tx.status === "abandoned" ? "abandoned" : "failed";
    return { status, message: `Payment ${tx.status}. The car is available again.`, car_id: car.car_id };
  }

  if (car.reservation_status === "reserved" && !ownsRow) {
    return {
      status: "car_unavailable",
      message: "Payment succeeded, but the car was already reserved under another reference. This deposit needs a refund.",
      car_id: car.car_id,
    };
  }
  if (!(car.reservation_status === "reserved" && ownsRow)) {
    await writeReservation(sheet, car, reference, "reserved");
  }

  const result: ToolResult = { status: "reserved", car_id: car.car_id, title: title(car), deposit_ngn: depositNgn };
  if (car.status === "in_stock") {
    // Counted from the payment time so repeat calls give the same answer.
    const paidAt = tx.paidAt ? Date.parse(tx.paidAt) : NaN;
    const start = Number.isFinite(paidAt) ? paidAt : Date.now();
    result.held_until = new Date(start + sheet.settings.holdHoursInStock * 3_600_000).toISOString();
  }
  return result;
}

// ---------- 4. compare_market_price ----------

export async function compareMarketPrice(input: { car_id: string }): Promise<ToolResult> {
  if (!String(input.car_id ?? "").trim()) return { status: "invalid_input", message: "car_id is required." };

  const [sheet, market] = await Promise.all([loadSheet(), loadMarket()]);
  const car = findCar(sheet.cars, input.car_id);
  if (!car) return { status: "car_not_found", message: `No car with id ${input.car_id}.` };
  return compareMarket(car, quote(car, sheet.settings), market);
}

// ---------- wiring ----------

/** "dozie@gmail.com" -> "d***@gmail.com", anywhere inside the inputs. */
export function maskEmails<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/([^\s@])[^\s@]*(@[^\s@]+\.[^\s@]+)/g, "$1***$2") as T;
  }
  if (Array.isArray(value)) return value.map(maskEmails) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskEmails(v)])) as T;
  }
  return value;
}

/** Runs a tool, logs it to the console and the Logs tab, and turns any error into a status. */
export async function runTool(name: string, input: Record<string, unknown>, fn: () => Promise<ToolResult>) {
  const started = Date.now();
  let result: ToolResult;
  let errorMessage = "";
  try {
    result = await fn();
    if (result.status === "payment_init_failed" || result.status === "invalid_input") errorMessage = result.message ?? "";
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    result =
      err instanceof ServiceUnavailable
        ? { status: "service_unavailable", message: errorMessage }
        : { status: "error", message: "Something went wrong handling this request." };
    console.error(`[tool] ${name} error: ${errorMessage}`);
  }
  const duration = Date.now() - started;

  // Console: no email at all. Logs tab: email masked.
  const { customer_email: _omit, ...loggable } = input;
  console.log(`[tool] ${JSON.stringify({ tool: name, inputs: loggable, outcome: result.status, duration_ms: duration })}`);

  // Persistent log. A failed write must never break the tool call.
  try {
    await appendLog([
      new Date().toISOString(),
      name,
      JSON.stringify(maskEmails(input)),
      result.status,
      typeof result.total_matches === "number" ? result.total_matches : "",
      String(result.reference ?? input.reference ?? ""),
      duration,
      errorMessage,
    ]);
  } catch (err) {
    console.error(`[log] could not write to the Logs tab: ${err instanceof Error ? err.message : err}`);
  }

  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
}

export function registerTools(server: McpServer) {
  // Schemas are deliberately lenient: bad values are answered with a `status`, not a protocol error.
  const numberish = z.union([z.number(), z.string()]).optional();

  server.registerTool(
    "search_inventory",
    {
      description:
        'Search Jeffworldwide cars that are not reserved. Free text is understood, including Pidgin and nicknames ("how far that benz gle"). All inputs are optional and combine with AND. Returns at most 5 cars, cheapest first, with final naira price and deposit. price_basis says what the price covers: to_your_doorstep for pre-orders (delivery included), on_ground_lagos for in-stock cars. Always read total_matches and truncated: when truncated is true there are more cars than shown, so use refine_options (model, year, stock_type with counts) to ask the buyer to narrow down. status: ok | no_match (see unmatched_terms) | summary (no search terms: counts by make and model, not a car list) | service_unavailable.',
      inputSchema: {
        query: z.string().optional().describe('Free text, e.g. "white GLC 43"'),
        make: z.string().optional(),
        model: z.string().optional(),
        year: numberish,
        max_price_ngn: numberish.describe("Maximum price in whole naira"),
        stock_type: z.string().optional().describe("in_stock or pre_order"),
      },
    },
    (input) => runTool("search_inventory", input, () => searchInventory(input)),
  );

  server.registerTool(
    "create_reservation",
    {
      description:
        "Create a Paystack deposit payment link for a car and mark it pending_payment. status: link_created | car_not_found | car_unavailable | payment_init_failed | invalid_input | service_unavailable.",
      inputSchema: {
        car_id: z.string(),
        customer_name: z.string(),
        customer_email: z.string(),
      },
    },
    (input) => runTool("create_reservation", input, () => createReservation(input)),
  );

  server.registerTool(
    "confirm_reservation",
    {
      description:
        "Verify a deposit payment by its reference and reserve the car if it was paid in full. status: reserved | amount_mismatch | failed | abandoned | pending (not paid yet, ask again later) | reference_not_found | car_unavailable | service_unavailable.",
      inputSchema: { reference: z.string() },
    },
    (input) => runTool("confirm_reservation", input, () => confirmReservation(input)),
  );

  server.registerTool(
    "compare_market_price",
    {
      description:
        "Compare one of Jeffworldwide's cars with market asking prices for the same make, model and year (or the nearest year within one, flagged by exact_year_match: false). Returns Jeff's price, the market low and high, and difference_vs_low_ngn (Jeff's price minus the market low). Always pass on the note about asking prices. status: ok | no_comparison | car_not_found | invalid_input | service_unavailable.",
      inputSchema: { car_id: z.string() },
    },
    (input) => runTool("compare_market_price", input, () => compareMarketPrice(input)),
  );
}

// The three MCP tools. Each returns a plain object with a `status` the agent can act on.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceUnavailable } from "./http";
import { initializeTransaction, verifyTransaction } from "./paystack";
import { quote, type Quote } from "./pricing";
import { loadSheet, writeReservation, type Car } from "./sheets";

export type ToolResult = { status: string; message?: string; [key: string]: unknown };

const PENDING_HOLD_MS = 30 * 60 * 1000;
const MAX_RESULTS = 5;

const title = (car: Car) => [car.year, car.make, car.model, car.trim].filter(Boolean).join(" ");

const findCar = (cars: Car[], carId: unknown) =>
  cars.find((c) => c.car_id.toLowerCase() === String(carId ?? "").trim().toLowerCase());

/** "JW-013-1731400000000" -> 1731400000000 (NaN if the reference has no timestamp). */
const referenceTime = (ref: string) => Number(ref.split("-").pop());

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

// ---------- 1. search_inventory ----------

export type SearchInput = {
  query?: string;
  make?: string;
  model?: string;
  year?: number | string;
  max_price_ngn?: number | string;
  stock_type?: string;
};

export async function searchInventory(input: SearchInput): Promise<ToolResult> {
  const { cars, settings } = await loadSheet();

  const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const tokens = lower(input.query).split(/\s+/).filter(Boolean);
  const make = lower(input.make);
  const model = lower(input.model);
  const year = Number(input.year) || null;
  const maxPrice = Number(input.max_price_ngn) || null;
  const stockType = lower(input.stock_type);

  const results = [];
  for (const car of cars) {
    if (car.reservation_status === "reserved") continue;
    if (make && !car.make.toLowerCase().includes(make)) continue;
    if (model && !car.model.toLowerCase().includes(model)) continue;
    if (year && car.year !== year) continue;
    const haystack = `${car.make} ${car.model} ${car.trim} ${car.colour} ${car.year}`.toLowerCase();
    if (!tokens.every((t) => haystack.includes(t))) continue;

    const q = quote(car, settings);
    if (stockType && q.stock_type !== stockType) continue;
    if (maxPrice && q.price_ngn > maxPrice) continue;

    results.push(carView(car, q));
    if (results.length === MAX_RESULTS) break;
  }

  return results.length
    ? { status: "ok", results }
    : { status: "no_match", message: "No available cars match that search.", results: [] };
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

// ---------- wiring ----------

/** Runs a tool, logs it (never the email), and turns any error into a status. */
export async function runTool(name: string, input: Record<string, unknown>, fn: () => Promise<ToolResult>) {
  const started = Date.now();
  let result: ToolResult;
  try {
    result = await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result =
      err instanceof ServiceUnavailable
        ? { status: "service_unavailable", message }
        : { status: "error", message: "Something went wrong handling this request." };
    console.error(`[tool] ${name} error: ${message}`);
  }
  const { customer_email: _omit, ...loggable } = input;
  console.log(
    `[tool] ${JSON.stringify({ tool: name, inputs: loggable, outcome: result.status, duration_ms: Date.now() - started })}`,
  );
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
}

export function registerTools(server: McpServer) {
  // Schemas are deliberately lenient: bad values are answered with a `status`, not a protocol error.
  const numberish = z.union([z.number(), z.string()]).optional();

  server.registerTool(
    "search_inventory",
    {
      description:
        "Search Jeffworldwide's cars that are not yet reserved. All inputs are optional. Returns up to 5 cars with final naira price and deposit. status: ok | no_match | service_unavailable.",
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
}

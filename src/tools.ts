// The three MCP tools. Each returns a plain object with a `status` the agent can act on.

import { sendAlert } from "./alerts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ServiceUnavailable } from "./http";
import { compareMarket } from "./market";
import { initializeTransaction, verifyTransaction, type VerifyResult } from "./paystack";
import { depositNgn, formatMillions, formatNaira, quote } from "./pricing";
import { normalise, searchCars, title, type SearchInput } from "./search";
import {
  appendLog,
  appendRequest,
  loadMarket,
  loadPhotos,
  loadSheet,
  toNumber,
  writeReservation,
  type Car,
  type RowFields,
  type Sheet,
} from "./sheets";

export type ToolResult = { status: string; message?: string; [key: string]: unknown };

const PENDING_HOLD_MS = 30 * 60 * 1000;
const REVIEW_HOLD_MS = 24 * 60 * 60 * 1000;

/** Puts a row back on sale. */
const RELEASED: RowFields = { reservation_ref: "", reservation_status: "available", agreed_price_ngn: "", payment_url: "", review_until: "" };

const referenceLine = (reference: string) => `Ref: ${reference}`;

const findCar = (cars: Car[], carId: unknown) =>
  cars.find((c) => c.car_id.toLowerCase() === String(carId ?? "").trim().toLowerCase());

/** "JW-013-1731400000000" -> 1731400000000 (NaN if the reference has no timestamp). */
const referenceTime = (ref: string) => Number(ref.split("-").pop());

// ---------- 1. search_inventory ----------

export async function searchInventory(input: SearchInput): Promise<ToolResult> {
  // A problem reading the Photos tab must not break the search; cars just come back without photos.
  const photos = loadPhotos().catch((err) => {
    console.warn(`[sheet] could not read the Photos tab: ${err instanceof Error ? err.message : err}`);
    return [];
  });
  const { cars, settings } = await loadSheet();
  return searchCars(cars, settings, input, await photos);
}

// ---------- 2. create_reservation ----------

export type CreateInput = {
  car_id: string;
  customer_name: string;
  customer_email: string;
  agreed_price_ngn?: number | string; // optional negotiated price
};

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
  if (car.reservation_status === "payment_review") {
    return { status: "car_unavailable", message: "This car is on hold while a payment is being reviewed." };
  }

  // A payment started in the last 30 minutes: ask Paystack what became of it before deciding.
  if (car.reservation_status === "pending_payment" && Date.now() - referenceTime(car.reservation_ref) < PENDING_HOLD_MS) {
    const pendingRef = car.reservation_ref;
    const pending = await verifyTransaction(pendingRef);
    const sameBuyer = pending.found && pending.customerEmail.trim().toLowerCase() === email.toLowerCase();

    if (pending.found && pending.status === "success") {
      // Already paid: finish the reservation now.
      const settled = await settlePayment(pendingRef, pending, sheet);
      if (settled.status !== "reserved") return settled;
      // Only the buyer who paid is told so; anyone else just learns the car is gone.
      if (!sameBuyer) return { status: "car_unavailable", message: "This car is already reserved." };
      return { ...settled, status: "already_paid", message: "The deposit for this car has already been paid. The car is reserved." };
    }

    const dead = !pending.found || pending.status === "failed" || pending.status === "reversed";
    if (!dead) {
      // Still unpaid (Paystack calls an unpaid link "abandoned") or in progress.
      if (!sameBuyer) {
        return { status: "car_unavailable", message: "Another buyer has a payment in progress for this car." };
      }
      if (car.payment_url) {
        return {
          status: "link_exists",
          message: "A payment link already exists for this buyer and car. Send the same link again.",
          payment_url: car.payment_url,
          reference: pendingRef,
          reference_line: referenceLine(pendingRef),
          deposit_ngn: pending.amountNgn,
          deposit_display: formatNaira(pending.amountNgn),
        };
      }
      // No link was stored for that payment, so fall through and make a fresh one for the same buyer.
    } else {
      // The earlier payment failed: free the car, then carry on and create a new link.
      await writeReservation(sheet, car, RELEASED);
    }
  }

  // Price and deposit are fixed here; they travel in Paystack metadata, which locks the FX rate.
  const q = quote(car, sheet.settings);

  // A negotiated price must sit between the floor and the quoted price; the deposit follows it.
  let agreed: number | undefined;
  let deposit = q.deposit_ngn;
  if (String(input.agreed_price_ngn ?? "").trim() !== "") {
    agreed = Math.round(toNumber(input.agreed_price_ngn));
    if (!Number.isFinite(agreed)) {
      return { status: "invalid_input", message: "agreed_price_ngn must be a whole naira amount." };
    }
    if (agreed < q.lowest_price_ngn) {
      return {
        status: "price_below_minimum",
        message: `The lowest price for this car is ${q.lowest_price_display}.`,
        lowest_price_ngn: q.lowest_price_ngn,
        lowest_price_display: q.lowest_price_display,
        price_display: q.price_display,
      };
    }
    if (agreed > q.price_ngn) {
      return { status: "invalid_input", message: `agreed_price_ngn is above the quoted price of ${q.price_display}.` };
    }
    deposit = depositNgn(agreed, q.deposit_pct / 100);
  }

  const idPart = car.car_id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^JW-/i, "");
  const reference = `JW-${idPart}-${Date.now()}`;

  const init = await initializeTransaction({
    email,
    amountNgn: deposit,
    reference,
    metadata: {
      car_id: car.car_id,
      customer_name: name,
      price_ngn: q.price_ngn,
      deposit_ngn: deposit,
      stock_type: q.stock_type,
      ...(agreed !== undefined && { agreed_price_ngn: agreed }),
    },
  });
  if (!init.ok) return { status: "payment_init_failed", message: init.message };

  // Record the link and any agreed price on the row, clearing anything left from an earlier reservation.
  await writeReservation(sheet, car, {
    reservation_ref: reference,
    reservation_status: "pending_payment",
    agreed_price_ngn: agreed ?? "",
    payment_url: init.payment_url,
    review_until: "",
  });
  return {
    status: "link_created",
    payment_url: init.payment_url,
    reference,
    reference_line: referenceLine(reference),
    deposit_ngn: deposit,
    deposit_display: formatNaira(deposit),
    price_display: q.price_display,
    ...(agreed !== undefined && { agreed_price_ngn: agreed, agreed_price_display: formatMillions(agreed) }),
  };
}

// ---------- 3. confirm_reservation ----------

export async function confirmReservation(input: { reference?: string; car_id?: string }): Promise<ToolResult> {
  let reference = String(input.reference ?? "").trim();
  const carId = String(input.car_id ?? "").trim();

  // No reference given: use the one recorded on the car's row.
  let sheet: Sheet | undefined;
  if (!reference && carId) {
    sheet = await loadSheet();
    reference = findCar(sheet.cars, carId)?.reservation_ref ?? "";
  }
  if (!reference) {
    return {
      status: "reference_not_found",
      message: carId ? `No payment reference is recorded for ${carId}.` : "Give a payment reference or a car_id.",
    };
  }

  const tx = await verifyTransaction(reference);
  if (!tx.found) return { status: "reference_not_found", message: "Paystack does not know this reference." };
  return settlePayment(reference, tx, sheet);
}

/** Applies a Paystack result to the sheet: reserve the car, release it, or leave it pending. */
async function settlePayment(reference: string, tx: VerifyResult & { found: true }, loaded?: Sheet): Promise<ToolResult> {
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

  const deposit = Number(tx.metadata.deposit_ngn);
  if (paid && tx.amountNgn !== deposit) {
    return { status: "amount_mismatch", message: "The amount paid does not match the deposit. Not reserved." };
  }

  const sheet = loaded ?? (await loadSheet());
  const car = findCar(sheet.cars, tx.metadata.car_id);
  if (!car) return { status: "car_not_found", message: "The car for this payment is no longer in the sheet." };
  const ownsRow = car.reservation_ref === reference;

  if (dead) {
    const status = tx.status === "abandoned" ? "abandoned" : "failed";
    // A car under payment review stays on hold until the review ends, whatever Paystack says.
    if (car.reservation_status === "payment_review") {
      return { status, message: `Payment ${tx.status}. The car stays on hold while the payment is reviewed.`, car_id: car.car_id };
    }
    // Only release the row if it still belongs to this payment.
    if (ownsRow && car.reservation_status !== "available") await writeReservation(sheet, car, RELEASED);
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
    await writeReservation(sheet, car, {
      reservation_ref: reference,
      reservation_status: "reserved",
      payment_url: "",
      review_until: "",
    });
  }

  const result: ToolResult = {
    status: "reserved",
    car_id: car.car_id,
    title: title(car),
    deposit_ngn: deposit,
    deposit_display: formatNaira(deposit),
    reference,
    reference_line: referenceLine(reference),
  };
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

// ---------- 5. request_photos ----------

export async function requestPhotos(input: { car_id: string }): Promise<ToolResult> {
  if (!String(input.car_id ?? "").trim()) return { status: "invalid_input", message: "car_id is required." };

  const { cars } = await loadSheet();
  const car = findCar(cars, input.car_id);
  if (!car) return { status: "car_not_found", message: `No car with id ${input.car_id}.` };

  await appendRequest([new Date().toISOString(), car.car_id, title(car), "photos", "", "", "open", ""]);
  return {
    status: "requested",
    message: "Photo request recorded for the team. Actual photos of this car will be sent when ready.",
    car_id: car.car_id,
    title: title(car),
    request_type: "photos",
  };
}

// ---------- 6. request_callback ----------

export type CallbackInput = { reason: string; car_id?: string; note?: string; reference?: string };

export async function requestCallback(input: CallbackInput): Promise<ToolResult> {
  const reason = String(input.reason ?? "").trim();
  const carId = String(input.car_id ?? "").trim();
  const note = String(input.note ?? "").trim();
  const reference = String(input.reference ?? "").trim();
  if (!reason) return { status: "invalid_input", message: "reason is required." };

  // The car is optional. It is identified by car_id, or failing that by the payment reference
  // ("JW-091-1794755450557" belongs to JW-091). An unknown car is still recorded, so a request is never lost.
  let sheet: Sheet | undefined;
  let car: Car | undefined;
  if (carId || reference) {
    sheet = await loadSheet();
    car =
      (carId ? findCar(sheet.cars, carId) : undefined) ??
      (reference
        ? (sheet.cars.find((c) => c.reservation_ref === reference) ?? findCar(sheet.cars, reference.split("-").slice(0, -1).join("-")))
        : undefined);
  }

  // A payment dispute puts the car on hold for 24 hours so nobody else can take it meanwhile.
  // A car that is already reserved is left as it is: it is off sale anyway.
  let reviewUntil = "";
  if (normalise(reason) === "payment dispute" && sheet && car && car.reservation_status !== "reserved") {
    reviewUntil = new Date(Date.now() + REVIEW_HOLD_MS).toISOString();
    await writeReservation(sheet, car, { reservation_status: "payment_review", review_until: reviewUntil });
  }

  const timestamp = new Date().toISOString();
  const recordedCarId = car?.car_id ?? carId;
  const carTitle = car ? title(car) : "";
  await appendRequest([timestamp, recordedCarId, carTitle, "callback", reason, note, "open", reference]);

  // Alert the team. Best effort: a missing webhook or a failed POST never fails the request.
  await sendAlert({ reason, car_id: recordedCarId, title: carTitle, reference, note, timestamp_utc: timestamp });

  return {
    status: "requested",
    message:
      carId && !car
        ? `Callback request recorded for the team. Note: no car with id ${carId} was found, so it was recorded without a car title.`
        : "Callback request recorded for the team.",
    request_type: "callback",
    reason,
    ...(car && { car_id: car.car_id, title: title(car) }),
    ...(reference && { reference }),
    ...(reviewUntil && { payment_review_until: reviewUntil }),
  };
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
        'Search Jeffworldwide cars that are not reserved. Free text is understood, including Pidgin and nicknames ("how far that benz gle"). All inputs are optional and combine with AND. Returns at most 5 cars, cheapest first, with final naira price and deposit. lowest_price_ngn is the negotiation floor: never agree a price below it. photo_url is a representative photo of the model (not this exact car); when you show it, show photo_credit with it (photo_page_url is its Wikimedia Commons page). These are empty when there is no photo. price_basis says what the price covers: to_your_doorstep for pre-orders (delivery included), on_ground_lagos for in-stock cars. Always read total_matches and truncated: when truncated is true there are more cars than shown, so use refine_options (model, year, stock_type with counts) to ask the buyer to narrow down. status: ok | no_match (see unmatched_terms) | summary (no search terms: counts by make and model, not a car list) | service_unavailable.',
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
        "Create a Paystack deposit payment link for a car and mark it pending_payment. Pass agreed_price_ngn only when a lower price was negotiated: it must be between the car's lowest_price_ngn and its quoted price, and the deposit is then calculated on it. If this buyer already has an unpaid link for the car you get link_exists with the same link; if they have already paid you get already_paid and the car is reserved. Always give the buyer reference_line. status: link_created | link_exists | already_paid | price_below_minimum (see lowest_price_display) | car_not_found | car_unavailable | payment_init_failed | invalid_input | service_unavailable.",
      inputSchema: {
        car_id: z.string(),
        customer_name: z.string(),
        customer_email: z.string(),
        agreed_price_ngn: numberish.describe("Optional negotiated price in whole naira"),
      },
    },
    (input) => runTool("create_reservation", input, () => createReservation(input)),
  );

  server.registerTool(
    "confirm_reservation",
    {
      description:
        "Verify a deposit payment and reserve the car if it was paid in full. Give the payment reference, or just the car_id to use the reference recorded for that car. status: reserved | amount_mismatch | failed | abandoned | pending (not paid yet, ask again later) | reference_not_found | car_unavailable | service_unavailable.",
      inputSchema: { reference: z.string().optional(), car_id: z.string().optional() },
    },
    (input) => runTool("confirm_reservation", input, () => confirmReservation(input)),
  );

  server.registerTool(
    "compare_market_price",
    {
      description:
        "Compare one of Jeffworldwide's cars with market asking prices for the same make, model and year (or the nearest year within one, flagged by exact_year_match: false). Returns Jeff's price, the market low and high, source_name (where the figures come from), condition, and difference_vs_low_ngn (Jeff's price minus the market low). Always pass on the note about asking prices. status: ok | no_comparison | car_not_found | invalid_input | service_unavailable.",
      inputSchema: { car_id: z.string() },
    },
    (input) => runTool("compare_market_price", input, () => compareMarketPrice(input)),
  );

  server.registerTool(
    "request_photos",
    {
      description:
        "Record a buyer's request for actual photos of a specific car, for Jeffworldwide's team to follow up. Use when the buyer wants real photos beyond the representative model photo. status: requested | car_not_found | invalid_input | service_unavailable.",
      inputSchema: { car_id: z.string() },
    },
    (input) => runTool("request_photos", input, () => requestPhotos(input)),
  );

  server.registerTool(
    "request_callback",
    {
      description:
        'Ask Jeffworldwide\'s team to call or message the buyer back. Use when something needs a human: negotiation beyond the lowest price, a viewing, a deposit already paid, a refund, or anything you cannot settle. reason is required (e.g. "negotiation", "viewing", "photos", "deposit paid", "refund", "payment dispute"); car_id, reference (a payment reference) and note are optional (put the detail in note, e.g. the price the buyer wants). Use the exact reason "payment dispute" when a buyer says they paid but the payment is not confirmed: the car is then held for 24 hours while the team checks. status: requested | invalid_input | service_unavailable.',
      inputSchema: {
        reason: z.string(),
        car_id: z.string().optional(),
        reference: z.string().optional(),
        note: z.string().optional(),
      },
    },
    (input) => runTool("request_callback", input, () => requestCallback(input)),
  );
}

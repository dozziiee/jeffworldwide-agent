import { beforeEach, describe, expect, it, vi } from "vitest";
import * as alerts from "./alerts";
import { ServiceUnavailable } from "./http";
import { sourceName } from "./market";
import * as paystack from "./paystack";
import * as sheets from "./sheets";
import { compareMarketPrice, confirmReservation, createReservation, requestCallback, requestPhotos, maskEmails, runTool, searchInventory } from "./tools";

vi.mock("./alerts");
vi.mock("./paystack");
vi.mock("./sheets", async (importOriginal) => ({
  ...(await importOriginal<typeof sheets>()),
  loadSheet: vi.fn(),
  writeReservation: vi.fn(),
  loadMarket: vi.fn(),
  loadPhotos: vi.fn(),
  appendRequest: vi.fn(),
  appendLog: vi.fn(),
}));

const HEADER =
  "car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status, agreed_price_ngn, payment_url, review_until, vin, title_status, owners, accidents_reported".split(
    ", ",
  );

const RELEASED = { reservation_ref: "", reservation_status: "available", agreed_price_ngn: "", payment_url: "", review_until: "" };
const HOUR = 3_600_000;

const settings = { fxRateNgnPerUsd: 1500, marginPct: 0.1, depositPctInStock: 0.3, depositPctPreOrder: 0.5, holdHoursInStock: 48, doorstepDeliveryNgn: 0, maxDiscountNgn: 500_000 };

function sheetWith(reservation: { ref?: string; status?: string; payment_url?: string; review_until?: string } = {}) {
  const rows = [
    HEADER,
    // prettier-ignore
    ["JW-013", "Mercedes-Benz", "GLC 43", "2018", "AMG Coupe 4MATIC", "White", "Red", "45,000", "in_stock", "59,900,000", "Lagos", "", "", "", "", "", "", "", "", "", "Pano roof", reservation.ref ?? "", reservation.status ?? "available", "", reservation.payment_url ?? "", reservation.review_until ?? "", "W1NDEMO18JAJW0013", "Clean", "2", "None reported"],
    ["JW-014", "Toyota", "Camry", "2020", "XSE", "Black", "Black", "30,000", "on_water", "", "", "20000", "1500", "800", "2200", "10000", "Newark", "Lagos", "RoRo", "2026-12-20", "Clean title", "", ""],
    ["JW-015", "Lexus", "RX 350", "2019", "", "Grey", "Tan", "50,000", "in_stock", "45,000,000", "Abuja", "", "", "", "", "", "", "", "", "", "", "JW-015-1", "reserved"],
    ["JW-016", "Honda", "Accord", "2019", "", "Blue", "", "", "in_stock", "not a price", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ];
  return { ...sheets.parseInventory(rows), settings };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith());
  vi.mocked(sheets.loadPhotos).mockResolvedValue([]);
});

describe("search_inventory", () => {
  it("reads the sheet and searches it, skipping reserved and malformed rows", async () => {
    const res = await searchInventory({ query: "white glc 43" });
    expect(res).toMatchObject({ status: "ok", total_matches: 1, returned: 1, truncated: false });
    expect(res.results).toEqual([
      {
        car_id: "JW-013",
        title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC",
        colour: "White",
        interior: "Red",
        mileage: "45,000",
        mileage_display: "45,000 miles",
        stock_type: "in_stock",
        price_basis: "on_ground_lagos",
        price_ngn: 59_900_000,
        price_display: "59.9m",
        lowest_price_ngn: 59_400_000,
        lowest_price_display: "59.4m",
        deposit_pct: 30,
        deposit_ngn: 17_970_000,
        deposit_display: "₦17,970,000",
        location: "Lagos",
        highlights: "Pano roof",
        vin: "W1NDEMO18JAJW0013",
        title_status: "Clean",
        owners: "2",
        accidents_reported: "None reported",
        photo_link: "",
      },
    ]);
    // JW-015 is reserved and JW-016 is malformed, so neither counts.
    expect(await searchInventory({})).toMatchObject({ status: "summary", total_matches: 2 });
  });
});

describe("create_reservation", () => {
  const input = { car_id: "JW-013", customer_name: "Ada", customer_email: "ada@example.com" };

  it("creates a link and marks the row pending_payment", async () => {
    vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: true, payment_url: "https://pay/abc" });
    const res = await createReservation(input);
    expect(res).toMatchObject({ status: "link_created", payment_url: "https://pay/abc", deposit_ngn: 17_970_000, deposit_display: "₦17,970,000", price_display: "59.9m" });
    expect(res.reference).toMatch(/^JW-013-\d{13}$/);
    expect(vi.mocked(paystack.initializeTransaction).mock.calls[0][0]).toMatchObject({
      email: "ada@example.com",
      amountNgn: 17_970_000,
      metadata: { car_id: "JW-013", customer_name: "Ada", price_ngn: 59_900_000, deposit_ngn: 17_970_000, stock_type: "in_stock" },
    });
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ car_id: "JW-013" }), {
      reservation_ref: res.reference,
      reservation_status: "pending_payment",
      agreed_price_ngn: "",
      payment_url: "https://pay/abc",
      review_until: "",
    });
    expect(res.reference_line).toBe(`Ref: ${res.reference}`);
    expect(res).not.toHaveProperty("agreed_price_ngn");
    expect(vi.mocked(paystack.initializeTransaction).mock.calls[0][0].metadata).not.toHaveProperty("agreed_price_ngn");
  });

  it("returns car_not_found, and car_unavailable for reserved cars", async () => {
    expect((await createReservation({ ...input, car_id: "nope" })).status).toBe("car_not_found");
    expect(await createReservation({ ...input, car_id: "JW-015" })).toEqual({ status: "car_unavailable", message: "This car is already reserved." });
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it("lets a new payment through once a pending one is older than 30 minutes", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref: `JW-013-${Date.now() - 31 * 60_000}`, status: "pending_payment" }));
    vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: true, payment_url: "https://pay/abc" });
    expect((await createReservation(input)).status).toBe("link_created");
    expect(paystack.verifyTransaction).not.toHaveBeenCalled(); // too old to matter: no need to ask Paystack
  });

  it("leaves the row unchanged when Paystack rejects", async () => {
    vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: false, message: "Invalid key" });
    expect(await createReservation(input)).toEqual({ status: "payment_init_failed", message: "Invalid key" });
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });
});

describe("create_reservation with an agreed price", () => {
  const input = { car_id: "JW-013", customer_name: "Ada", customer_email: "ada@example.com" };
  beforeEach(() => vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: true, payment_url: "https://pay/abc" }));

  it("valid agreed price: the deposit is calculated on it, and it is recorded", async () => {
    // Quoted 59.9m, floor 59.4m, in-stock deposit 30%.
    const res = await createReservation({ ...input, agreed_price_ngn: 59_650_000 });
    expect(res).toMatchObject({
      status: "link_created",
      price_display: "59.9m",
      agreed_price_ngn: 59_650_000,
      agreed_price_display: "59.65m",
      deposit_ngn: 17_895_000,
      deposit_display: "₦17,895,000",
    });
    expect(vi.mocked(paystack.initializeTransaction).mock.calls[0][0]).toMatchObject({
      amountNgn: 17_895_000,
      metadata: { price_ngn: 59_900_000, agreed_price_ngn: 59_650_000, deposit_ngn: 17_895_000 },
    });
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ car_id: "JW-013" }), expect.objectContaining({ reservation_status: "pending_payment", agreed_price_ngn: 59_650_000 }));
  });

  it("accepts the floor and the quoted price exactly, and amounts typed with commas", async () => {
    expect(await createReservation({ ...input, agreed_price_ngn: 59_400_000 })).toMatchObject({ status: "link_created", deposit_ngn: 17_820_000 });
    expect(await createReservation({ ...input, agreed_price_ngn: "59,900,000" })).toMatchObject({ status: "link_created", deposit_ngn: 17_970_000, agreed_price_display: "59.9m" });
  });

  it("below the floor: price_below_minimum, no payment link, row untouched", async () => {
    expect(await createReservation({ ...input, agreed_price_ngn: 59_399_999 })).toEqual({
      status: "price_below_minimum",
      message: "The lowest price for this car is 59.4m.",
      lowest_price_ngn: 59_400_000,
      lowest_price_display: "59.4m",
      price_display: "59.9m",
    });
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it("above the quoted price or not a number: invalid_input", async () => {
    expect((await createReservation({ ...input, agreed_price_ngn: 60_000_000 })).status).toBe("invalid_input");
    expect((await createReservation({ ...input, agreed_price_ngn: "cheap" })).status).toBe("invalid_input");
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });
});

describe("request_callback", () => {
  const rows = () => vi.mocked(sheets.appendRequest).mock.calls.map(([row]) => row.slice(1));

  it("records a callback for a car, with reason and note", async () => {
    const res = await requestCallback({ reason: "negotiation", car_id: "jw-013", note: "Buyer wants 58m" });
    expect(res).toMatchObject({ status: "requested", request_type: "callback", reason: "negotiation", car_id: "JW-013", title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC" });
    expect(rows()).toEqual([["JW-013", "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC", "callback", "negotiation", "Buyer wants 58m", "open", ""]]);
    expect(vi.mocked(sheets.appendRequest).mock.calls[0][0][0]).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("works without a car or a note, and does not read the inventory", async () => {
    expect(await requestCallback({ reason: "refund" })).toMatchObject({ status: "requested", reason: "refund" });
    expect(rows()).toEqual([["", "", "callback", "refund", "", "open", ""]]);
    expect(sheets.loadSheet).not.toHaveBeenCalled();
  });

  it("still records the request when the car_id is unknown", async () => {
    const res = await requestCallback({ reason: "viewing", car_id: "JW-999" });
    expect(res.status).toBe("requested");
    expect(res.message).toContain("JW-999");
    expect(rows()).toEqual([["JW-999", "", "callback", "viewing", "", "open", ""]]);
  });

  it("requires a reason", async () => {
    expect((await requestCallback({ reason: "  " })).status).toBe("invalid_input");
    expect(sheets.appendRequest).not.toHaveBeenCalled();
  });
});

describe("create_reservation when a payment is already pending", () => {
  const input = { car_id: "JW-013", customer_name: "Ada", customer_email: "Ada@Example.com" };
  const pendingRef = `JW-013-${Date.now() - 5 * 60_000}`; // started 5 minutes ago
  const pendingSheet = (payment_url = "https://checkout.paystack.com/old") => sheetWith({ ref: pendingRef, status: "pending_payment", payment_url });
  const paystackSays = (status: string, customerEmail = "ada@example.com", amountNgn = 17_970_000) =>
    vi.mocked(paystack.verifyTransaction).mockResolvedValue({
      found: true,
      status,
      amountNgn,
      paidAt: status === "success" ? "2026-11-12T10:00:00.000Z" : null,
      customerEmail,
      metadata: { car_id: "JW-013", deposit_ngn: 17_970_000 },
    });

  beforeEach(() => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(pendingSheet());
    vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: true, payment_url: "https://checkout.paystack.com/new" });
  });

  it("checks the pending reference with Paystack first", async () => {
    paystackSays("abandoned");
    await createReservation(input);
    expect(paystack.verifyTransaction).toHaveBeenCalledWith(pendingRef);
  });

  it("paid by this buyer: finalises the reservation and returns already_paid", async () => {
    paystackSays("success");
    expect(await createReservation(input)).toEqual({
      status: "already_paid",
      message: "The deposit for this car has already been paid. The car is reserved.",
      car_id: "JW-013",
      title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC",
      deposit_ngn: 17_970_000,
      deposit_display: "₦17,970,000",
      reference: pendingRef,
      reference_line: `Ref: ${pendingRef}`,
      held_until: "2026-11-14T10:00:00.000Z",
    });
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), { reservation_ref: pendingRef, reservation_status: "reserved", payment_url: "", review_until: "" });
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it("paid by a different buyer: still finalises, but only says the car is reserved", async () => {
    paystackSays("success", "someone.else@example.com");
    expect(await createReservation(input)).toEqual({ status: "car_unavailable", message: "This car is already reserved." });
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ reservation_status: "reserved" }));
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it("paid, but the amount is wrong: reports amount_mismatch and does not reserve", async () => {
    paystackSays("success", "ada@example.com", 1_000);
    expect((await createReservation(input)).status).toBe("amount_mismatch");
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it.each(["abandoned", "ongoing"])("unpaid (%s) and the same email: link_exists with the same link and reference", async (status) => {
    paystackSays(status);
    expect(await createReservation(input)).toEqual({
      status: "link_exists",
      message: "A payment link already exists for this buyer and car. Send the same link again.",
      payment_url: "https://checkout.paystack.com/old",
      reference: pendingRef,
      reference_line: `Ref: ${pendingRef}`,
      deposit_ngn: 17_970_000,
      deposit_display: "₦17,970,000",
    });
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it("unpaid and a different email: car_unavailable", async () => {
    paystackSays("abandoned", "someone.else@example.com");
    expect(await createReservation(input)).toEqual({ status: "car_unavailable", message: "Another buyer has a payment in progress for this car." });
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it("failed: frees the car, then creates a new link as normal", async () => {
    paystackSays("failed", "someone.else@example.com");
    const res = await createReservation(input);
    expect(res).toMatchObject({ status: "link_created", payment_url: "https://checkout.paystack.com/new" });
    expect(res.reference).not.toBe(pendingRef);
    const writes = vi.mocked(sheets.writeReservation).mock.calls.map(([, , fields]) => fields);
    expect(writes).toEqual([RELEASED, expect.objectContaining({ reservation_ref: res.reference, reservation_status: "pending_payment" })]);
  });

  it("reference unknown to Paystack: treated as dead, new link created", async () => {
    vi.mocked(paystack.verifyTransaction).mockResolvedValue({ found: false });
    expect((await createReservation(input)).status).toBe("link_created");
    expect(vi.mocked(sheets.writeReservation).mock.calls[0][2]).toEqual(RELEASED);
  });

  it("same buyer but no link stored on the row: makes a fresh link", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(pendingSheet(""));
    paystackSays("abandoned");
    expect(await createReservation(input)).toMatchObject({ status: "link_created", payment_url: "https://checkout.paystack.com/new" });
  });
});

describe("payment review hold", () => {
  const input = { car_id: "JW-013", customer_name: "Ada", customer_email: "ada@example.com" };
  const inReview = (hours: number) => sheetWith({ ref: "JW-013-1700000000000", status: "payment_review", review_until: new Date(Date.now() + hours * HOUR).toISOString() });

  it("an active review is treated like reserved in search and create_reservation", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(inReview(5));
    expect(await searchInventory({ query: "glc" })).toMatchObject({ status: "no_match" });
    expect(await searchInventory({})).toMatchObject({ status: "summary", total_matches: 1 });
    expect(await createReservation(input)).toEqual({ status: "car_unavailable", message: "This car is on hold while a payment is being reviewed." });
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it("an expired review no longer holds the car", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(inReview(-1));
    vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: true, payment_url: "https://pay/abc" });
    expect(await searchInventory({ query: "glc" })).toMatchObject({ status: "ok", total_matches: 1 });
    expect((await createReservation(input)).status).toBe("link_created");
  });

  it("a review with no end time does not hold the car", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ status: "payment_review" }));
    expect(await searchInventory({ query: "glc" })).toMatchObject({ status: "ok", total_matches: 1 });
  });

  it("confirm_reservation does not release a car under review, but does reserve it once paid", async () => {
    const ref = "JW-013-1700000000000";
    const tx = (status: string) =>
      vi.mocked(paystack.verifyTransaction).mockResolvedValue({ found: true, status, amountNgn: 17_970_000, paidAt: null, customerEmail: "ada@example.com", metadata: { car_id: "JW-013", deposit_ngn: 17_970_000 } });
    vi.mocked(sheets.loadSheet).mockResolvedValue(inReview(5));

    tx("abandoned");
    const res = await confirmReservation({ reference: ref });
    expect(res.status).toBe("abandoned");
    expect(res.message).toContain("stays on hold");
    expect(sheets.writeReservation).not.toHaveBeenCalled();

    tx("success");
    expect((await confirmReservation({ reference: ref })).status).toBe("reserved");
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), { reservation_ref: ref, reservation_status: "reserved", payment_url: "", review_until: "" });
  });
});

describe("confirm_reservation by car_id", () => {
  const ref = "JW-013-1700000000000";
  beforeEach(() => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref, status: "pending_payment" }));
    vi.mocked(paystack.verifyTransaction).mockResolvedValue({ found: true, status: "success", amountNgn: 17_970_000, paidAt: "2026-11-12T10:00:00.000Z", customerEmail: "ada@example.com", metadata: { car_id: "JW-013", deposit_ngn: 17_970_000 } });
  });

  it("uses the reference recorded on the car's row", async () => {
    expect(await confirmReservation({ car_id: "jw-013" })).toMatchObject({ status: "reserved", car_id: "JW-013", reference: ref, reference_line: `Ref: ${ref}` });
    expect(paystack.verifyTransaction).toHaveBeenCalledWith(ref);
    expect(sheets.loadSheet).toHaveBeenCalledTimes(1); // the sheet is read once, not twice
  });

  it("prefers an explicit reference over the car_id", async () => {
    await confirmReservation({ reference: "JW-013-1700000000999", car_id: "JW-014" });
    expect(paystack.verifyTransaction).toHaveBeenCalledWith("JW-013-1700000000999");
  });

  it("returns reference_not_found when neither is usable", async () => {
    for (const input of [{}, { reference: "  " }, { car_id: "JW-999" }, { car_id: "JW-014" }]) {
      expect((await confirmReservation(input)).status).toBe("reference_not_found");
    }
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    vi.mocked(paystack.verifyTransaction).mockResolvedValue({ found: false });
    expect((await confirmReservation({ car_id: "JW-013" })).status).toBe("reference_not_found");
  });
});

describe("request_callback: reference, payment disputes and the team alert", () => {
  const ref = "JW-013-1700000000000";
  const lastRow = () => vi.mocked(sheets.appendRequest).mock.calls.at(-1)![0];
  const reviewWrite = { reservation_status: "payment_review", review_until: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) };

  it("records the reference and identifies the car from it", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref, status: "pending_payment" }));
    const res = await requestCallback({ reason: "deposit paid", reference: ref });
    expect(res).toMatchObject({ status: "requested", car_id: "JW-013", reference: ref });
    expect(lastRow().slice(1)).toEqual(["JW-013", "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC", "callback", "deposit paid", "", "open", ref]);
    expect(sheets.writeReservation).not.toHaveBeenCalled(); // not a dispute, so no hold
  });

  it("identifies the car from the reference's car id when the row no longer carries it", async () => {
    const res = await requestCallback({ reason: "refund", reference: "JW-014-1700000000000" });
    expect(res).toMatchObject({ car_id: "JW-014", title: "2020 Toyota Camry XSE" });
  });

  it.each([
    ["car_id", { car_id: "JW-013" }],
    ["reference", { reference: ref }],
  ])("payment dispute with a %s: holds the car for 24 hours", async (_label, extra) => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref, status: "pending_payment" }));
    const before = Date.now();
    const res = await requestCallback({ reason: "Payment Dispute", note: "Buyer says they paid", ...extra });
    expect(res.status).toBe("requested");
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ car_id: "JW-013" }), reviewWrite);
    const until = Date.parse(res.payment_review_until as string);
    expect(until).toBeGreaterThanOrEqual(before + 24 * HOUR);
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
  });

  it("payment dispute with no identifiable car: recorded, nothing held", async () => {
    expect((await requestCallback({ reason: "payment dispute", note: "no details" })).status).toBe("requested");
    expect((await requestCallback({ reason: "payment dispute", car_id: "JW-999" })).status).toBe("requested");
    expect(sheets.writeReservation).not.toHaveBeenCalled();
    expect(sheets.appendRequest).toHaveBeenCalledTimes(2);
  });

  it("payment dispute on a car that is already reserved: leaves the reservation alone", async () => {
    const res = await requestCallback({ reason: "payment dispute", car_id: "JW-015" });
    expect(res.status).toBe("requested");
    expect(res).not.toHaveProperty("payment_review_until");
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it("other reasons never hold the car", async () => {
    await requestCallback({ reason: "negotiation", car_id: "JW-013" });
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it("alerts the team after logging, with the request details", async () => {
    const order: string[] = [];
    vi.mocked(sheets.appendRequest).mockImplementation(async () => void order.push("logged"));
    vi.mocked(alerts.sendAlert).mockImplementation(async () => (order.push("alerted"), true));
    await requestCallback({ reason: "viewing", car_id: "JW-013", reference: ref, note: "Saturday 2pm" });
    expect(order).toEqual(["logged", "alerted"]);
    expect(alerts.sendAlert).toHaveBeenCalledWith({
      reason: "viewing",
      car_id: "JW-013",
      title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC",
      reference: ref,
      note: "Saturday 2pm",
      timestamp_utc: lastRow()[0],
    });
  });

  it("still returns requested when the alert fails", async () => {
    vi.mocked(alerts.sendAlert).mockResolvedValue(false);
    expect((await requestCallback({ reason: "refund" })).status).toBe("requested");
  });
});

describe("confirm_reservation", () => {
  const ref = "JW-013-1700000000000";
  const metadata = { car_id: "JW-013", deposit_ngn: 17_970_000 };
  const tx = (status: string, amountNgn = 17_970_000) =>
    vi.mocked(paystack.verifyTransaction).mockResolvedValue({ found: true, status, amountNgn, paidAt: "2026-11-12T10:00:00.000Z", customerEmail: "ada@example.com", metadata });

  beforeEach(() => vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref, status: "pending_payment" })));

  it("reserves on a full payment and returns held_until for in-stock cars", async () => {
    tx("success");
    expect(await confirmReservation({ reference: ref })).toEqual({
      status: "reserved",
      car_id: "JW-013",
      title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC",
      deposit_ngn: 17_970_000,
      deposit_display: "₦17,970,000",
      reference: ref,
      reference_line: "Ref: JW-013-1700000000000",
      held_until: "2026-11-14T10:00:00.000Z",
    });
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), { reservation_ref: ref, reservation_status: "reserved", payment_url: "", review_until: "" });
  });

  it("does not reserve on an amount mismatch", async () => {
    tx("success", 1_000);
    expect((await confirmReservation({ reference: ref })).status).toBe("amount_mismatch");
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it.each(["failed", "abandoned"])("%s: sets the row back to available", async (status) => {
    tx(status);
    expect((await confirmReservation({ reference: ref })).status).toBe(status);
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), RELEASED);
  });

  it("abandoned within 30 minutes of the link: pending, car stays held", async () => {
    const fresh = `JW-013-${Date.now() - 5 * 60_000}`;
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref: fresh, status: "pending_payment" }));
    tx("abandoned");
    const res = await confirmReservation({ reference: fresh });
    expect(res.status).toBe("pending");
    expect(Date.parse(res.held_until as string)).toBeGreaterThan(Date.now());
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it("failed within 30 minutes still releases the car", async () => {
    const fresh = `JW-013-${Date.now() - 5 * 60_000}`;
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref: fresh, status: "pending_payment" }));
    tx("failed");
    expect((await confirmReservation({ reference: fresh })).status).toBe("failed");
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), RELEASED);
  });

  it("does not release a row that now belongs to a newer payment", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref: "JW-013-1800000000000", status: "pending_payment" }));
    tx("abandoned");
    expect((await confirmReservation({ reference: ref })).status).toBe("abandoned");
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it("maps in-progress and unknown references", async () => {
    tx("ongoing");
    expect((await confirmReservation({ reference: ref })).status).toBe("pending");
    vi.mocked(paystack.verifyTransaction).mockResolvedValue({ found: false });
    expect((await confirmReservation({ reference: ref })).status).toBe("reference_not_found");
  });
});

describe("compare_market_price", () => {
  const MARKET = [
    sheets.MARKET_HEADERS,
    ["Mercedes-Benz", "GLC 43", 2018, "foreign_used", "52,000,000", "68,000,000", 9, "https://jiji.ng/glc43-2018", "2026-11-10"],
    ["Mercedes-Benz", "GLC 43", 2018, "mixed", "45,000,000", "58,000,000", 4, "https://www.cars45.com/listing/glc43-2018", "2026-11-12"],
    ["Toyota", "Camry", 2019, "foreign_used", "30,000,000", "36,000,000", 12, "https://jiji.ng/camry-2019", "2026-11-11"],
    ["Toyota", "Camry", 2021, "Foreign used", "40,000,000", "47,000,000", 6, "https://jiji.ng/camry-2021", "2026-11-11"],
    ["Toyota", "Camry", 2016, "Foreign used", "18,000,000", "22,000,000", 20, "https://jiji.ng/camry-2016", "2026-11-11"],
    ["Honda", "Accord", "", "Foreign used", "x", "y", 1, "", ""], // malformed, skipped
  ];
  beforeEach(() => vi.mocked(sheets.loadMarket).mockResolvedValue(sheets.parseMarket(MARKET)));

  it("exact year match: combines the rows for that year", async () => {
    expect(await compareMarketPrice({ car_id: "JW-013" })).toEqual({
      status: "ok",
      car_id: "JW-013",
      title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC",
      jeff_price_ngn: 59_900_000,
      jeff_price_display: "59.9m",
      price_basis: "on_ground_lagos",
      market_low_ngn: 45_000_000,
      market_high_ngn: 68_000_000,
      market_low_display: "45m",
      market_high_display: "68m",
      listings_count: 13,
      source_name: "Jiji, Cars45",
      condition: "foreign_used, mixed",
      year_matched: 2018,
      exact_year_match: true,
      collected_on: "2026-11-12",
      source_url: "https://www.cars45.com/listing/glc43-2018",
      difference_vs_low_ngn: 14_900_000,
      note: "These are asking prices for cars on ground in Nigeria, usually negotiable.",
    });
  });

  it("no row for the year: uses the nearest year within one and says so", async () => {
    // JW-014 is a 2020 Camry pre-order at 56.99m; Market has 2019 and 2021 (and 2016, too far).
    const res = await compareMarketPrice({ car_id: "jw-014" });
    expect(res).toMatchObject({
      status: "ok",
      car_id: "JW-014",
      price_basis: "to_your_doorstep",
      jeff_price_ngn: 56_990_000,
      year_matched: 2019,
      exact_year_match: false,
      market_low_ngn: 30_000_000,
      market_high_ngn: 36_000_000,
      listings_count: 12,
      source_name: "Jiji",
      condition: "foreign_used",
      difference_vs_low_ngn: 26_990_000,
    });
    expect(res.message).toContain("2019");
  });

  it("no comparable rows: no_comparison", async () => {
    vi.mocked(sheets.loadMarket).mockResolvedValue(sheets.parseMarket(MARKET.filter((r) => r[2] !== 2019 && r[2] !== 2021)));
    expect(await compareMarketPrice({ car_id: "JW-014" })).toMatchObject({ status: "no_comparison", car_id: "JW-014", jeff_price_display: "56.99m" });
    vi.mocked(sheets.loadMarket).mockResolvedValue([]);
    expect((await compareMarketPrice({ car_id: "JW-013" })).status).toBe("no_comparison");
  });

  it("unknown car_id: car_not_found", async () => {
    expect(await compareMarketPrice({ car_id: "JW-999" })).toEqual({ status: "car_not_found", message: "No car with id JW-999." });
  });
});

describe("market source names", () => {
  it("names the known sources and falls back to the domain", () => {
    expect(sourceName("https://jiji.ng/cars?query=highlander")).toBe("Jiji");
    expect(sourceName("https://www.cars45.com/listing/x")).toBe("Cars45");
    expect(sourceName("https://autochek.africa/ng/cars")).toBe("Autochek");
    expect(sourceName("https://afrotools.com/car-prices")).toBe("Afrotools");
    expect(sourceName("https://www.example.ng/cars")).toBe("example.ng");
    expect(sourceName("not a url")).toBe("");
  });
});

describe("request_photos", () => {
  it("records the request in the Requests tab", async () => {
    const res = await requestPhotos({ car_id: "jw-013" });
    expect(res).toMatchObject({
      status: "requested",
      car_id: "JW-013",
      title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC",
      request_type: "photos",
    });
    const [row] = vi.mocked(sheets.appendRequest).mock.calls[0];
    expect(row[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(row.slice(1)).toEqual(["JW-013", "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC", "photos", "", "", "open", ""]);
  });

  it("unknown car_id: car_not_found, nothing recorded", async () => {
    expect(await requestPhotos({ car_id: "JW-999" })).toEqual({ status: "car_not_found", message: "No car with id JW-999." });
    expect(sheets.appendRequest).not.toHaveBeenCalled();
  });
});

describe("search_inventory photos", () => {
  it("still searches when the Photos tab cannot be read", async () => {
    vi.mocked(sheets.loadPhotos).mockRejectedValue(new Error("no Photos tab"));
    const res = await searchInventory({ query: "glc" });
    expect(res).toMatchObject({ status: "ok", total_matches: 1 });
    expect((res.results as any[])[0]).toMatchObject({ car_id: "JW-013", photo_link: "" });
  });
});

describe("search_inventory photo links", () => {
  it("links to the car page on the server's public address when the model has a photo", async () => {
    vi.mocked(sheets.loadPhotos).mockResolvedValue([
      { make: "Mercedes-Benz", model: "GLC 43", photo_url: "https://upload.wikimedia.org/x/1280px-glc.jpg", page_url: "https://commons.wikimedia.org/wiki/File:glc.jpg", author: "Jane Doe", licence: "CC BY-SA 4.0" },
    ]);
    const res = await searchInventory({ query: "glc" }, "https://jeff.example.com");
    const [car] = res.results as any[];
    expect(car.photo_link).toBe("https://jeff.example.com/car/JW-013");
    for (const removed of ["photo_url", "photo_page_url", "photo_credit"]) expect(car).not.toHaveProperty(removed);
    expect(JSON.stringify(res)).not.toContain("wikimedia");
  });
});

describe("runTool", () => {
  it("turns outages into service_unavailable and never logs the email", async () => {
    const out = await runTool("create_reservation", { car_id: "JW-013", customer_email: "ada@example.com" }, async () => {
      throw new ServiceUnavailable("Paystack is unreachable or timed out");
    });
    expect(out.structuredContent).toEqual({ status: "service_unavailable", message: "Paystack is unreachable or timed out" });
    const logged = vi.mocked(console.log).mock.calls.flat().join(" ") + vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain('"outcome":"service_unavailable"');
    expect(logged).not.toContain("ada@example.com");
  });

  it("hides unexpected error details from the client", async () => {
    const out = await runTool("search_inventory", {}, async () => {
      throw new TypeError("boom");
    });
    expect(out.structuredContent.status).toBe("error");
    expect(out.structuredContent.message).not.toContain("boom");
  });

  it("writes each call to the Logs tab with the email masked", async () => {
    await runTool("create_reservation", { car_id: "JW-013", customer_name: "Ada", customer_email: "dozie@gmail.com" }, async () => ({
      status: "link_created",
      reference: "JW-013-1",
    }));
    await runTool("search_inventory", { query: "honda" }, async () => ({ status: "ok", total_matches: 4 }));
    const [first, second] = vi.mocked(sheets.appendLog).mock.calls.map(([row]) => row);
    expect(first[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(first.slice(1, 6)).toEqual([
      "create_reservation",
      '{"car_id":"JW-013","customer_name":"Ada","customer_email":"d***@gmail.com"}',
      "link_created",
      "",
      "JW-013-1",
    ]);
    expect(typeof first[6]).toBe("number");
    expect(second.slice(1, 6)).toEqual(["search_inventory", '{"query":"honda"}', "ok", 4, ""]);
    expect(JSON.stringify([first, second])).not.toContain("dozie@");
  });

  it("records the error message, and the reference being confirmed", async () => {
    await runTool("confirm_reservation", { reference: "JW-013-9" }, async () => {
      throw new ServiceUnavailable("Paystack is unreachable or timed out");
    });
    const [row] = vi.mocked(sheets.appendLog).mock.calls[0];
    expect(row.slice(3)).toEqual(["service_unavailable", "", "JW-013-9", expect.any(Number), "Paystack is unreachable or timed out"]);
  });

  it("still returns the tool result when the Logs tab write fails", async () => {
    vi.mocked(sheets.appendLog).mockRejectedValue(new Error("sheet down"));
    const out = await runTool("search_inventory", { query: "honda" }, async () => ({ status: "ok", total_matches: 1 }));
    expect(out.structuredContent).toEqual({ status: "ok", total_matches: 1 });
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("sheet down");
  });

  it("masks emails anywhere in the inputs", () => {
    expect(maskEmails({ customer_email: "dozie@gmail.com", query: "send to a.b@jeff.co.uk pls", n: 5 })).toEqual({
      customer_email: "d***@gmail.com",
      query: "send to a***@jeff.co.uk pls",
      n: 5,
    });
  });
});

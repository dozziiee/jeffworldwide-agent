import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailable } from "./http";
import * as paystack from "./paystack";
import * as sheets from "./sheets";
import { confirmReservation, createReservation, maskEmails, runTool, searchInventory } from "./tools";

vi.mock("./paystack");
vi.mock("./sheets", async (importOriginal) => ({
  ...(await importOriginal<typeof sheets>()),
  loadSheet: vi.fn(),
  writeReservation: vi.fn(),
  appendLog: vi.fn(),
}));

const HEADER =
  "car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status".split(
    ", ",
  );

const settings = { fxRateNgnPerUsd: 1500, marginPct: 0.1, depositPctInStock: 0.3, depositPctPreOrder: 0.5, holdHoursInStock: 48 };

function sheetWith(reservation: { ref?: string; status?: string } = {}) {
  const rows = [
    HEADER,
    // prettier-ignore
    ["JW-013", "Mercedes-Benz", "GLC 43", "2018", "AMG Coupe 4MATIC", "White", "Red", "45,000", "in_stock", "59,900,000", "Lagos", "", "", "", "", "", "", "", "", "", "Pano roof", reservation.ref ?? "", reservation.status ?? "available"],
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
        stock_type: "in_stock",
        price_ngn: 59_900_000,
        price_display: "59.9m",
        deposit_pct: 30,
        deposit_ngn: 17_970_000,
        deposit_display: "17.97m",
        location: "Lagos",
        highlights: "Pano roof",
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
    expect(res).toMatchObject({ status: "link_created", payment_url: "https://pay/abc", deposit_ngn: 17_970_000, deposit_display: "17.97m", price_display: "59.9m" });
    expect(res.reference).toMatch(/^JW-013-\d{13}$/);
    expect(vi.mocked(paystack.initializeTransaction).mock.calls[0][0]).toMatchObject({
      email: "ada@example.com",
      amountNgn: 17_970_000,
      metadata: { car_id: "JW-013", customer_name: "Ada", price_ngn: 59_900_000, deposit_ngn: 17_970_000, stock_type: "in_stock" },
    });
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ car_id: "JW-013" }), res.reference, "pending_payment");
  });

  it("returns car_not_found, and car_unavailable for reserved or freshly pending cars", async () => {
    expect((await createReservation({ ...input, car_id: "nope" })).status).toBe("car_not_found");
    expect((await createReservation({ ...input, car_id: "JW-015" })).status).toBe("car_unavailable");
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref: `JW-013-${Date.now() - 60_000}`, status: "pending_payment" }));
    expect((await createReservation(input)).status).toBe("car_unavailable");
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it("lets a new payment through once a pending one is older than 30 minutes", async () => {
    vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref: `JW-013-${Date.now() - 31 * 60_000}`, status: "pending_payment" }));
    vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: true, payment_url: "https://pay/abc" });
    expect((await createReservation(input)).status).toBe("link_created");
  });

  it("leaves the row unchanged when Paystack rejects", async () => {
    vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: false, message: "Invalid key" });
    expect(await createReservation(input)).toEqual({ status: "payment_init_failed", message: "Invalid key" });
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });
});

describe("confirm_reservation", () => {
  const ref = "JW-013-1700000000000";
  const metadata = { car_id: "JW-013", deposit_ngn: 17_970_000 };
  const tx = (status: string, amountNgn = 17_970_000) =>
    vi.mocked(paystack.verifyTransaction).mockResolvedValue({ found: true, status, amountNgn, paidAt: "2026-11-12T10:00:00.000Z", metadata });

  beforeEach(() => vi.mocked(sheets.loadSheet).mockResolvedValue(sheetWith({ ref, status: "pending_payment" })));

  it("reserves on a full payment and returns held_until for in-stock cars", async () => {
    tx("success");
    expect(await confirmReservation({ reference: ref })).toEqual({
      status: "reserved",
      car_id: "JW-013",
      title: "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC",
      deposit_ngn: 17_970_000,
      held_until: "2026-11-14T10:00:00.000Z",
    });
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), ref, "reserved");
  });

  it("does not reserve on an amount mismatch", async () => {
    tx("success", 1_000);
    expect((await confirmReservation({ reference: ref })).status).toBe("amount_mismatch");
    expect(sheets.writeReservation).not.toHaveBeenCalled();
  });

  it.each(["failed", "abandoned"])("%s: sets the row back to available", async (status) => {
    tx(status);
    expect((await confirmReservation({ reference: ref })).status).toBe(status);
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), "", "available");
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
    expect(sheets.writeReservation).toHaveBeenCalledWith(expect.anything(), expect.anything(), "", "available");
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

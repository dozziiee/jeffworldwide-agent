import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import * as sheets from "./sheets";

vi.mock("./sheets", async (importOriginal) => ({
  ...(await importOriginal<typeof sheets>()),
  loadSheet: vi.fn(),
  loadPhotos: vi.fn(),
}));

const HEADER =
  "car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status, agreed_price_ngn, payment_url, review_until, vin, title_status, owners, accidents_reported".split(
    ", ",
  );
const settings = { fxRateNgnPerUsd: 1500, marginPct: 0.1, depositPctInStock: 0.3, depositPctPreOrder: 0.5, holdHoursInStock: 48, doorstepDeliveryNgn: 0, maxDiscountNgn: 500_000 };
const ROWS = [
  HEADER,
  ["JW-065", "Toyota", "Highlander", "2021", "XSE AWD", "Blue", "Black", "42800", "in_stock", "42,900,000", "Lagos", "", "", "", "", "", "", "", "", "", "", "JW-065-1794755450557", "reserved", "42400000", "", "", "5TDGZRBH9MSJW0065", "Clean", "2", "None reported"],
];
const photo = { make: "Toyota", model: "Highlander", photo_url: "https://upload.wikimedia.org/x/1280px-Highlander.jpg", page_url: "https://commons.wikimedia.org/wiki/File:Highlander.jpg", author: "Kevauto", licence: "CC BY-SA 4.0" };

let base: string;
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(sheets.loadSheet).mockResolvedValue({ ...sheets.parseInventory(ROWS), settings });
  vi.mocked(sheets.loadPhotos).mockResolvedValue([photo]);
});

describe("GET /car/:car_id", () => {
  it("uses PUBLIC_BASE_URL for the page's own address when it is set", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://jeff.example.com/");
    const html = await (await fetch(`${base}/car/JW-065`)).text();
    vi.unstubAllEnvs();
    expect(html).toContain('<meta property="og:url" content="https://jeff.example.com/car/JW-065">');
  });

  it("is public: serves the car page without any auth", async () => {
    const res = await fetch(`${base}/car/JW-065`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("2021 Toyota Highlander XSE AWD");
    expect(html).toContain("5TDGZRBH9MSJW0065");
    expect(html).toContain(`<meta property="og:image" content="${photo.photo_url}">`);
    // The car is reserved with an agreed price, but none of that is public.
    expect(html).not.toMatch(/reserved|42\.4m|42400000|JW-065-1794755450557/);
  });

  it("matches the car id without regard to case", async () => {
    expect((await fetch(`${base}/car/jw-065`)).status).toBe(200);
  });

  it("returns a 404 page for an unknown id", async () => {
    const res = await fetch(`${base}/car/JW-999`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Car not found");
  });

  it("still serves the page when the Photos tab cannot be read", async () => {
    vi.mocked(sheets.loadPhotos).mockRejectedValue(new Error("no Photos tab"));
    const res = await fetch(`${base}/car/JW-065`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("<img");
  });

  it("returns a 503 page, not a stack trace, when the sheet is unreachable", async () => {
    vi.mocked(sheets.loadSheet).mockRejectedValue(new Error("Google Sheets is unreachable"));
    const res = await fetch(`${base}/car/JW-065`);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Temporarily unavailable");
    expect(html).not.toContain("Google Sheets is unreachable");
  });
});

describe("auth is unchanged", () => {
  it("/mcp still needs the bearer token", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("/health is still public", async () => {
    expect(await (await fetch(`${base}/health`)).text()).toBe("ok");
  });
});

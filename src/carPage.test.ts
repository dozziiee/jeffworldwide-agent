import { describe, expect, it } from "vitest";
import { renderCarPage, renderMessagePage } from "./carPage";
import { quote } from "./pricing";
import type { Car } from "./sheets";

const settings = { fxRateNgnPerUsd: 1500, marginPct: 0.1, depositPctInStock: 0.3, depositPctPreOrder: 0.5, holdHoursInStock: 48, doorstepDeliveryNgn: 100_000, discountPct: 0.015, discountMinNgn: 200_000, discountMaxNgn: 2_000_000 };

const base: Car = {
  row: 2, car_id: "JW-065", make: "Toyota", model: "Highlander", year: 2021, trim: "XSE AWD", colour: "Blue", interior: "Black", mileage: "42800",
  status: "in_stock", price_ngn: 42_900_000, costs: null, location: "Lagos", origin_port: "", destination_port: "", shipping_type: "", expected_berth: "",
  highlights: "Third row", reservation_ref: "JW-065-1794755450557", reservation_status: "reserved", payment_url: "https://checkout.paystack.com/secret-link", review_until: "",
  vin: "5TDGZRBH9MSJW0065", title_status: "Clean", owners: "2", accidents_reported: "1 minor (rear bumper, repaired)",
};
const preOrder: Car = { ...base, status: "on_water", price_ngn: null, costs: { auctionPrice: 20_000, auctionFees: 1_500, groundShipping: 800, oceanShipping: 2_200, clearing: 10_000 } };
const photo = { make: "Toyota", model: "Highlander", photo_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Highlander.jpg/1280px-Highlander.jpg", page_url: "https://commons.wikimedia.org/wiki/File:Highlander.jpg", author: "Kevauto", licence: "CC BY-SA 4.0" };
const URL = "https://jeff.example.com/car/JW-065";
const render = (car: Car = base, p: typeof photo | null = photo) => renderCarPage(car, quote(car, settings), p ?? undefined, URL);
/** The page without its stylesheet, so words like "margin" in the CSS are not mistaken for content. */
const content = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "");

describe("car page", () => {
  it("shows the title, colour, mileage, price, photo, VIN and vehicle history", () => {
    const html = render();
    expect(html).toContain("<h1>2021 Toyota Highlander XSE AWD</h1>");
    expect(html).toContain("Blue");
    expect(html).toContain("42,800 miles");
    expect(html).toContain("₦42.9m");
    expect(html).toContain("on ground in Lagos");
    expect(html).toContain(`<img class="photo" src="${photo.photo_url}"`);
    expect(html).toContain("5TDGZRBH9MSJW0065");
    expect(html).toMatch(/Vehicle history[\s\S]*Title[\s\S]*Clean[\s\S]*Owners[\s\S]*2[\s\S]*Accidents[\s\S]*1 minor \(rear bumper, repaired\)/);
  });

  it("says 'to your doorstep' for pre-orders", () => {
    const html = render(preOrder);
    expect(html).toContain("₦57.9m");
    expect(html).toContain("to your doorstep");
    expect(html).not.toContain("on ground in Lagos");
  });

  it("has the small print with the photo credit", () => {
    const html = render();
    expect(html).toContain("Demo listing. Demo photo of this model:");
    expect(html).toContain("Photo: Kevauto, CC BY-SA 4.0, via Wikimedia Commons");
    expect(html).toContain(`href="${photo.page_url}"`);
    expect(html).toContain("History data is illustrative.");
  });

  it("has og:title and og:image so WhatsApp shows a preview", () => {
    const html = render();
    expect(html).toContain('<meta property="og:title" content="2021 Toyota Highlander XSE AWD | ₦42.9m on ground in Lagos">');
    expect(html).toContain(`<meta property="og:image" content="${photo.photo_url}">`);
    expect(html).toContain(`<meta property="og:url" content="${URL}">`);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it("without a photo: no image, no og:image, shorter small print", () => {
    const html = render(base, null);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("og:image");
    expect(html).toContain("Demo listing. History data is illustrative.");
    expect(html).toContain("5TDGZRBH9MSJW0065");
  });

  it("never shows costs, margin, the lowest price or reservation details", () => {
    for (const html of [render(), render(preOrder)].map(content)) {
      // Lowest prices (42.4m / 57.4m), deposits, cost inputs, FX, margin, reference, status, payment link.
      expect(html).not.toMatch(/42\.26m|42\.64m|57\.04m|57\.55m|lowest|first.?offer|deposit|12,870,000|28,950,000|20,?000|1,?500|usd|margin|fx|JW-065-1794755450557|reserved|pending|paystack|secret-link/i);
    }
  });

  it("escapes sheet values, and refuses photo links that are not plain https", () => {
    const html = render({ ...base, trim: `<script>alert("x")</script>`, colour: `Blue" onload="x` }, { ...photo, photo_url: "javascript:alert(1)", page_url: `https://evil.example/" onclick="x` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('onload="x');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onclick="x');
  });
});

describe("message page", () => {
  it("renders a simple, escaped page", () => {
    const html = renderMessagePage("Car not found", "We could not find <that> car.");
    expect(html).toContain("<h1>Car not found</h1>");
    expect(html).toContain("&lt;that&gt;");
    expect(html).toContain("noindex");
  });
});

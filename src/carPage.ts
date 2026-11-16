// The public car page: plain HTML, safe to share. It shows only customer-facing details,
// never costs, margin, the lowest price or anything about reservations.

import type { Quote } from "./pricing";
import { mileageDisplay, photoCredit, title } from "./search";
import type { Car, PhotoRow } from "./sheets";

const escapeHtml = (text: unknown) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Only plain https links are ever put into the page. */
const safeUrl = (url: string) => (/^https:\/\/[^\s"'<>]+$/.test(url) ? url : "");

const STYLE = `
  :root { color-scheme: light dark; --bg: #f6f5f2; --card: #ffffff; --text: #1a1a1a; --muted: #62605b; --line: #e3e0d9; --accent: #0b5d3b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141413; --card: #1f1f1d; --text: #f1efe9; --muted: #a8a59d; --line: #33322f; --accent: #6fd3a3; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  .brand { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 8px 0 12px; }
  img.photo { display: block; width: 100%; height: auto; border-radius: 12px; background: var(--line); }
  h1 { font-size: 24px; line-height: 1.25; margin: 16px 0 4px; }
  .price { font-size: 28px; font-weight: 700; color: var(--accent); margin: 8px 0 0; }
  .basis { color: var(--muted); margin: 0 0 16px; }
  dl { margin: 0; }
  .row { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-top: 1px solid var(--line); }
  dt { color: var(--muted); }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  .vin { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px; }
  section.box { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 4px 16px; margin: 16px 0; }
  section.box h2 { font-size: 16px; margin: 12px 0 8px; }
  section.box .row:first-of-type { border-top: 0; }
  p.small { color: var(--muted); font-size: 12px; margin: 24px 0 16px; }
  p.small a { color: inherit; }
`;

function page(head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">Jeff Worldwide</p>
${body}
</main>
</body>
</html>`;
}

const row = (label: string, value: string, valueClass = "") =>
  `<div class="row"><dt>${escapeHtml(label)}</dt><dd${valueClass ? ` class="${valueClass}"` : ""}>${escapeHtml(value)}</dd></div>`;

export function renderCarPage(car: Car, q: Quote, photo: PhotoRow | undefined, pageUrl: string): string {
  const name = title(car);
  const basis = q.price_basis === "to_your_doorstep" ? "to your doorstep" : "on ground in Lagos";
  const price = `₦${q.price_display}`;
  const photoUrl = safeUrl(photo?.photo_url ?? "");
  const creditUrl = safeUrl(photo?.page_url ?? "");
  const credit = photo && photoUrl ? photoCredit(photo) : "";
  const description = `${price} ${basis}. ${[car.colour, mileageDisplay(car.mileage)].filter(Boolean).join(", ")}.`;

  const head = [
    `<title>${escapeHtml(name)} | Jeff Worldwide</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Jeff Worldwide">`,
    `<meta property="og:title" content="${escapeHtml(`${name} | ${price} ${basis}`)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    safeUrl(pageUrl) && `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
    photoUrl && `<meta property="og:image" content="${escapeHtml(photoUrl)}">`,
    photoUrl && `<meta name="twitter:card" content="summary_large_image">`,
  ]
    .filter(Boolean)
    .join("\n");

  const smallPrint = credit
    ? `Demo listing. Demo photo of this model: ${creditUrl ? `<a href="${escapeHtml(creditUrl)}">${escapeHtml(credit)}</a>` : escapeHtml(credit)}. History data is illustrative.`
    : "Demo listing. History data is illustrative.";

  const body = [
    photoUrl && `<img class="photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(`${car.year} ${car.make} ${car.model}`)}" width="1280" height="853">`,
    `<h1>${escapeHtml(name)}</h1>`,
    `<p class="price">${escapeHtml(price)}</p>`,
    `<p class="basis">${escapeHtml(basis)}</p>`,
    `<dl>`,
    car.colour && row("Colour", car.colour),
    car.mileage && row("Mileage", mileageDisplay(car.mileage)),
    car.vin && row("VIN", car.vin, "vin"),
    `</dl>`,
    `<section class="box"><h2>Vehicle history</h2><dl>`,
    row("Title", car.title_status || "Not recorded"),
    row("Owners", car.owners || "Not recorded"),
    row("Accidents", car.accidents_reported || "Not recorded"),
    `</dl></section>`,
    `<p class="small">${smallPrint}</p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return page(head, body);
}

export function renderMessagePage(heading: string, message: string): string {
  return page(
    `<title>${escapeHtml(heading)} | Jeff Worldwide</title>\n<meta name="robots" content="noindex">`,
    `<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(message)}</p>`,
  );
}

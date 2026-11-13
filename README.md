# Jeffworldwide MCP server

A small remote [MCP](https://modelcontextprotocol.io) server that gives a Chord AI teammate four tools for selling Jeffworldwide's cars. Chord is the MCP client. The "Jeffworldwide inventory" Google Sheet is the only data store, and Paystack takes the deposits.

| Tool | What it does | `status` values |
| --- | --- | --- |
| `search_inventory` | Free-text and filtered search over cars that are not reserved. Returns up to 5, with final naira price and deposit. | `ok`, `no_match`, `summary` |
| `create_reservation` | Creates a Paystack deposit link and marks the car `pending_payment`. | `link_created`, `car_not_found`, `car_unavailable`, `payment_init_failed`, `invalid_input` |
| `compare_market_price` | Compares one car's price with market asking prices from the Market tab. | `ok`, `no_comparison`, `car_not_found`, `invalid_input` |
| `confirm_reservation` | Verifies the payment and marks the car `reserved`, or releases it. | `reserved`, `amount_mismatch`, `failed`, `abandoned`, `pending`, `reference_not_found`, `car_unavailable` |

Every tool returns a JSON object with a `status` and, when something went wrong, a short `message`. Any tool can also return `service_unavailable` (Paystack or Google down, timing out after 10 seconds, or misconfigured) or `error` (unexpected failure). Raw errors never reach the client.

Customers only ever see final naira figures. Cost columns, the FX rate and the margin stay on the server.

## Endpoints

- `POST /mcp`: MCP over Streamable HTTP, stateless. Requires `Authorization: Bearer <MCP_AUTH_TOKEN>`; anything else gets 401.
- `GET /health`: returns `ok`.

## Layout

```
src/pricing.ts   X.9 rounding, pre-order price, deposit, "59.9m" formatting (pure functions)
src/search.ts    query normalisation, matching, ordering and result shaping (pure functions)
src/market.ts    market price comparison (pure function)
src/sheets.ts    Google Sheets read/write, row parsing, the Logs tab and the Market tab
src/paystack.ts  Paystack initialize and verify
src/tools.ts     the three tools, logging and error handling
src/app.ts       Express app: auth, /mcp, /health
src/local.ts     local entry point
api/index.ts     Vercel entry point
```

## Environment variables

| Variable | Meaning |
| --- | --- |
| `MCP_AUTH_TOKEN` | Shared secret Chord sends as a bearer token. Use a long random string. |
| `PAYSTACK_SECRET_KEY` | Paystack **test** secret key (`sk_test_...`). |
| `GOOGLE_SHEET_ID` | ID of the sheet (the long string in its URL). |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email. Share the sheet with it as Editor. |
| `GOOGLE_PRIVATE_KEY` | The service account's private key, with `\n` between lines. |

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored; never commit secrets.

## The sheet

**Inventory** tab, header row first (column order does not matter, names do):

`car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status`

- `status`: `in_stock`, `in_us` or `on_water` (the last two are pre-orders).
- `reservation_status`: `available`, `pending_payment` or `reserved`. Blank counts as `available`.
- Rows that cannot be parsed (no `car_id`, unknown status, missing price or costs) are skipped and logged.

**Settings** tab, columns `setting, value`: `fx_rate_ngn_per_usd, margin_pct, deposit_pct_in_stock, deposit_pct_pre_order, hold_hours_in_stock, doorstep_delivery_ngn`. `doorstep_delivery_ngn` is optional: if the row is missing it counts as 0 and a warning is logged. Percentages can be written as `0.3`, `30` or `30%`. Settings are read fresh on every tool call.

## Search

`search_inventory` takes free text plus optional filters (`make`, `model`, `year`, `max_price_ngn`, `stock_type`); everything combines with AND.

- The query is lowercased, punctuation is stripped, and filler words are dropped, English and Pidgin ("how far that honda still dey" becomes `honda`).
- Aliases: `benz`, `merc`, `mercedes` → Mercedes-Benz; `lambo` → Lamborghini; `cyber truck` → Cybertruck; `g wagon`, `g-wagon` → G 63 AMG.
- A car matches when every remaining word is found in at least one of make, model, trim, colour, interior or year (substring, case-insensitive). So `gle` matches "GLE 450" and "GLE 63 S AMG".
- Reserved cars are excluded. Results are ordered with exact model matches first, then cheapest first.
- Every response has `status`, `total_matches`, `returned`, `truncated` and `results` (at most 5).
- `truncated: true` means more than 5 cars matched; `refine_options` then lists the distinct `model`, `year` and `stock_type` values among all matches, with counts, so the agent can ask the buyer to narrow down.
- `no_match` includes `unmatched_terms`: the words that matched no car at all.
- With no search words and no filters, the status is `summary`: counts of available cars by make and model (`by_make`) and no car list. The tool never returns "the first five rows".

## Market comparison

`compare_market_price` takes a `car_id` and compares Jeff's price with rows in a **Market** tab, which is created with its header row if missing.

Columns: `make, model, year, condition, low_ngn, high_ngn, listings_count, source_url, collected_on`.

- Rows match on the same make and model and the same year. If there is none for that year, the nearest year within one is used (one year older first, then one year newer) and the response says so (`exact_year_match: false` plus a `message`).
- Several rows for the same year are combined: lowest low, highest high, listings added up, and the `source_url` and `collected_on` of the most recent row.
- The response gives Jeff's price and `price_basis`, the market low and high, `difference_vs_low_ngn` (Jeff's price minus the market low), and a note that Jiji figures are asking prices for cars on ground, usually negotiable.
- No comparable rows → `no_comparison`. Unknown car → `car_not_found`.

## Logs tab

Every tool call is appended to a **Logs** tab in the sheet, because Vercel's free plan keeps logs for only a short time. The tab and its header row are created automatically if missing.

Columns: `timestamp_utc, tool, inputs_json, status, total_matches, reference, duration_ms, error_message`. Emails in the inputs are masked (`d***@gmail.com`). If the write fails, the failure goes to the console and the tool call carries on.

## Pricing

- In stock: `price_ngn` from the sheet.
- Pre-order: `(auction + fees + ground + ocean + clearing) × fx_rate × (1 + margin_pct) + doorstep_delivery_ngn`, then the X.9 rule in millions of naira: up to `f + 0.9` → `f + 0.9`; up to `f + 0.99` → `f + 0.99`; otherwise `f + 1.9`. So 57.3 → 57.9, 57.95 → 57.99, 57.995 → 58.9.
- Deposit: price × the deposit percentage for that stock type, rounded to the nearest naira.
- Every car carries `price_basis`: `to_your_doorstep` for pre-orders (delivery is in the price) and `on_ground_lagos` for in-stock cars.
- `price_display` is in Jeff's style (`59.9m`); `deposit_display` is full naira with commas (`₦28,796,000`).
- The price and deposit are computed when the reservation is created and stored in the Paystack metadata, so later FX changes do not affect a payment already in flight.

## Run locally

Needs Node 20.6 or newer locally. `package.json` pins Node `26.x`, which is what Vercel runs; on an older local Node, `npm install` prints an engine warning that is safe to ignore.

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

The server listens on `http://localhost:3000/mcp`. Run the unit tests with:

```bash
npm test
```

## Deploy to Vercel

1. Push the project to a Git repository and import it in Vercel, or run `npx vercel` from this folder.
2. In Project Settings → Environment Variables, add the five variables above. Paste `GOOGLE_PRIVATE_KEY` exactly as it appears in the service account JSON (with the `\n` sequences).
3. Deploy (`npx vercel --prod`). `vercel.json` routes every path to the Express app in `api/index.ts`.
4. Check `https://<your-app>.vercel.app/health` returns `ok`, then give Chord the URL `https://<your-app>.vercel.app/mcp` and the bearer token.

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector: choose transport **Streamable HTTP**, set the URL to `http://localhost:3000/mcp` (or the Vercel URL), open Authentication and set header `Authorization` to `Bearer <your MCP_AUTH_TOKEN>`, then Connect. Under Tools, List Tools should show the three tools. A good run-through:

1. `search_inventory` with `query: "white GLC 43"`.
2. `create_reservation` with a `car_id` from the results; open the `payment_url` and pay with a [Paystack test card](https://paystack.com/docs/payments/test-payments/).
3. `confirm_reservation` with the `reference`; the row in the sheet should now read `reserved`.

## Notes and limits

- `pending_payment` blocks a second reservation for 30 minutes, measured from the timestamp at the end of the reference (`JW-013-<timestamp>`).
- Paystack reports a link nobody has paid yet as `abandoned`. `confirm_reservation` returns `pending` (with `held_until`) for an abandoned payment while the reference is under 30 minutes old, and only returns `abandoned` and releases the car after that. A `failed` payment releases the car immediately.
- `confirm_reservation` only releases a row (failed or abandoned payment) if the row still carries that same reference, so an old link cannot undo a newer payment. If a payment succeeds for a car that was meanwhile reserved under another reference, it returns `car_unavailable` with a message that the deposit needs a refund.
- `held_until` is counted from Paystack's payment time, so calling `confirm_reservation` twice gives the same answer.
- There is no locking: the sheet is read, then written. Two reservations for the same car in the same second could both get a link; `confirm_reservation` then reserves for the first to pay.
- Logs go to the console (Vercel → Logs: tool name, inputs without the email, outcome and duration) and to the Logs tab in the sheet.

## Field notes from live testing (Paystack test mode, 12 Nov 2026)

- **Paid deposit:** ₦3.79m on an in-stock car → `reserved` with `held_until`; a second confirm gave the same answer.
- **Unpaid link checked early:** → `pending`, car stays held.
- **Declined card:** ₦3.79m with a declining test card → Paystack status `failed` → `confirm_reservation` returned `failed` and freed the car.
- **Biggest deposit:** ₦108.76m (LX 600, 40% of 271.9m). Paystack created the link without complaint. On the checkout, **card payment was declined three times with "Insufficient Funds"**, then **bank transfer succeeded** and the car was reserved.

Go-live points:

- Deposits of this size may not go through by card. Check Paystack's live limits (and typical customer card limits) for large amounts, and expect customers to pay large deposits by bank transfer. Chord should suggest transfer if a card is declined.
- A declined attempt does not close the link: the customer can retry or switch method on the same checkout. If `confirm_reservation` runs between a decline and the retry, it returns `failed` and frees the car; a later successful payment on that link is still honoured when confirmed, unless someone else reserved the car in between.
- Switch `PAYSTACK_SECRET_KEY` to the live key only at go-live; the code is the same.

## How AI tools were used

This server was built with Claude Code (Anthropic) from a written brief. The AI read the brief, proposed the module split, wrote the code, the unit tests and this README, and ran the tests and a local smoke test of the HTTP endpoints. A human wrote the brief, chose the pricing rules and statuses, reviewed the result, and is responsible for the credentials, the sheet and the deployment.

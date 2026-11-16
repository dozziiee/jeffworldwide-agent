# Jeff Worldwide MCP server

Six tools that let a Chord AI teammate sell cars on WhatsApp for
Jeff Worldwide, a Lagos dealership: search live inventory, quote all-in
"to your doorstep" prices, send a car page with VIN and accident
history, compare against Lagos market listings, take a Paystack
deposit and reserve the car. All data lives in one Google Sheet; the
agent itself runs on Chord.

**Quick start:** `npm install`, copy `.env.example` to `.env`, fill in
the values, `npm run dev`. Deployed on Vercel, served at `/mcp` over
Streamable HTTP with a bearer token.

> **Demo project.** Jeff Worldwide is a real Lagos dealership, but this
> is an unaffiliated demo built for a take-home exercise. All
> inventory, prices, VINs and vehicle history are made up, photos are
> Creative Commons images of the model rather than the actual car, and
> Paystack runs in test mode, so no real money moves.

| Tool | What it does | `status` values |
| --- | --- | --- |
| `search_inventory` | Free-text and filtered search over cars that are not reserved. Returns up to 5, with final naira price and deposit. | `ok`, `no_match`, `summary` |
| `create_reservation` | Creates a Paystack deposit link and marks the car `pending_payment`. Accepts an optional negotiated price. | `link_created`, `link_exists`, `already_paid`, `price_below_minimum`, `car_not_found`, `car_unavailable`, `payment_init_failed`, `invalid_input` |
| `compare_market_price` | Compares one car's price with market asking prices from the Market tab. | `ok`, `no_comparison`, `car_not_found`, `invalid_input` |
| `request_photos` | Records a buyer's request for actual photos of a car in the Requests tab. | `requested`, `car_not_found`, `invalid_input` |
| `request_callback` | Records a request for the team to call the buyer back, in the Requests tab. | `requested`, `invalid_input` |
| `confirm_reservation` | Verifies the payment, by reference or by `car_id`, and marks the car `reserved`, or releases it. | `reserved`, `amount_mismatch`, `failed`, `abandoned`, `pending`, `reference_not_found`, `car_unavailable` |

Every tool returns a JSON object with a `status` and, when something went wrong, a short `message`. Any tool can also return `service_unavailable` (Paystack or Google down, timing out after 10 seconds, or misconfigured) or `error` (unexpected failure). Raw errors never reach the client.

Customers only ever see final naira figures. Cost columns, the FX rate and the margin stay on the server.

## Endpoints

- `POST /mcp`: MCP over Streamable HTTP, stateless. Requires `Authorization: Bearer <MCP_AUTH_TOKEN>`; anything else gets 401.
- `GET /health`: warms the server (signs in to Google and loads the cached tabs) and returns `ok` with the time taken, for example `ok 412ms`. Returns 503 if Google Sheets cannot be reached.
- `GET /car/:car_id`: a public, mobile-friendly page for one car (no auth). Unknown IDs get a 404 page.

## Layout

```
src/pricing.ts   X.9 rounding, pre-order price, deposit, "59.9m" formatting (pure functions)
src/search.ts    query normalisation, matching, ordering and result shaping (pure functions)
src/market.ts    market price comparison (pure function)
src/sheets.ts    Google Sheets read/write, row parsing, and the Logs, Market, Photos and Requests tabs
src/paystack.ts  Paystack initialize and verify
src/tools.ts     the tools, logging and error handling
src/alerts.ts    the WhatsApp team alert, sent through Twilio
src/config/constants.ts   route paths and HTTP header names
src/carPage.ts   the public car page (HTML)
src/vin.ts       demo VIN building and check-digit validation
src/app.ts       Express app: auth, /mcp, /health, /car/:car_id
src/local.ts     local entry point
api/index.ts     Vercel entry point
scripts/fetch-photos.ts          one-off script that fills the Photos tab from Wikimedia Commons
scripts/add-vehicle-history.ts   one-off script that adds demo VINs and history columns to Inventory
```

## Environment variables

| Variable | Meaning |
| --- | --- |
| `MCP_AUTH_TOKEN` | Shared secret Chord sends as a bearer token. Use a long random string. |
| `PAYSTACK_SECRET_KEY` | Paystack **test** secret key (`sk_test_...`). |
| `GOOGLE_SHEET_ID` | ID of the sheet (the long string in its URL). |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email. Share the sheet with it as Editor. |
| `GOOGLE_PRIVATE_KEY` | The service account's private key, with `\n` between lines. |
| `TWILIO_ACCOUNT_SID` | Twilio account SID, for the WhatsApp team alert. |
| `TWILIO_AUTH_TOKEN` | Twilio auth token. |
| `TWILIO_WHATSAPP_FROM` | The WhatsApp sender, for example `whatsapp:+14155238886`. |
| `ALERT_WHATSAPP_TO` | The team's WhatsApp number that receives alerts, in the same format. |
| `TWILIO_CONTENT_SID` | Optional. An approved WhatsApp template (`HX...`) with one variable, `{{1}}`. |
| `PUBLIC_BASE_URL` | Optional. The server's public address, used in links to car pages. If not set, it is taken from the incoming request. |

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored; never commit secrets.

## The sheet

**Inventory** tab, header row first (column order does not matter, names do):

`car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status`

- `status`: `in_stock`, `in_us` or `on_water` (the last two are pre-orders).
- `reservation_status`: `available`, `pending_payment`, `reserved` or `payment_review`. Blank counts as `available`.
- Four history columns, filled by a one-off script (see Vehicle history): `vin`, `title_status`, `owners`, `accidents_reported`.
- The server adds and maintains three more columns after these: `agreed_price_ngn` (a negotiated price), `payment_url` (the Paystack link for a pending payment) and `review_until` (when a payment review hold ends).
- Rows that cannot be parsed (no `car_id`, unknown status, missing price or costs) are skipped and logged.

**Settings** tab, columns `setting, value`: `fx_rate_ngn_per_usd, margin_pct, deposit_pct_in_stock, deposit_pct_pre_order, hold_hours_in_stock, doorstep_delivery_ngn, discount_pct, discount_min_ngn, discount_max_ngn`. `doorstep_delivery_ngn` is optional: if the row is missing it counts as 0 and a warning is logged. The three discount rows go together: if any of them is missing or invalid, there is no discount and a warning is logged. An old `max_discount_ngn` row is ignored. Percentages can be written as `0.3`, `30` or `30%`. Settings are cached for 15 seconds, so a change in the sheet applies within that time.

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

## Sheet access

- **One request per tool call.** Every tab a tool needs is read in a single `batchGet`.
- **One sign-in.** The Google token is fetched once per server instance and reused until it is about to expire.
- **Cache.** Rows are kept in memory: Photos for 10 minutes; Inventory, Settings and Market for 15 seconds. Sheet edits therefore show up within 15 seconds.
- **Writes clear the cache.** Any reservation write, payment review or request clears the Inventory cache immediately.
- **Reservations never use the cache.** `create_reservation`, `confirm_reservation` and `request_callback` always read Inventory fresh, so availability is decided on the sheet as it is.
- **Retry.** A timeout (10 seconds) or 5xx from Google is retried once before the tool returns `service_unavailable`. Appending a row is not repeated after a timeout, so a log or request row is never written twice.
- **Tabs are created only when missing.** Market, Photos, Logs and Requests are created only when Google explicitly reports that the tab does not exist, never because a read failed. Inventory and Settings are never created.
- **Warm-up.** Calling `GET /health` loads everything, so the next tool call needs no reads. Pointing an uptime monitor at it every few minutes keeps the server warm.

## Reservations

`create_reservation` first checks the car's state:

- `reserved`, or `payment_review` that has not expired → `car_unavailable`.
- `pending_payment` with a reference under 30 minutes old → the server asks Paystack about that payment before deciding:
  - **Paid:** the reservation is finalised. The buyer whose email is on the payment gets `already_paid` with `car_id`, `title`, `deposit_display` and `reference`; anyone else gets `car_unavailable`.
  - **Unpaid, same email:** `link_exists` with the same `payment_url` and `reference`. Paystack reports a link nobody has paid yet as `abandoned`, so within the 30 minutes that counts as unpaid.
  - **Unpaid, different email:** `car_unavailable`, "Another buyer has a payment in progress for this car."
  - **Failed** (or unknown to Paystack): the car is freed and a new link is created as normal.
- Otherwise a new link is created.

`link_created`, `link_exists` and `already_paid` all include `reference_line`, for example "Ref: JW-091-1794755450557"; so does `reserved` from `confirm_reservation`.

`confirm_reservation` takes a `reference`, or a `car_id`, in which case it uses the `reservation_ref` on that car's row. If neither gives a usable reference it returns `reference_not_found`.

Card payments are disabled. A 40% deposit on a pre-order runs to tens of millions of naira, far above Nigerian card limits, so every card attempt would decline at the moment the buyer had decided to pay. Transactions are configured for bank transfer.

### Payment review

A `request_callback` with the reason "payment dispute" and an identifiable car (from `car_id`, or from the `reference`) sets that row's `reservation_status` to `payment_review` and `review_until` to 24 hours ahead. Until then the car is treated like a reserved one: hidden from search and refused by `create_reservation`. Once `review_until` passes, the car is on sale again without anyone editing the sheet. A successful `confirm_reservation` during the review reserves the car; a failed or abandoned one leaves the hold in place. A car that is already `reserved` is not changed by a dispute.

## Market comparison

`compare_market_price` takes a `car_id` and compares Jeff's price with rows in a **Market** tab, which is created with its header row if missing.

Columns: `make, model, year, condition, low_ngn, high_ngn, listings_count, source_url, collected_on`.

- Rows match on the same make and model and the same year. If there is none for that year, the nearest year within one is used (one year older first, then one year newer) and the response says so (`exact_year_match: false` plus a `message`).
- Several rows for the same year are combined: lowest low, highest high, listings added up, and the `source_url` and `collected_on` of the most recent row.
- The response gives Jeff's price and `price_basis`, the market low and high, `difference_vs_low_ngn` (Jeff's price minus the market low), and a note that these are asking prices for cars on ground in Nigeria, usually negotiable.
- `source_name` is derived from the `source_url` domain (`jiji.ng` → Jiji, `cars45.com` → Cars45, `autochek.africa` → Autochek, `afrotools.com` → Afrotools); if the matched rows come from several sources, they are listed. `condition` is passed through the same way (`foreign_used`, `mixed`).
- No comparable rows → `no_comparison`. Unknown car → `car_not_found`.

## Vehicle history and the car page

Each car in a `search_inventory` result carries `vin`, `title_status`, `owners` and `accidents_reported`, read from the Inventory tab, plus `photo_link`: the address of that car's public page, `<base url>/car/<car_id>`. `photo_link` is empty when the model has no photo.

The page at `/car/<car_id>` needs no login and is made to be shared in a chat. It shows the car's title, colour, mileage, price ("to your doorstep" for pre-orders, "on ground in Lagos" for in-stock cars), a photo of the model, the VIN, and a Vehicle history box (title, owners, accidents). It has `og:title` and `og:image` tags so WhatsApp shows a preview, and small print saying it is a demo listing, crediting the photo, and noting that the history data is illustrative. It never shows costs, margin, the lowest price or anything about reservations.

The history columns are demo data, written once by a script:

```bash
npm run add-vehicle-history
```

- `vin`: a synthetic 17-character VIN. It has a realistic manufacturer prefix for the make and model, the correct model-year code in position 10 and a valid check digit in position 9, with no I, O or Q. Positions 12 to 17 are "JW" plus the four-digit car number (`JW0065`), so it is plainly a demo VIN and cannot match a real vehicle.
- `title_status`: "Clean" for every car.
- `owners`: 1 to 3, weighted towards 1 and 2.
- `accidents_reported`: "None reported" for 85 of the 100 cars; the rest have one minor bumper repair.

The random seed is fixed, so running the script again writes the same values. It writes only those four columns. Add `-- --dry-run` to print a summary without writing.

## Photos

The model photo on each car page is matched on make + model from the **Photos** tab. The photo is a representative picture of the model, not of the exact car, and the page credits it ("Photo: <author>, <licence>, via Wikimedia Commons"). Each car in a search result also has `mileage_display`, for example "42,800 miles".

The Photos tab (`make, model, photo_url, page_url, author, licence`) is filled by a one-off script, not by the server:

```bash
npm run fetch-photos
```

It reads the distinct make + model pairs from Inventory, searches Wikimedia Commons for each, and accepts only JPEGs licensed CC BY, CC BY-SA or public domain (CC0). It prefers file names that state the right model and a model year close to the inventory's, and rejects interiors, details, other body styles and other generations. `photo_url` is a direct 1280px link on `upload.wikimedia.org`. Models with nothing suitable get an empty `photo_url` and are listed at the end. Add `-- --dry-run` to print the picks without writing. The picks are automatic, so check them; any row can be corrected by hand in the sheet. Running the script again replaces the whole tab.

## Requests tab

Two tools append rows to a **Requests** tab (created with headers if missing) for the team to work through:

`timestamp_utc, car_id, title, request_type, reason, note, status, reference`

- `request_photos` takes a `car_id` and records `request_type` "photos" with `status` "open"; `reason`, `note` and `reference` are left empty.
- `request_callback` takes a `reason` (required, for example "negotiation", "viewing", "photos", "deposit paid", "refund", "payment dispute"), plus an optional `car_id`, `reference` (a payment reference) and `note` (for example the price the buyer wants), and records `request_type` "callback" with `status` "open". If no `car_id` is given, the car is worked out from the reference. If the car is not in the inventory the request is still recorded, without a title, so it is never lost.

### WhatsApp alert

After the row is written, `request_callback` sends the team a WhatsApp message through the Twilio Messages API. The message is one line:

`Active Desk | {reason} | {title} ({car_id}) | Ref {reference} | {note}`

Empty parts are left out, line breaks are removed, and the line is cut to 250 characters.

- If `TWILIO_CONTENT_SID` is set, the message is sent as that template, with the line as variable `{{1}}`. If Twilio rejects it, or the variable is not set, it is sent once more as a plain text message.
- Each attempt has a 5-second timeout.
- If the Twilio variables are missing or both sends fail, a warning is logged with Twilio's error code and the tool still returns `requested`.
- WhatsApp only delivers plain text messages within 24 hours of the recipient last messaging the sender; outside that window an approved template is needed. Twilio accepting a message is not the same as WhatsApp delivering it: check the message log in the Twilio console if an alert does not arrive.

## Logs tab

Every tool call is appended to a **Logs** tab in the sheet, because Vercel's free plan keeps logs for only a short time. The tab and its header row are created automatically if missing.

Columns: `timestamp_utc, tool, inputs_json, status, total_matches, reference, duration_ms, error_message`. Emails in the inputs are masked (`d***@gmail.com`). If the write fails, the failure goes to the console and the tool call carries on.

## Pricing

- In stock: `price_ngn` from the sheet.
- Pre-order: `(auction + fees + ground + ocean + clearing) × fx_rate × (1 + margin_pct) + doorstep_delivery_ngn`, then the X.9 rule in millions of naira: up to `f + 0.9` → `f + 0.9`; up to `f + 0.99` → `f + 0.99`; otherwise `f + 1.9`. So 57.3 → 57.9, 57.95 → 57.99, 57.995 → 58.9.
- Deposit: price × the deposit percentage for that stock type, rounded to the nearest naira.
- Negotiation room: the discount on a car is `price × discount_pct`, kept between `discount_min_ngn` and `discount_max_ngn`, rounded down to the nearest ₦10,000. With 0.015, ₦200,000 and ₦2,000,000: 18.9m → ₦280,000; 30.9m → ₦460,000; 107.9m → ₦1,610,000; 487.99m → ₦2,000,000.
- Every car carries `lowest_price_ngn` / `lowest_price_display` (price minus the discount, the floor) and `first_offer_ngn` / `first_offer_display` (price minus 40% of the discount, rounded down to the nearest ₦10,000). The first offer is the agent's opening move when a buyer asks for a better price, so the agent never does the arithmetic. Neither appears on the public car page.
- `create_reservation` accepts an optional `agreed_price_ngn`. It must be between the lowest price and the quoted price; below the floor returns `price_below_minimum` with `lowest_price_display`, and above the quoted price returns `invalid_input`. The deposit is calculated on the agreed price, which goes into the Paystack metadata and into the Inventory column `agreed_price_ngn` (added if missing). The column is cleared when a reservation is created without an agreed price or when a payment fails or is abandoned.
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

The server listens on `http://localhost:3000/mcp`. Run the tests with:

```bash
npm test
```

Besides the unit tests, `src/mcp.contract.test.ts` starts the app and connects with the MCP SDK client over Streamable HTTP, as Chord does. It checks that all tools are listed, calls each one (with Google Sheets, Paystack and Twilio mocked) and checks each returns JSON with a `status`, and checks that a missing or wrong bearer token gets a 401.

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

Deployment field notes are a separate submission document.

## Photo credits

Model photos in search results come from [Wikimedia Commons](https://commons.wikimedia.org). They are representative pictures of each model, not of the cars for sale. Each is used under the licence shown; follow the link for the original file and full licence terms.

| Model | Author | Licence | Source |
| --- | --- | --- | --- |
| Mercedes-Benz GLC 43 AMG | EurovisionNim | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2017_Mercedes-Benz_GLC_43_AMG_%28X_253%29_4MATIC_wagon_%282018-10-08%29_02.jpg) |
| Mercedes-Benz GLE 350 | Kevauto | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2020_Mercedes-Benz_GLE_350_4Matic_front_6.16.19.jpg) |
| Mercedes-Benz GLE 450 | Autobilder Gratis | CC BY 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:Mercedes_GLE_450_4Matic_Photo_2020_Free_image_%2849647801197%29.jpg) |
| Mercedes-Benz GLE 53 AMG | Chanokchon | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2021_Mercedes-AMG_GLE_53_4MATIC%2B.jpg) |
| Mercedes-Benz GLE 63 S AMG | Charles from Port Chester, New York | CC BY 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:Mercedes-Benz_GLE-Klasse_%28V167%29_GLE_63_S_AMG_4MATIC_%282021%29_%2853489900458%29.jpg) |
| Mercedes-Benz GLC 300 | LuvsMG481 | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2023_Mercedes-Benz_GLC_300_4MATIC_front.jpg) |
| Mercedes-Benz S-Class S 580 | Charles from Port Chester, New York | CC BY 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:Mercedes-Benz_S-Klasse_%28W223%29_S_580_e_%282022%29_%2853333458825%29.jpg) |
| Mercedes-Benz Maybach S 580 | Benespit | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:0_Mercedes-Maybach_S_580_2.jpg) |
| Mercedes-Benz G 63 AMG | Charles from Port Chester, New York | CC BY 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:Mercedes-Benz_G-Klasse_%28W463%29_G_63_AMG_%282021%29_%2853323144370%29.jpg) |
| Mercedes-Benz E 350 | Charles from Port Chester, New York | CC BY 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:Mercedes-Benz_E-Klasse_%28W213%29_E_350_4MATIC_%282021%29_%2853646420160%29.jpg) |
| Lamborghini Urus | MrWalkr | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2022_Lamborghini_Urus_Blue.jpg) |
| Lamborghini Urus S | Calreyn88 | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Lamborghini_Urus_S_2023.jpg) |
| Toyota Camry | Throwawayacc222 | CC0 | [Commons](https://commons.wikimedia.org/wiki/File:2020_Toyota_Camry_XSE_front.jpg) |
| Toyota Corolla | MercurySable99 | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2021_Toyota_Corolla_LE,_front_right,_07-13-2024.jpg) |
| Toyota Highlander | Kevauto | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2020_Toyota_Highlander_Platinum_AWD_front_NYIAS_2019.jpg) |
| Toyota FJ Cruiser | Vauxford | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2014_Toyota_FJ_Cruiser_4.0_Front.jpg) |
| Tesla Cybertruck | Alexander-93 | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2024_Tesla_Cybertruck_Foundation_Series_IMG_0634_%28cropped%29.jpg) |
| Lexus RX 350 | RL GNZLZ from Chile | CC BY-SA 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:Lexus_RX_350_F-Sport_2017_%2837205310660%29.jpg) |
| Lexus LX 570 | Kevauto | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2018_Lexus_LX_570_%28facelift%29,_front_3.24.23.jpg) |
| Lexus LX 600 | Charles from Port Chester, New York | CC BY 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:Lexus_LX_600_%282024%29_%2853626699099%29.jpg) |
| Lexus GX 460 | Gematolog | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Lexus_GX_460_2020-2021.jpg) |
| Lexus ES 350 | Elise240SX | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2020_Lexus_ES_350_Luxury_Package_in_Eminent_White_Pearl,_Front_Right,_07-13-2023.jpg) |
| Cadillac Escalade | Mr.choppers | CC BY-SA 3.0 | [Commons](https://commons.wikimedia.org/wiki/File:2021_Cadillac_Escalade_ESV_4WD_Premium_Luxury_in_Satin_Steel_Metallic,_front_right.jpg) |
| Porsche Macan | Vauxford | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2016_Porsche_Macan_GTS_S-A_3.0_Front.jpg) |
| Porsche Cayenne | Calreyn88 | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2019_Porsche_Cayenne_S.jpg) |
| Porsche Cayenne Coupe | DestinationFearFan | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2021_Porsche_Cayenne_Coupe.jpg) |
| Honda Accord | Ghostofakina | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2019_Honda_Accord_1.5T_Sport,_1.4.20.jpg) |
| Honda CR-V | Kevauto | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2020_Honda_CR-V_EX-L_%28facelift%29,_front_11.30.21.jpg) |
| Honda Pilot | DestinationFearFan | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:2021_Honda_Pilot_EX-L.jpg) |

## How AI tools were used

This server was built with Claude Code (Anthropic) from a written brief. The AI read the brief, proposed the module split, wrote the code, the unit tests and this README, and ran the tests and a local smoke test of the HTTP endpoints. A human wrote the brief, chose the pricing rules and statuses, reviewed the result, and is responsible for the credentials, the sheet and the deployment.

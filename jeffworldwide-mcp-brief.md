# Build brief: Jeffworldwide MCP server

Build a small remote MCP server in TypeScript (Node 20) that a Chord AI teammate will call as its tools. Chord is the MCP client. Deploy target: Vercel.

## Hard requirements

- Use the official MCP TypeScript SDK and the **Streamable HTTP** transport, served at `/mcp` over public HTTPS. Stateless mode is fine.
- Require `Authorization: Bearer <MCP_AUTH_TOKEN>` on every request; reject anything else with 401.
- Read all secrets from environment variables. Never commit them. Provide `.env.example`.
- Every tool returns a JSON object with a `status` field the agent can act on. Never throw raw errors at the client; catch them and return a clear `status` plus a short `message`.
- Log each tool call (tool name, inputs without email, outcome, duration) to the console for debugging.
- Add a `GET /health` endpoint that returns `ok`.

## Environment variables

- `MCP_AUTH_TOKEN`: shared secret Chord sends as a bearer token
- `PAYSTACK_SECRET_KEY`: Paystack **test** secret key (`sk_test_...`)
- `GOOGLE_SHEET_ID`: ID of the "Jeffworldwide inventory" sheet
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`: service account with Editor access to the sheet

## Data: Google Sheet with two tabs

**Inventory** columns:
`car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status`

- `status`: `in_stock`, `in_us` or `on_water`. `in_us` and `on_water` are pre-orders.
- `reservation_status`: `available`, `pending_payment` or `reserved`.

**Settings** tab, two columns `setting, value`:
`fx_rate_ngn_per_usd, margin_pct, deposit_pct_in_stock, deposit_pct_pre_order, hold_hours_in_stock`

Read Settings fresh on every tool call so changes in the sheet apply immediately.

## Pricing logic

- **In stock:** price is `price_ngn` from the sheet.
- **Pre-order:** `raw = (auction_price + auction_fees + ground_shipping + ocean_shipping + clearing) × fx_rate × (1 + margin_pct)`, then apply the X.9 rounding rule.
- **X.9 rounding rule** (work in millions of naira, `f = floor(m)`):
  - if `m ≤ f + 0.9` → `f + 0.9`
  - else if `m ≤ f + 0.99` → `f + 0.99`
  - else → `f + 1.9`
  - Examples: 57.3 → 57.9; 57.9 → 57.9; 57.95 → 57.99; 57.995 → 58.9.
- **Deposit:** `price × deposit_pct_in_stock` or `price × deposit_pct_pre_order`, rounded to the nearest naira.
- **Never** return cost components, the FX rate or the margin to the client. Only final naira figures.
- Format prices for display in Jeff's style: `59.9m`, `57.99m`. Also return the raw integer naira amount.

## Tools

### 1. `search_inventory`

Inputs (all optional): `query` (free text such as "white GLC 43"), `make`, `model`, `year`, `max_price_ngn`, `stock_type` (`in_stock` or `pre_order`).

- Match case-insensitively across make, model, trim, colour and year.
- Return at most 5 cars that are not `reserved`, each with: `car_id, title` (e.g. "2018 Mercedes-Benz GLC 43 AMG Coupe 4MATIC"), `colour, interior, mileage, stock_type, price_display, price_ngn, deposit_pct, deposit_display, deposit_ngn, location, highlights`, and for pre-orders also `status` (`in_us` or `on_water`), `shipping_type, origin_port, destination_port, expected_berth`.
- `status`: `ok` with results, or `no_match` with an empty list.

### 2. `create_reservation`

Inputs (required): `car_id`, `customer_name`, `customer_email`.

1. Look up the car. If missing → `status: car_not_found`.
2. If `reserved`, or `pending_payment` with a reference created in the last 30 minutes by a different payment → `status: car_unavailable`.
3. Compute price and deposit now (this locks the FX rate for this reservation).
4. Call Paystack `POST https://api.paystack.co/transaction/initialize` with `email`, `amount` in kobo, a unique `reference` such as `JW-013-<timestamp>`, and `metadata` containing `car_id, customer_name, price_ngn, deposit_ngn, stock_type`.
5. On success, write `reservation_ref` and `reservation_status = pending_payment` to the row, and return `status: link_created` with `payment_url, reference, deposit_ngn, deposit_display, price_display`.
6. If Paystack rejects it, return `status: payment_init_failed` with Paystack's message, and leave the row unchanged.

### 3. `confirm_reservation`

Input (required): `reference`.

1. Call Paystack `GET https://api.paystack.co/transaction/verify/:reference`.
2. Map the result:
   - `success` and the amount paid equals the deposit in metadata → write `reservation_status = reserved` and return `status: reserved` with `car_id, title, deposit_ngn`, and for in-stock cars `held_until` (now + `hold_hours_in_stock`).
   - `success` but amount mismatch → return `status: amount_mismatch` (do not reserve).
   - `failed` → `status: failed`; set the row back to `available`.
   - `abandoned` and the reference was created less than 30 minutes ago → `status: pending` with `held_until` (reference creation time + 30 minutes); leave the row as `pending_payment`. Paystack reports a link nobody has paid yet as `abandoned`, so an early check must not release the car.
   - `abandoned` and the reference is 30 minutes old or more → `status: abandoned`; set the row back to `available`.
   - anything still in progress → `status: pending`.
3. If the reference is unknown to Paystack → `status: reference_not_found`.

## Errors to handle everywhere

- Paystack or Google unreachable or timing out (set a 10-second timeout) → `status: service_unavailable`.
- Malformed sheet rows → skip the row and log it; never crash.

## Deliverables

- `src/` with the server, pricing logic in its own module, and unit tests for the X.9 rounding rule and pricing.
- `README.md`: what it does, environment variables, how to run locally, how to deploy to Vercel, how to test with the MCP Inspector, and a short section on how AI tools were used to build it.
- Keep the code small and readable. No database: the sheet is the source of truth.

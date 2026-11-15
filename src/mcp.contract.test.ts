// MCP contract test: a real MCP SDK client talks to the real app over Streamable HTTP.
// Only the outside services (Google Sheets, Paystack, Twilio) are mocked, as in the other tests.

import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as alerts from "./alerts";
import app from "./app";
import { ROUTES } from "./config/constants";
import * as paystack from "./paystack";
import * as sheets from "./sheets";

vi.mock("./alerts");
vi.mock("./paystack");
vi.mock("./sheets", async (importOriginal) => {
  const mocks = { loadSheet: vi.fn(), loadPhotos: vi.fn(), loadMarket: vi.fn(), writeReservation: vi.fn(), appendRequest: vi.fn(), appendLog: vi.fn(), warmUp: vi.fn() };
  return {
    ...(await importOriginal<typeof sheets>()),
    ...mocks,
    loadData: async (extra: string[] = []) => ({
      sheet: await mocks.loadSheet(),
      photos: extra.includes("Photos") ? await mocks.loadPhotos() : [],
      market: extra.includes("Market") ? await mocks.loadMarket() : [],
    }),
  };
});

const TOKEN = "contract-test-token";
const ALL_TOOLS = ["compare_market_price", "confirm_reservation", "create_reservation", "request_callback", "request_photos", "search_inventory"];

const HEADER =
  "car_id, make, model, year, trim, colour, interior, mileage, status, price_ngn, location, auction_price_usd, auction_fees_usd, ground_shipping_usd, ocean_shipping_usd, clearing_usd, origin_port, destination_port, shipping_type, expected_berth, highlights, reservation_ref, reservation_status".split(", ");
const ROWS = [HEADER, ["JW-013", "Mercedes-Benz", "GLC 43", "2018", "AMG Coupe", "White", "Red", "45000", "in_stock", "59,900,000", "Lagos", "", "", "", "", "", "", "", "", "", "", "", "available"]];
const settings = { fxRateNgnPerUsd: 1500, marginPct: 0.1, depositPctInStock: 0.3, depositPctPreOrder: 0.5, holdHoursInStock: 48, doorstepDeliveryNgn: 0, discountPct: 0.015, discountMinNgn: 200_000, discountMaxNgn: 2_000_000 };
const MARKET = [sheets.MARKET_HEADERS, ["Mercedes-Benz", "GLC 43", 2018, "foreign_used", "52,000,000", "68,000,000", 9, "https://jiji.ng/glc", "2026-11-10"]];

/** One call to each tool, with arguments that reach its normal path. */
const CALLS: Record<string, Record<string, unknown>> = {
  search_inventory: { query: "glc 43" },
  create_reservation: { car_id: "JW-013", customer_name: "Ada", customer_email: "ada@example.com" },
  confirm_reservation: { reference: "JW-013-1700000000000" },
  compare_market_price: { car_id: "JW-013" },
  request_photos: { car_id: "JW-013" },
  request_callback: { reason: "viewing", car_id: "JW-013", note: "Saturday" },
};

let url: URL;
let server: ReturnType<typeof app.listen>;
let client: Client | undefined;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  url = new URL(ROUTES.MCP, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MCP_AUTH_TOKEN", TOKEN);
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  vi.mocked(sheets.loadSheet).mockResolvedValue({ ...sheets.parseInventory(ROWS), settings });
  vi.mocked(sheets.loadPhotos).mockResolvedValue([]);
  vi.mocked(sheets.loadMarket).mockResolvedValue(sheets.parseMarket(MARKET));
  vi.mocked(paystack.initializeTransaction).mockResolvedValue({ ok: true, payment_url: "https://checkout.paystack.com/test" });
  vi.mocked(paystack.verifyTransaction).mockResolvedValue({
    found: true,
    status: "success",
    amountNgn: 17_970_000,
    paidAt: "2026-11-16T10:00:00.000Z",
    customerEmail: "ada@example.com",
    metadata: { car_id: "JW-013", deposit_ngn: 17_970_000 },
  });
  vi.mocked(alerts.sendAlert).mockResolvedValue(true);
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Connects a real MCP client. `token` null sends no Authorization header. Records each HTTP status. */
async function connect(token: string | null, statuses: number[] = []) {
  client = new Client({ name: "contract-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: token === null ? {} : { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      statuses.push(res.status);
      return res;
    },
  });
  await client.connect(transport);
  return client;
}

describe("MCP contract", () => {
  it("lists every tool by name", async () => {
    const mcp = await connect(TOKEN);
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("has a test call for every listed tool", async () => {
    const mcp = await connect(TOKEN);
    const { tools } = await mcp.listTools();
    expect(Object.keys(CALLS).sort()).toEqual(tools.map((tool) => tool.name).sort());
  });

  it.each(Object.entries(CALLS))("%s returns JSON with a status field", async (name, args) => {
    const mcp = await connect(TOKEN);
    const result = await mcp.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();

    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text);
    expect(typeof parsed.status).toBe("string");
    expect(parsed.status).not.toMatch(/^(error|service_unavailable)$/);
    expect(result.structuredContent).toEqual(parsed);
  });

  it("a missing token is refused with 401", async () => {
    const statuses: number[] = [];
    await expect(connect(null, statuses)).rejects.toMatchObject({ code: 401 });
    expect(statuses).toEqual([401]);
  });

  it("a wrong token is refused with 401", async () => {
    const statuses: number[] = [];
    await expect(connect("not-the-token", statuses)).rejects.toMatchObject({ code: 401 });
    expect(statuses).toEqual([401]);
  });

  it("no token is configured on the server: everything is refused with 401", async () => {
    vi.stubEnv("MCP_AUTH_TOKEN", "");
    await expect(connect(TOKEN)).rejects.toMatchObject({ code: 401 });
  });
});

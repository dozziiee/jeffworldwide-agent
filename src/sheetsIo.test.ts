// Tests for the sheet access layer against a fake Google: one batchGet, caching, cache clearing
// on writes, retry, and never creating a tab because a read failed.

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailable } from "./http";
import { appendLog, appendRequest, loadData, loadSheet, resetSheetsState, warmUp, writeReservation } from "./sheets";

const INVENTORY = [
  ["car_id", "make", "model", "year", "status", "price_ngn", "reservation_ref", "reservation_status"],
  ["JW-001", "Honda", "Accord", "2020", "in_stock", "30,900,000", "", "available"],
];
const SETTINGS = [
  ["setting", "value"],
  ["fx_rate_ngn_per_usd", "1500"],
  ["margin_pct", "10%"],
  ["deposit_pct_in_stock", "10%"],
  ["deposit_pct_pre_order", "40%"],
  ["hold_hours_in_stock", "72"],
  ["doorstep_delivery_ngn", "100000"],
  ["max_discount_ngn", "500000"],
];
const PHOTOS = [
  ["make", "model", "photo_url", "page_url", "author", "licence"],
  ["Honda", "Accord", "https://upload.wikimedia.org/x.jpg", "https://commons.wikimedia.org/wiki/File:x.jpg", "Jane", "CC0"],
];
const MARKET = [["make", "model", "year", "condition", "low_ngn", "high_ngn", "listings_count", "source_url", "collected_on"]];
const TAB_ROWS: Record<string, unknown[][]> = { Inventory: INVENTORY, Settings: SETTINGS, Photos: PHOTOS, Market: MARKET };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const googleError = (status: number, message: string) => json({ error: { code: status, message } }, status);

/** A fake Google. `fail` lets a test make the next matching calls fail. */
type Call = { method: string; url: string; path: string; body: any };
let calls: Call[];
let existingTabs: Set<string>;
let fail: (call: Call) => Response | Error | undefined;

function fakeGoogle(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    calls.push({ method: "POST", url, path: "token", body: null });
    return Promise.resolve(json({ access_token: "token-1", expires_in: 3600 }));
  }
  const path = decodeURIComponent(url.split("/spreadsheets/SHEET")[1] ?? url);
  const call: Call = { method: init.method ?? "GET", url, path, body: init.body ? JSON.parse(init.body) : null };
  calls.push(call);

  const failure = fail(call);
  if (failure instanceof Error) return Promise.reject(failure);
  if (failure) return Promise.resolve(failure);

  if (path.startsWith("/values:batchGet")) {
    const ranges = [...path.matchAll(/ranges=([^&]+)/g)].map((m) => m[1]);
    const missing = ranges.find((r) => !existingTabs.has(r));
    if (missing) return Promise.resolve(googleError(400, `Unable to parse range: ${missing}`));
    return Promise.resolve(json({ valueRanges: ranges.map((r) => ({ range: r, values: TAB_ROWS[r] ?? [] })) }));
  }
  if (path.startsWith(":batchUpdate")) {
    for (const request of call.body.requests) if (request.addSheet) existingTabs.add(request.addSheet.properties.title);
    return Promise.resolve(json({}));
  }
  const tab = path.match(/^\/values\/([^!:?]+)/)?.[1];
  if (tab && !existingTabs.has(tab)) return Promise.resolve(googleError(400, `Unable to parse range: ${tab}!A1`));
  return Promise.resolve(json({}));
}

const batchGets = () => calls.filter((c) => c.path.startsWith("/values:batchGet"));
const tabsRead = () => batchGets().map((c) => [...c.path.matchAll(/ranges=([^&]+)/g)].map((m) => m[1]).join("+"));
const tabsCreated = () => calls.filter((c) => c.path.startsWith(":batchUpdate")).flatMap((c) => c.body.requests.map((r: any) => r.addSheet?.properties.title));
const tokenRequests = () => calls.filter((c) => c.path === "token").length;

let privateKey: string;
beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

beforeEach(() => {
  calls = [];
  existingTabs = new Set(["Inventory", "Settings", "Photos", "Market", "Logs", "Requests"]);
  fail = () => undefined;
  resetSheetsState();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(fakeGoogle));
  vi.stubEnv("GOOGLE_SHEET_ID", "SHEET");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "bot@example.iam.gserviceaccount.com");
  vi.stubEnv("GOOGLE_PRIVATE_KEY", privateKey.replace(/\n/g, "\\n"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("one request per tool call", () => {
  it("reads every tab a tool needs in a single batchGet", async () => {
    const data = await loadData(["Photos"]);
    expect(tabsRead()).toEqual(["Inventory+Settings+Photos"]);
    expect(data.sheet.cars).toHaveLength(1);
    expect(data.sheet.settings.maxDiscountNgn).toBe(500_000);
    expect(data.photos).toHaveLength(1);
  });

  it("signs in to Google once and reuses the token across calls", async () => {
    await loadData(["Photos"]);
    advance(20_000);
    await loadData(["Market"]);
    await appendLog(["row"]);
    expect(tokenRequests()).toBe(1);
  });

  it("concurrent first calls share one sign-in", async () => {
    await Promise.all([loadSheet(), loadData(["Photos"]), loadData(["Market"])]);
    expect(tokenRequests()).toBe(1);
  });

  it("warmUp loads all four cached tabs in one request, so the next search needs none", async () => {
    await warmUp();
    expect(tabsRead()).toEqual(["Inventory+Settings+Market+Photos"]);
    await loadData(["Photos"]);
    expect(batchGets()).toHaveLength(1);
  });
});

describe("cache", () => {
  it("serves repeat reads from memory", async () => {
    await loadData(["Photos"]);
    advance(14_000);
    await loadData(["Photos"]);
    await loadSheet();
    expect(batchGets()).toHaveLength(1);
  });

  it("re-reads Inventory and Settings after 15 seconds, but keeps Photos for 10 minutes", async () => {
    await loadData(["Photos"]);
    advance(15_000);
    await loadData(["Photos"]);
    expect(tabsRead()).toEqual(["Inventory+Settings+Photos", "Inventory+Settings"]);

    advance(10 * 60_000 - 15_000);
    await loadData(["Photos"]);
    expect(tabsRead()[2]).toBe("Inventory+Settings+Photos");
  });

  it("caches Market for 15 seconds", async () => {
    await loadData(["Market"]);
    await loadData(["Market"]);
    expect(batchGets()).toHaveLength(1);
    advance(15_000);
    await loadData(["Market"]);
    expect(tabsRead()[1]).toBe("Inventory+Settings+Market");
  });

  it("fresh: true re-reads Inventory even inside the 15 seconds", async () => {
    await loadSheet();
    await loadSheet({ fresh: true });
    expect(tabsRead()).toEqual(["Inventory+Settings", "Inventory"]);
  });
});

describe("writes clear the Inventory cache", () => {
  it("a reservation write clears it immediately", async () => {
    const sheet = await loadSheet();
    await writeReservation(sheet, sheet.cars[0], { reservation_ref: "JW-001-1", reservation_status: "pending_payment" });
    await loadSheet();
    // Only Inventory is fetched again: Settings is still fresh.
    expect(tabsRead()).toEqual(["Inventory+Settings", "Inventory"]);
  });

  it("is cleared even when the write itself fails", async () => {
    const sheet = await loadSheet();
    fail = (call) => (call.path.startsWith("/values:batchUpdate") ? googleError(403, "The caller does not have permission") : undefined);
    await expect(writeReservation(sheet, sheet.cars[0], { reservation_status: "payment_review", review_until: "2026-11-17T10:00:00Z" })).rejects.toThrow();
    fail = () => undefined;
    await loadSheet();
    expect(batchGets()).toHaveLength(2);
  });

  it("a callback or photo request clears it too; a log row does not", async () => {
    await loadSheet();
    await appendLog(["log row"]);
    await loadSheet();
    expect(batchGets()).toHaveLength(1);

    await appendRequest(["request row"]);
    await loadSheet();
    expect(tabsRead()).toEqual(["Inventory+Settings", "Inventory"]);
  });
});

describe("retry", () => {
  const failTimes = (times: number, failure: () => Response | Error, match = (c: Call) => c.path.startsWith("/values:batchGet")) => {
    let left = times;
    fail = (call) => (match(call) && left-- > 0 ? failure() : undefined);
  };

  it("retries once after a 5xx and then succeeds", async () => {
    failTimes(1, () => googleError(503, "The service is currently unavailable"));
    expect((await loadSheet()).cars).toHaveLength(1);
    expect(batchGets()).toHaveLength(2);
  });

  it("retries once after a timeout and then succeeds", async () => {
    failTimes(1, () => new Error("The operation was aborted due to timeout"));
    expect((await loadSheet()).cars).toHaveLength(1);
    expect(batchGets()).toHaveLength(2);
  });

  it("gives up after the second failure: service unavailable, two attempts and no more", async () => {
    failTimes(5, () => googleError(500, "Internal error"));
    await expect(loadSheet()).rejects.toBeInstanceOf(ServiceUnavailable);
    expect(batchGets()).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    failTimes(5, () => googleError(403, "The caller does not have permission"));
    await expect(loadSheet()).rejects.toBeInstanceOf(ServiceUnavailable);
    expect(batchGets()).toHaveLength(1);
  });

  it("does not repeat an append after a timeout, so a row is never written twice", async () => {
    const isAppend = (c: Call) => c.path.includes(":append");
    failTimes(5, () => new Error("The operation was aborted due to timeout"), isAppend);
    await expect(appendLog(["row"])).rejects.toBeInstanceOf(ServiceUnavailable);
    expect(calls.filter(isAppend)).toHaveLength(1);
  });
});

describe("a tab is never created because a read failed", () => {
  it("timeouts and 5xx on a read create nothing", async () => {
    fail = (call) => (call.path.startsWith("/values:batchGet") ? new Error("The operation was aborted due to timeout") : undefined);
    await expect(loadData(["Photos"])).rejects.toBeInstanceOf(ServiceUnavailable);
    fail = (call) => (call.path.startsWith("/values:batchGet") ? googleError(503, "Backend error") : undefined);
    await expect(loadData(["Market"])).rejects.toBeInstanceOf(ServiceUnavailable);
    expect(tabsCreated()).toEqual([]);
  });

  it("permission and other 4xx errors on a read create nothing", async () => {
    fail = (call) => (call.path.startsWith("/values:batchGet") ? googleError(403, "The caller does not have permission") : undefined);
    await expect(loadData(["Photos"])).rejects.toBeInstanceOf(ServiceUnavailable);
    fail = (call) => (call.path.startsWith("/values:batchGet") ? googleError(400, "Invalid value at 'ranges'") : undefined);
    await expect(loadData(["Photos"])).rejects.toBeInstanceOf(ServiceUnavailable);
    expect(tabsCreated()).toEqual([]);
  });

  it("creates Photos only when Google explicitly says it does not exist, and still returns the other tabs", async () => {
    existingTabs.delete("Photos");
    const data = await loadData(["Photos"]);
    expect(tabsCreated()).toEqual(["Photos"]);
    expect(calls.find((c) => c.method === "PUT" && c.path.startsWith("/values/Photos!A1"))?.body.values[0]).toEqual(PHOTOS[0]);
    expect(data.photos).toEqual([]);
    expect(data.sheet.cars).toHaveLength(1);
  });

  it("never creates Inventory or Settings, even if Google says they do not exist", async () => {
    existingTabs.delete("Inventory");
    await expect(loadSheet()).rejects.toBeInstanceOf(ServiceUnavailable);
    expect(tabsCreated()).toEqual([]);
  });

  it("appending to Logs: an error creates nothing; a missing tab is created and the row appended", async () => {
    const isAppend = (c: Call) => c.path.includes(":append");
    fail = (call) => (isAppend(call) ? googleError(500, "Internal error") : undefined);
    await expect(appendLog(["row"])).rejects.toBeInstanceOf(ServiceUnavailable);
    expect(tabsCreated()).toEqual([]);

    fail = () => undefined;
    existingTabs.delete("Logs");
    await appendLog(["row"]);
    expect(tabsCreated()).toEqual(["Logs"]);
    expect(calls.filter(isAppend).at(-1)?.body.values).toEqual([["row"]]);
  });
});

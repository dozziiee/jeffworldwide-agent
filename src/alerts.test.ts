import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAlert } from "./alerts";

const alert = { reason: "test alert", car_id: "JW-013", title: "2018 Mercedes-Benz GLC 43", reference: "JW-013-1", note: "hello", timestamp_utc: "2026-11-15T10:00:00.000Z" };
const HOOK = "https://hooks.zapier.com/hooks/catch/123/abc/";

describe("sendAlert", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("POSTs the request as JSON to ZAPIER_HOOK_URL with a 5-second timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ZAPIER_HOOK_URL", HOOK);
    const timeout = vi.spyOn(AbortSignal, "timeout");

    expect(await sendAlert(alert)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(HOOK);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(alert);
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("variable missing: warns, sends nothing, does not throw", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ZAPIER_HOOK_URL", "");
    expect(await sendAlert(alert)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("ZAPIER_HOOK_URL is not set");
  });

  it("POST rejected by the webhook: warns and returns false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    vi.stubEnv("ZAPIER_HOOK_URL", HOOK);
    expect(await sendAlert(alert)).toBe(false);
    expect(warn.mock.calls[0][0]).toContain("HTTP 500");
  });

  it("network error or timeout: warns and returns false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation timed out")));
    vi.stubEnv("ZAPIER_HOOK_URL", HOOK);
    expect(await sendAlert(alert)).toBe(false);
    expect(warn.mock.calls[0][0]).toContain("timed out");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertLine, sendAlert } from "./alerts";

const alert = {
  reason: "payment dispute",
  car_id: "JW-091",
  title: "2021 Toyota Highlander XSE AWD",
  reference: "JW-091-1794755450557",
  note: "Buyer says they paid",
  timestamp_utc: "2026-11-15T10:00:00.000Z",
};
const LINE = "Active Desk | payment dispute | 2021 Toyota Highlander XSE AWD (JW-091) | Ref JW-091-1794755450557 | Buyer says they paid";

// Stand-ins for Twilio's replies.
const accepted = () => new Response(JSON.stringify({ sid: "SM123", status: "queued", error_code: null }), { status: 201 });
const rejected = (code: number, message: string, status = 400) => new Response(JSON.stringify({ code, message, status }), { status });

describe("alertLine", () => {
  it("builds the full line", () => {
    expect(alertLine(alert)).toBe(LINE);
  });

  it("omits empty parts", () => {
    const empty = { ...alert, car_id: "", title: "", reference: "", note: "" };
    expect(alertLine({ ...empty, reason: "test alert" })).toBe("Active Desk | test alert");
    expect(alertLine({ ...empty, reason: "refund", note: "call after 5pm" })).toBe("Active Desk | refund | call after 5pm");
    expect(alertLine({ ...alert, reference: "", note: "" })).toBe("Active Desk | payment dispute | 2021 Toyota Highlander XSE AWD (JW-091)");
    expect(alertLine({ ...empty, reason: "viewing", car_id: "JW-999" })).toBe("Active Desk | viewing | JW-999");
    expect(alertLine({ ...empty, reason: "viewing", reference: "JW-091-1" })).toBe("Active Desk | viewing | Ref JW-091-1");
  });

  it("has no line breaks and is at most 250 characters", () => {
    const line = alertLine({ ...alert, note: `first line\nsecond\r\n\tthird   line ${"x".repeat(400)}` });
    expect(line).not.toMatch(/[\r\n\t]/);
    expect(line).toContain("| first line second third line xxx");
    expect(line).toHaveLength(250);
    expect(line.endsWith("…")).toBe(true);
    expect(alertLine(alert).length).toBeLessThanOrEqual(250);
  });
});

describe("sendAlert", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const params = (call: number) => new URLSearchParams(fetchMock.mock.calls[call][1].body);
  const warnings = () => warn.mock.calls.flat().join("\n");

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secret-token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155550001");
    vi.stubEnv("ALERT_WHATSAPP_TO", "+2348000000002"); // no prefix: it is added
    vi.stubEnv("TWILIO_CONTENT_SID", "HXtemplate");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends the template with ContentSid and ContentVariables when TWILIO_CONTENT_SID is set", async () => {
    fetchMock.mockResolvedValue(accepted());
    const timeout = vi.spyOn(AbortSignal, "timeout");

    expect(await sendAlert(alert)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("ACtest:secret-token").toString("base64")}`);
    expect(Object.fromEntries(params(0))).toEqual({
      From: "whatsapp:+14155550001",
      To: "whatsapp:+2348000000002",
      ContentSid: "HXtemplate",
      ContentVariables: JSON.stringify({ "1": LINE }),
    });
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(log.mock.calls[0][0]).toMatch(/sent via template \(ContentSid\): HTTP 201, status queued, sid SM123/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends a plain Body message when TWILIO_CONTENT_SID is not set", async () => {
    vi.stubEnv("TWILIO_CONTENT_SID", "");
    fetchMock.mockResolvedValue(accepted());
    expect(await sendAlert(alert)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(params(0))).toEqual({ From: "whatsapp:+14155550001", To: "whatsapp:+2348000000002", Body: LINE });
    expect(log.mock.calls[0][0]).toContain("sent via plain Body");
  });

  it("retries once as a plain Body message when Twilio rejects the template", async () => {
    fetchMock.mockResolvedValueOnce(rejected(21656, "The ContentVariables parameter is invalid")).mockResolvedValueOnce(accepted());
    const timeout = vi.spyOn(AbortSignal, "timeout");

    expect(await sendAlert(alert)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(params(0).has("ContentSid")).toBe(true);
    expect(params(1).get("Body")).toBe(LINE);
    expect(params(1).has("ContentSid")).toBe(false);
    expect(timeout).toHaveBeenCalledTimes(2); // 5 seconds for each attempt
    expect(warnings()).toContain("template (ContentSid) send rejected: HTTP 400, Twilio error 21656");
    expect(log.mock.calls[0][0]).toContain("sent via plain Body");
  });

  it("also falls back to plain Body when the template attempt times out", async () => {
    fetchMock.mockRejectedValueOnce(new Error("The operation timed out")).mockResolvedValueOnce(accepted());
    expect(await sendAlert(alert)).toBe(true);
    expect(params(1).get("Body")).toBe(LINE);
  });

  it("both sends fail: warns with Twilio's error codes, returns false, never throws", async () => {
    fetchMock
      .mockResolvedValueOnce(rejected(21656, "The ContentVariables parameter is invalid"))
      .mockResolvedValueOnce(rejected(63016, "Failed to send freeform message because you are outside the allowed window"));
    expect(await sendAlert(alert)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toContain("Twilio error 21656");
    expect(warnings()).toContain("Twilio error 63016");
    expect(warnings()).toContain("every attempt failed");
  });

  it("network errors on both attempts: returns false, never throws", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    expect(await sendAlert(alert)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toContain("fetch failed");
  });

  it.each(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "ALERT_WHATSAPP_TO"])("missing %s: warns and sends nothing", async (name) => {
    vi.stubEnv(name, "");
    expect(await sendAlert(alert)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings()).toContain(`missing ${name}`);
  });

  it("never logs the auth token or the phone numbers", async () => {
    fetchMock.mockResolvedValueOnce(rejected(20003, "Authenticate", 401)).mockResolvedValueOnce(accepted());
    await sendAlert(alert);
    const logged = [...warn.mock.calls, ...log.mock.calls].flat().join("\n");
    expect(logged).not.toMatch(/secret-token|14155550001|2348000000002/);
  });
});

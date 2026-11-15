// Team alert: sends a one-line WhatsApp message through Twilio. Best effort; it never throws.

import { HEADERS } from "./config/constants";

const ALERT_TIMEOUT_MS = 5_000;
const MAX_LENGTH = 250;

export type Alert = {
  reason: string;
  car_id: string;
  title: string;
  reference: string;
  note: string;
  timestamp_utc: string;
};

/**
 * "Active Desk | {reason} | {title} ({car_id}) | Ref {reference} | {note}"
 * Empty parts are left out. One line, at most 250 characters.
 */
export function alertLine(alert: Alert): string {
  const clean = (text: string) => String(text ?? "").replace(/\s+/g, " ").trim();
  const [reason, title, carId, reference, note] = [alert.reason, alert.title, alert.car_id, alert.reference, alert.note].map(clean);
  const car = title && carId ? `${title} (${carId})` : title || carId;
  const line = ["Active Desk", reason, car, reference && `Ref ${reference}`, note].filter(Boolean).join(" | ");
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1).trimEnd()}…` : line;
}

/** WhatsApp addresses must carry the "whatsapp:" prefix. */
const whatsapp = (address: string) => (address.startsWith("whatsapp:") ? address : `whatsapp:${address}`);

/**
 * Sends the alert. With TWILIO_CONTENT_SID set it tries the approved template first, then falls
 * back to a plain text message. Returns true if Twilio accepted a message; problems are logged
 * as warnings (with Twilio's error code) and never raised.
 */
export async function sendAlert(alert: Alert): Promise<boolean> {
  const env = process.env;
  const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "ALERT_WHATSAPP_TO"];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) {
    console.warn(`[whatsapp] alert not sent: missing ${missing.join(", ")}`);
    return false;
  }

  const line = alertLine(alert);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`;
  const address = { From: whatsapp(env.TWILIO_WHATSAPP_FROM!), To: whatsapp(env.ALERT_WHATSAPP_TO!) };

  // Template first when one is configured; a plain message is the fallback, or the only attempt.
  const attempts: { path: string; content: Record<string, string> }[] = [];
  if (env.TWILIO_CONTENT_SID) {
    attempts.push({
      path: "template (ContentSid)",
      content: { ContentSid: env.TWILIO_CONTENT_SID, ContentVariables: JSON.stringify({ "1": line }) },
    });
  }
  attempts.push({ path: "plain Body", content: { Body: line } });

  for (const { path, content } of attempts) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { [HEADERS.AUTHORIZATION]: authorization, [HEADERS.CONTENT_TYPE]: "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...address, ...content }),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`[whatsapp] alert sent via ${path}: HTTP ${res.status}, status ${body.status ?? "unknown"}, sid ${body.sid ?? "unknown"}`);
        return true;
      }
      console.warn(`[whatsapp] ${path} send rejected: HTTP ${res.status}, Twilio error ${body.code ?? "unknown"}: ${body.message ?? "no message"}`);
    } catch (err) {
      console.warn(`[whatsapp] ${path} send failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.warn("[whatsapp] alert not sent: every attempt failed");
  return false;
}

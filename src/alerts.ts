// Team alert: POSTs a request to a Zapier webhook. Best effort; it never throws.

const ALERT_TIMEOUT_MS = 5_000;

export type Alert = {
  reason: string;
  car_id: string;
  title: string;
  reference: string;
  note: string;
  timestamp_utc: string;
};

/** Returns true if the webhook accepted the alert. Problems are logged as warnings, never raised. */
export async function sendAlert(alert: Alert): Promise<boolean> {
  const url = process.env.ZAPIER_HOOK_URL;
  if (!url) {
    console.warn("[zapier] ZAPIER_HOOK_URL is not set; alert not sent");
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (res.ok) console.log(`[zapier] alert sent, HTTP ${res.status}`);
    else console.warn(`[zapier] alert failed, HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn(`[zapier] alert failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

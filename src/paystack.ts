// Minimal Paystack client: initialize a transaction and verify one.

import { requestJson, requireEnv } from "./http";

const API = "https://api.paystack.co";

export type ReservationMetadata = {
  car_id: string;
  customer_name: string;
  price_ngn: number;
  deposit_ngn: number;
  stock_type: string;
};

function headers() {
  return { authorization: `Bearer ${requireEnv("PAYSTACK_SECRET_KEY")}`, "content-type": "application/json" };
}

export type InitResult = { ok: true; payment_url: string } | { ok: false; message: string };

export async function initializeTransaction(input: {
  email: string;
  amountNgn: number;
  reference: string;
  metadata: ReservationMetadata;
}): Promise<InitResult> {
  const res = await requestJson("Paystack", `${API}/transaction/initialize`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email: input.email,
      amount: input.amountNgn * 100, // kobo
      reference: input.reference,
      metadata: input.metadata,
    }),
  });
  const url = res.body?.data?.authorization_url;
  if (!res.ok || !res.body?.status || !url) {
    return { ok: false, message: res.body?.message ?? `Paystack returned HTTP ${res.status}` };
  }
  return { ok: true, payment_url: url };
}

export type VerifyResult =
  | { found: false }
  | { found: true; status: string; amountNgn: number; paidAt: string | null; metadata: Partial<ReservationMetadata> };

export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  const res = await requestJson("Paystack", `${API}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: headers(),
  });
  if (res.status === 400 || res.status === 404) return { found: false };
  if (!res.ok || !res.body?.data) throw new Error(`Paystack verify failed: ${res.body?.message ?? res.status}`);

  const data = res.body.data;
  let metadata = data.metadata ?? {};
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = {};
    }
  }
  return {
    found: true,
    status: String(data.status),
    amountNgn: Number(data.amount) / 100,
    paidAt: data.paid_at ?? null,
    metadata: metadata ?? {},
  };
}

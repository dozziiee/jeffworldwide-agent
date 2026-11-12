// Shared fetch wrapper: 10-second timeout, and one error type for "upstream is down".

export class ServiceUnavailable extends Error {}

export const TIMEOUT_MS = 10_000;

export type HttpResult = { ok: boolean; status: number; body: any };

export async function requestJson(service: string, url: string, init: RequestInit = {}): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ServiceUnavailable(`${service} is unreachable or timed out`);
  }
  if (res.status >= 500) throw new ServiceUnavailable(`${service} returned HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ServiceUnavailable(`Server is missing the ${name} environment variable`);
  return value;
}

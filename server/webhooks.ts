import { createHmac } from "node:crypto";

/**
 * Signed webhook delivery.
 *
 * Each POST carries:
 *   X-OpenCharts-Timestamp   Unix seconds
 *   X-OpenCharts-Signature   sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the shared secret>
 *   X-OpenCharts-Delivery    "<symbol>:<timeframe>:<bar time>", the same on every retry
 *
 * Receivers should recompute the signature, compare it in constant time, and
 * reject timestamps more than a few minutes old.
 */

export const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const TIMEOUT_MS = 10_000;

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface DeliveryResult {
  host: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  /** Waits between attempts: one retry per entry. Default 3 retries. */
  retryDelaysMs?: number[];
  nowMs?: () => number;
}

/** POST `body` to `url`, retrying on network errors and non-2xx answers. */
export async function deliverWebhook(
  url: string,
  body: string,
  secret: string,
  deliveryId: string,
  options: DeliverOptions = {},
): Promise<DeliveryResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const now = options.nowMs ?? Date.now;
  const host = new URL(url).host;
  let error = "";
  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    // Signed per attempt, so a retry after a long wait still has a fresh timestamp.
    const timestamp = Math.floor(now() / 1000);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencharts-timestamp": String(timestamp),
          "x-opencharts-signature": signWebhook(secret, timestamp, body),
          "x-opencharts-delivery": deliveryId,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { host, ok: true, attempts: attempt };
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const wait = delays[attempt - 1];
    if (wait != null) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return { host, ok: false, attempts: delays.length + 1, error };
}

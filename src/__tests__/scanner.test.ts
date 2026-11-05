// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MarketData } from "../../server/alpaca.ts";
import { DEFAULT_CONFIG, type OpenChartsConfig } from "../../server/config.ts";
import { MACRO_EVENTS, newYorkDate, upcomingEvents } from "../../server/events.ts";
import { createScanner, handoffText } from "../../server/scanner.ts";
import { openStore } from "../../server/store.ts";
import { deliverWebhook, signWebhook } from "../../server/webhooks.ts";
import type { Candle } from "../services/schemas.ts";

const DAY = 86_400;
const TODAY = Date.parse("2026-11-05T00:00:00Z") / 1000;
const SECRET = "s".repeat(40);

/** 260 daily BTC bars; the last one, yesterday's, is a volume breakout (a BUY). */
function bars(): Candle[] {
  const n = 260;
  const out = Array.from({ length: n }, (_, i) => {
    const close = 100 + i * 0.2 + Math.sin(i / 2) * 0.6;
    const range = i >= n - 80 && i < n - 60 ? 6 : 0.5;
    return {
      time: TODAY - (n - i) * DAY,
      open: close,
      high: close + range,
      low: close - range,
      close,
      volume: 1000,
    };
  });
  const last = out[n - 1]!;
  out[n - 1] = { ...last, close: last.close + 8, high: last.close + 8.2, volume: 2000 };
  return out;
}

const marketData = {
  getBars: async ({ limit = 500 }) => bars().slice(-limit),
} as MarketData;

const config: OpenChartsConfig = {
  ...DEFAULT_CONFIG,
  watchlist: { stocks: [], crypto: ["BTC/USD"] },
};

function setup(nowMs: number, fetchImpl?: typeof fetch) {
  const store = openStore(":memory:");
  const logs: string[] = [];
  const scanner = createScanner({
    config,
    marketData,
    store,
    webhooks: fetchImpl
      ? { urls: ["https://hooks.example.com/desk?token=abc"], secret: SECRET }
      : null,
    deliver: { fetchImpl, retryDelaysMs: [0, 0, 0] },
    now: () => nowMs,
    log: (m) => logs.push(m),
  });
  return { store, scanner, logs };
}

/** A fetch that fails `failures` times, then answers 200, recording each request. */
function fakeFetch(failures: number) {
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response(null, { status: calls.length <= failures ? 500 : 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("signal scanner", () => {
  it("waits for the bar to settle before reading it", async () => {
    const { scanner, store } = setup((TODAY + 5 * 60) * 1000); // 00:05 UTC, inside the 10 min settle
    expect(await scanner.scanOnce()).toEqual([]);
    expect(store.listSignals()).toEqual([]);
  });

  it("records a new signal once, and skips webhooks for unapproved tickers", async () => {
    const { impl, calls } = fakeFetch(0);
    const { scanner, store } = setup((TODAY + 20 * 60) * 1000, impl);
    const found = await scanner.scanOnce();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ symbol: "BTC/USD", signal: "BUY", barTime: TODAY - DAY });
    expect(store.listSignals()[0]!.webhook).toBe("not approved");
    expect(calls).toHaveLength(0);
    expect(await scanner.scanOnce()).toEqual([]); // same bar: no second record
  });

  it("sends a signed HANDOFF webhook for an approved ticker, retrying failures", async () => {
    const now = (TODAY + 20 * 60) * 1000;
    const { impl, calls } = fakeFetch(2);
    const { scanner, store } = setup(now, impl);
    store.setApproval("BTC/USD", now + DAY * 1000, now);
    await scanner.scanOnce();

    expect(calls).toHaveLength(3);
    const { headers, body } = calls[2]!;
    const ts = Number(headers["x-opencharts-timestamp"]);
    expect(headers["x-opencharts-signature"]).toBe(signWebhook(SECRET, ts, body));
    expect(headers["x-opencharts-delivery"]).toBe(`BTC/USD:1d:${TODAY - DAY}`);
    const payload = JSON.parse(body) as { text: string; ticker: string };
    expect(payload.ticker).toBe("BTC/USD");
    expect(payload.text.split(" | ")).toHaveLength(4);
    expect(payload.text).toMatch(/^BTC\/USD \| BUY: 1d close broke the 20-bar high \| /);

    const saved = store.listSignals()[0]!;
    expect(saved.webhook).toBe("sent");
    expect(saved.deliveries).toEqual([{ host: "hooks.example.com", ok: true, attempts: 3 }]);
    expect(JSON.stringify(saved)).not.toContain("token=abc");
  });

  it("marks the signal failed after 3 retries", async () => {
    const now = (TODAY + 20 * 60) * 1000;
    const { impl, calls } = fakeFetch(10);
    const { scanner, store, logs } = setup(now, impl);
    store.setApproval("BTC/USD", now + DAY * 1000, now);
    await scanner.scanOnce();
    expect(calls).toHaveLength(4);
    expect(store.listSignals()[0]).toMatchObject({ webhook: "failed" });
    expect(logs.some((l) => l.includes("failed after 4 tries"))).toBe(true);
  });
});

describe("webhooks", () => {
  it("reports network errors without throwing", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await deliverWebhook("http://127.0.0.1:9/x", "{}", SECRET, "id", {
      fetchImpl: impl,
      retryDelaysMs: [],
    });
    expect(r).toEqual({ host: "127.0.0.1:9", ok: false, attempts: 1, error: "ECONNREFUSED" });
  });

  it("formats SELL handoffs without a stop", () => {
    const text = handoffText({
      symbol: "NVDA",
      timeframe: "1d",
      signal: "SELL",
      detail: {
        breakoutLookback: 20,
        close: 90,
        breakoutLevel: 95,
        volumeRatio: 2,
        rsi: 30,
        trend: "bearish",
        atr: 3,
      },
    });
    expect(text).toBe(
      "NVDA | SELL: 1d close broke the 20-bar low | close 90.00 vs 20-bar low 95.00, volume 2.0x its average, RSI 30.0, trend bearish, ATR 3.00 | Trader: exit or tighten the stop on any long; no shorts",
    );
  });
});

describe("macro events", () => {
  it("lists upcoming FOMC and CPI dates in order", () => {
    expect(upcomingEvents("2026-11-05", 34)).toEqual([
      { date: "2026-11-10", time: "08:30", kind: "CPI", title: "CPI for October 2026" },
      { date: "2026-12-09", time: "14:00", kind: "FOMC", title: "FOMC rate decision" },
    ]);
    const dates = MACRO_EVENTS.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    expect(newYorkDate(Date.parse("2026-11-06T03:00:00Z"))).toBe("2026-11-05");
  });
});

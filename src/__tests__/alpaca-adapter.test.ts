// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildBarsUrl,
  createAlpacaClient,
  parseBars,
  type MarketData,
} from "../../server/alpaca.ts";
import { createApp } from "../../server/app.ts";
import { DEFAULT_CONFIG } from "../../server/config.ts";
import { createAlpacaAdapter, parseSseChunk } from "../adapter/alpaca.ts";
import { runAdapterConformance } from "../adapter/conformance.ts";
import type { Candle } from "../services/schemas.ts";

const NOW = Date.parse("2026-11-05T15:00:00Z");

describe("buildBarsUrl", () => {
  it("asks for the latest bars newest-first from a wide enough start", () => {
    const url = buildBarsUrl({ symbol: "NVDA", timeframe: "1d", limit: 100 }, NOW)!;
    expect(url.pathname).toBe("/v2/stocks/NVDA/bars");
    expect(url.searchParams.get("timeframe")).toBe("1Day");
    expect(url.searchParams.get("feed")).toBe("iex");
    expect(url.searchParams.get("sort")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(Date.parse(url.searchParams.get("start")!)).toBeLessThan(NOW - 100 * 86_400_000);
  });

  it("treats toMs as exclusive and fromMs as an ascending start", () => {
    const url = buildBarsUrl(
      { symbol: "BTC/USD", timeframe: "1h", fromMs: NOW - 3_600_000, toMs: NOW },
      NOW,
    )!;
    expect(url.pathname).toBe("/v1beta3/crypto/us/bars");
    expect(url.searchParams.get("symbols")).toBe("BTC/USD");
    expect(url.searchParams.get("sort")).toBe("asc");
    expect(Date.parse(url.searchParams.get("end")!)).toBe(NOW - 1);
  });

  it("caps the limit and rejects unknown timeframes", () => {
    expect(
      buildBarsUrl({ symbol: "NVDA", timeframe: "1d", limit: 50_000 })!.searchParams.get("limit"),
    ).toBe("10000");
    expect(buildBarsUrl({ symbol: "NVDA", timeframe: "2d" })).toBeNull();
  });
});

describe("parseBars", () => {
  const bar = (t: string, c: number) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 10 });

  it("reads both response shapes and returns seconds, oldest first", () => {
    const stock = { bars: [bar("2026-11-04T05:00:00Z", 2), bar("2026-11-03T05:00:00Z", 1)] };
    expect(parseBars(stock, "NVDA").map((c) => c.close)).toEqual([1, 2]);
    expect(parseBars(stock, "NVDA")[0]!.time).toBe(Date.parse("2026-11-03T05:00:00Z") / 1000);

    const crypto = { bars: { "BTC/USD": [bar("2026-11-04T00:00:00Z", 5)] } };
    expect(parseBars(crypto, "BTC/USD")).toHaveLength(1);
  });

  it("returns nothing for an empty or null bar list", () => {
    expect(parseBars({ bars: null }, "NVDA")).toEqual([]);
    expect(parseBars({ bars: {} }, "BTC/USD")).toEqual([]);
  });
});

describe("getBars paging", () => {
  it("follows next_page_token until the requested count is reached", async () => {
    const bar = (i: number) => ({
      t: new Date(NOW - i * 60_000).toISOString(),
      o: 1,
      h: 1,
      l: 1,
      c: 1,
      v: 1,
    });
    const pages = [
      { bars: { "BTC/USD": [bar(1), bar(2)] }, next_page_token: "p2" },
      { bars: { "BTC/USD": [bar(3)] }, next_page_token: "p3" },
    ];
    const seen: string[] = [];
    const fetchImpl = (async (url: URL) => {
      seen.push(`${url.searchParams.get("page_token")}:${url.searchParams.get("limit")}`);
      return new Response(JSON.stringify(pages[seen.length - 1]));
    }) as unknown as typeof fetch;

    const candles = await createAlpacaClient({ fetchImpl }).getBars({
      symbol: "BTC/USD",
      timeframe: "1m",
      limit: 3,
    });
    expect(candles).toHaveLength(3);
    expect(candles.map((c) => c.time)).toEqual(
      [...candles.map((c) => c.time)].sort((a, b) => a - b),
    );
    expect(seen).toEqual(["null:3", "p2:3"]);
  });
});

describe("parseSseChunk", () => {
  it("returns complete events and keeps a partial one for the next read", () => {
    const { events, rest } = parseSseChunk(': ping\n\ndata: {"a":1}\n\ndata: {"b"');
    expect(events).toEqual(['{"a":1}']);
    expect(rest).toBe('data: {"b"');
  });
});

/** A stand-in for Alpaca: hourly bars over the last 30 days, and a tick every 50ms. */
function fakeMarketData(): MarketData {
  const end = Math.floor(Date.now() / 3_600_000) * 3_600;
  const all: Candle[] = Array.from({ length: 720 }, (_, i) => {
    const close = 100 + Math.sin(i / 10) * 5;
    return {
      time: end - (720 - i) * 3_600,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    };
  });
  return {
    getBars: async ({ limit = 500, fromMs, toMs }) => {
      const inWindow = all.filter(
        (c) =>
          (fromMs == null || c.time * 1000 >= fromMs) && (toMs == null || c.time * 1000 < toMs),
      );
      return fromMs != null ? inWindow.slice(0, limit) : inWindow.slice(-limit);
    },
    getQuote: async (symbol) => ({ symbol, bid: 100, ask: 100.05, timestamp: Date.now() }),
    streamQuotes: (symbols, onQuote) => {
      const id = setInterval(() => {
        onQuote({ symbol: symbols[0]!, bid: 100, ask: 100.05, timestamp: Date.now() });
      }, 50);
      return () => clearInterval(id);
    },
  };
}

let baseUrl = "";
const staticDir = mkdtempSync(join(tmpdir(), "oc-static-"));
writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>ok</title>");
const app = createApp({
  config: DEFAULT_CONFIG,
  marketData: fakeMarketData(),
  hasKeys: true,
  staticDir,
});

beforeAll(async () => {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => app.close());

describe("backend routes", () => {
  it("maps crypto pairs to terminal names and rejects unknown symbols", async () => {
    const symbols = (await (await fetch(`${baseUrl}/api/symbols`)).json()) as Array<{
      name: string;
    }>;
    expect(symbols.map((s) => s.name)).toContain("BTCUSD");
    expect(symbols.map((s) => s.name)).toContain("NVDA");

    const unknown = await fetch(`${baseUrl}/api/candles?symbol=NOPE&timeframe=1h`);
    expect(unknown.status).toBe(404);
    const badNumber = await fetch(`${baseUrl}/api/candles?symbol=NVDA&timeframe=1h&limit=abc`);
    expect(badNumber.status).toBe(400);
  });

  it("serves Desk Signal on closed bars", async () => {
    const res = await fetch(`${baseUrl}/api/desk-signal?symbol=NVDA&timeframe=1h&limit=5`);
    const body = (await res.json()) as { bars: Array<{ time: number; trend: string }> };
    expect(res.status).toBe(200);
    expect(body.bars).toHaveLength(5);
    expect(body.bars[4]!.time * 1000 + 3_600_000).toBeLessThanOrEqual(Date.now());
    expect(["bullish", "bearish", "neutral"]).toContain(body.bars[0]!.trend);
    expect((await fetch(`${baseUrl}/api/desk-signal?symbol=NVDA&timeframe=2h`)).status).toBe(400);
  });

  it("serves the frontend, with index.html as the fallback route", async () => {
    const res = await fetch(`${baseUrl}/some/client/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>ok</title>");
  });

  it("answers a malformed path with 400 instead of crashing", async () => {
    expect((await fetch(`${baseUrl}/%`)).status).toBe(400);
    // fetch normalizes "//%", so send it raw.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect((app.server.address() as AddressInfo).port, "127.0.0.1", () => {
        socket.write("GET //% HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 (400|404)/);
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
  });

  it("refuses to serve files outside the frontend folder", async () => {
    const res = await fetch(`${baseUrl}/..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(403);
  });
});

runAdapterConformance(
  "alpaca (via backend, fake upstream)",
  () => createAlpacaAdapter({ baseUrl }),
  {
    symbol: "NVDA",
    timeframe: "1h",
    tickTimeoutMs: 2_000,
  },
);

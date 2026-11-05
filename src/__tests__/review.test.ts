// @vitest-environment node
import { describe, expect, it } from "vitest";
import { roundTrips, summarize, windowStart } from "../../server/review.ts";

describe("go-live review", () => {
  it("pairs fills into flat-to-flat trades, averaging partial fills", () => {
    const { trades, open } = roundTrips([
      { symbol: "NVDA", side: "buy", qty: 6, price: 100, time: 1 },
      { symbol: "NVDA", side: "buy", qty: 4, price: 105, time: 2 },
      { symbol: "NVDA", side: "sell", qty: 5, price: 110, time: 3 },
      { symbol: "NVDA", side: "sell", qty: 5, price: 112, time: 4 },
      // Crypto symbols come in either form.
      { symbol: "BTC/USD", side: "buy", qty: 0.1, price: 60_000, time: 5 },
      { symbol: "BTCUSD", side: "sell", qty: 0.1, price: 57_000, time: 6 },
      // A sell with no buy in the window is ignored; an unsold buy stays open.
      { symbol: "AMD", side: "sell", qty: 3, price: 150, time: 7 },
      { symbol: "ETH/USD", side: "buy", qty: 1, price: 3_000, time: 8 },
    ]);
    expect(open).toEqual(["ETH/USD"]);
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({
      symbol: "NVDA",
      entry: 102,
      exit: 111,
      qty: 10,
      exitTime: 4,
    });
    expect(trades[0]!.returnPct).toBeCloseTo((111 / 102 - 1) * 100);
    expect(trades[1]!.returnPct).toBeCloseTo(-5);
  });

  it("summarizes like the backtest, compounding trades", () => {
    expect(summarize([{ returnPct: 10 }, { returnPct: -10 }])).toEqual({
      trades: 2,
      winRate: 0.5,
      avgReturnPct: 0,
      totalReturnPct: expect.closeTo(-1, 10),
    });
    expect(summarize([])).toEqual({
      trades: 0,
      winRate: 0,
      avgReturnPct: 0,
      totalReturnPct: 0,
    });
  });

  it("starts the backtest at the signal bar before the first fill", () => {
    const day = 86_400;
    const candles = [0, 1, 2, 3].map((d) => ({ time: d * day }));
    // A fill mid-way through bar 2: its BUY came at the close of bar 1.
    expect(windowStart(candles, (2 * day + 3600) * 1000, day)).toBe(1);
    expect(windowStart(candles, -1, day)).toBe(0);
    // A fill after the last bar ends (a weekend crypto fill against stock bars):
    // that bar's BUY enters after the fill, the one before would not.
    expect(
      windowStart(
        [0, 1].map((d) => ({ time: d * day })),
        3 * day * 1000,
        day,
      ),
    ).toBe(1);
  });
});

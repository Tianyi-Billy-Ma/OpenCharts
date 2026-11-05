import { describe, expect, it } from "vitest";
import { runBacktest } from "../../server/backtest.ts";
import type { DeskSignalBar } from "../lib/desk-signal.ts";
import type { CandleData } from "../lib/indicators.ts";

const bar = (
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
): CandleData => ({
  time: i * 86_400,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1,
});

const sig = (
  time: number,
  signal: DeskSignalBar["signal"] = null,
  swingLow: number | null = 95,
): DeskSignalBar => ({
  time,
  close: 0,
  trend: "neutral",
  signal,
  filtered: false,
  emas: [],
  rsi: null,
  atr: 2,
  swingHigh: null,
  swingLow,
});

describe("runBacktest", () => {
  it("enters at the next open and exits at the open after a SELL", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 101, 103, 100, 102),
      bar(2, 103, 106, 102, 105),
      bar(3, 107, 108, 106, 107),
    ];
    const signals = [sig(0, "BUY"), sig(1), sig(2, "SELL"), sig(3)];
    const r = runBacktest(candles, signals);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({
      entry: 101,
      exit: 107,
      reason: "sell",
      stop: 95,
    });
    expect(r.totalReturnPct).toBeCloseTo((107 / 101 - 1) * 100);
  });

  it("stops out at the stop, or at the open when the bar gaps below it", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 101, 102, 100, 101),
      bar(2, 101, 101, 94, 95),
    ];
    expect(
      runBacktest(
        candles,
        candles.map((c, i) => sig(c.time, i === 0 ? "BUY" : null)),
      ).trades[0],
    ).toMatchObject({
      exit: 95,
      reason: "stop",
    });

    const gap = [
      bar(0, 100, 101, 99, 100),
      bar(1, 101, 102, 100, 101),
      bar(2, 90, 91, 89, 90),
    ];
    expect(
      runBacktest(
        gap,
        gap.map((c, i) => sig(c.time, i === 0 ? "BUY" : null)),
      ).trades[0]!.exit,
    ).toBe(90);
  });

  it("falls back to an ATR stop when the swing low is above the entry", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 101, 102, 100, 101),
      bar(2, 101, 102, 100, 101),
    ];
    const signals = candles.map((c, i) =>
      sig(c.time, i === 0 ? "BUY" : null, 120),
    );
    expect(runBacktest(candles, signals).trades[0]!.stop).toBe(101 - 2 * 2);
  });

  it("exits on time after maxHoldBars", () => {
    const candles = Array.from({ length: 8 }, (_, i) =>
      bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i),
    );
    const signals = candles.map((c, i) =>
      sig(c.time, i === 0 ? "BUY" : null, 50),
    );
    const t = runBacktest(candles, signals, { maxHoldBars: 3 }).trades[0]!;
    expect(t).toMatchObject({ reason: "time", bars: 3, exit: 103.5 });
  });

  it("takes the deadline close over a SELL on the last allowed bar", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 80, 81, 79, 80),
    ];
    const signals = [sig(0, "BUY", 50), sig(1, "SELL", 50), sig(2, null, 50)];
    const t = runBacktest(candles, signals, { maxHoldBars: 1 }).trades[0]!;
    expect(t).toMatchObject({ reason: "time", bars: 1, exit: 100 });
  });

  it("re-enters on a BUY that closes on the exit bar", () => {
    const candles = Array.from({ length: 6 }, (_, i) =>
      bar(i, 100, 101, 99, 100),
    );
    const signals = candles.map((c, i) =>
      sig(c.time, i === 0 || i === 2 ? "BUY" : null, 50),
    );
    const r = runBacktest(candles, signals, { maxHoldBars: 2 });
    expect(r.trades.map((t) => t.entryTime)).toEqual([86_400, 3 * 86_400]);
  });

  it("measures drawdown on marked-to-market equity", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 150, 99, 150),
      bar(2, 150, 151, 109, 110),
      bar(3, 110, 161, 109, 160),
    ];
    const signals = candles.map((c, i) =>
      sig(c.time, i === 0 ? "BUY" : null, 50),
    );
    const r = runBacktest(candles, signals);
    expect(r.maxDrawdownPct).toBeCloseTo((1 - 110 / 150) * 100);
    expect(r.totalReturnPct).toBeCloseTo(60);
  });
});

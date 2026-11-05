import { describe, expect, it } from "vitest";
import {
  barCloseSeconds,
  closedBars,
  deskSignal,
  DEFAULT_DESK_SIGNAL_PARAMS,
} from "../lib/desk-signal.ts";
import { swingPoints, volumeSma, type CandleData } from "../lib/indicators.ts";

const DAY = 86_400;

/**
 * A steady trend (so the EMAs stack) with a small wave (so swing pivots exist)
 * and a wide-range stretch 60 to 80 bars back (so a normal breakout bar's ATR
 * is not the highest of the last 100).
 */
function trendBars(n: number, start = 100, step = 0.2): CandleData[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * step + Math.sin(i / 2) * 0.6;
    const range = i >= n - 80 && i < n - 60 ? 6 : 0.5;
    return {
      time: i * DAY,
      open: close,
      high: close + range,
      low: close - range,
      close,
      volume: 1000,
    };
  });
}

describe("volumeSma", () => {
  it("averages volume over the window ending at each bar", () => {
    const bars = [1, 2, 3, 4].map((v, i) => ({
      time: i,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: v,
    }));
    expect(volumeSma(bars, 2).map((p) => p.value)).toEqual([1.5, 2.5, 3.5]);
  });
});

describe("swingPoints", () => {
  it("finds pivots and marks when each is confirmed", () => {
    const highs = [1, 2, 5, 2, 1, 2, 3];
    const bars = highs.map((h, i) => ({
      time: i,
      open: h,
      high: h,
      low: h - 1,
      close: h,
    }));
    const { highs: found } = swingPoints(bars, 2);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ index: 2, value: 5, confirmedAt: 4 });
  });
});

describe("closedBars", () => {
  it("drops a bar that is still forming and keeps a closed one", () => {
    const bars = [{ time: 0 }, { time: DAY }];
    expect(closedBars(bars, DAY, (DAY + 100) * 1000)).toHaveLength(1);
    expect(closedBars(bars, DAY, 2 * DAY * 1000)).toHaveLength(2);
  });

  it("treats a stock day bar as closed at 16:00 New York", () => {
    // Alpaca stamps the 2026-11-04 bar at midnight New York (05:00 UTC).
    const stamp = Date.parse("2026-11-04T05:00:00Z") / 1000;
    const close = barCloseSeconds(DAY, true);
    expect(
      closedBars([{ time: stamp }], close, Date.parse("2026-11-04T21:10:00Z")),
    ).toHaveLength(1);
    expect(
      closedBars([{ time: stamp }], close, Date.parse("2026-11-04T20:59:00Z")),
    ).toHaveLength(0);
    expect(barCloseSeconds(DAY, false)).toBe(DAY);
    expect(barCloseSeconds(3600, true)).toBe(3600);
  });
});

describe("deskSignal", () => {
  it("reports a bullish trend once the four EMAs stack", () => {
    const out = deskSignal(trendBars(260));
    expect(out[259]!.trend).toBe("bullish");
    expect(out[10]!.trend).toBe("neutral"); // EMA 200 still warming up
  });

  it("fires BUY on a breakout with volume and RSI, and not without volume", () => {
    const bars = trendBars(260);
    const last = bars[259]!;
    bars[259] = {
      ...last,
      close: last.close + 8,
      high: last.close + 8.2,
      volume: 2000,
    };
    expect(deskSignal(bars)[259]!.signal).toBe("BUY");

    bars[259] = { ...bars[259]!, volume: 1400 }; // below 1.5x the 20-bar average
    expect(deskSignal(bars)[259]!.signal).toBeNull();
  });

  it("fires SELL on the mirror-image breakdown", () => {
    const bars = trendBars(260, 200, -0.2);
    const last = bars[259]!;
    bars[259] = {
      ...last,
      close: last.close - 8,
      low: last.close - 8.2,
      volume: 2000,
    };
    const bar = deskSignal(bars)[259]!;
    expect(bar.trend).toBe("bearish");
    expect(bar.signal).toBe("SELL");
  });

  it("suppresses a signal when ATR is in the top 10% of its last 100 values", () => {
    const bars = trendBars(260);
    const last = bars[259]!;
    // A huge range on the breakout bar spikes ATR to a 100-bar high.
    bars[259] = {
      ...last,
      close: last.close + 8,
      high: last.close + 80,
      low: last.close - 60,
      volume: 2000,
    };
    const bar = deskSignal(bars)[259]!;
    expect(bar.signal).toBeNull();
    expect(bar.filtered).toBe(true);
  });

  it("only uses swing points that were confirmed by that bar", () => {
    const out = deskSignal(trendBars(60), {
      ...DEFAULT_DESK_SIGNAL_PARAMS,
      swingStrength: 2,
    });
    // The first pivot can sit at index 2 at the earliest and is known at index 4.
    expect(out[3]!.swingHigh).toBeNull();
    expect(out.some((b) => b.swingHigh != null)).toBe(true);
  });
});

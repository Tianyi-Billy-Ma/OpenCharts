import {
  atr,
  ema,
  rsi,
  swingPoints,
  volumeSma,
  type CandleData,
  type IndicatorPoint,
} from "./indicators.ts";

/**
 * Desk Signal: the swing-trade entry trigger from docs/requirements.md (5.3).
 *
 * One implementation, shared by the backend scanner, the backtest and the
 * chart overlay, so all three always agree.
 *
 *   Trend   EMA 8 > 21 > 50 > 200 is bullish, the reverse is bearish.
 *   BUY     close above the previous 20-bar high, volume at least 1.5x the
 *           previous 20-bar average, RSI(14) above 50.
 *   SELL    the exact opposite.
 *   Zones   last confirmed swing high and swing low.
 *   Filter  no signal while ATR(14) is in the top 10% of its last 100 values.
 *
 * Pass closed bars only (see `closedBars`): a bar that is still forming can
 * cross a level and fall back, which the backtest would never see.
 */

export interface DeskSignalParams {
  /** Four EMA periods, fastest first. */
  emaPeriods: [number, number, number, number];
  breakoutLookback: number;
  volumeLookback: number;
  volumeMultiple: number;
  rsiPeriod: number;
  /** BUY needs RSI above this; SELL needs it below 100 minus this. */
  rsiThreshold: number;
  atrPeriod: number;
  atrLookback: number;
  /** Signals are suppressed when ATR's rank in its lookback is above this (0 to 1). */
  atrMaxPercentile: number;
  /** Bars on each side of a swing pivot. */
  swingStrength: number;
}

export const DEFAULT_DESK_SIGNAL_PARAMS: DeskSignalParams = {
  emaPeriods: [8, 21, 50, 200],
  breakoutLookback: 20,
  volumeLookback: 20,
  volumeMultiple: 1.5,
  rsiPeriod: 14,
  rsiThreshold: 50,
  atrPeriod: 14,
  atrLookback: 100,
  atrMaxPercentile: 0.9,
  swingStrength: 2,
};

export type Trend = "bullish" | "bearish" | "neutral";

export interface DeskSignalBar {
  time: number;
  close: number;
  trend: Trend;
  /** Set when the BUY or SELL conditions are met and the ATR filter allows it. */
  signal: "BUY" | "SELL" | null;
  /** The conditions were met but ATR was too high. */
  filtered: boolean;
  /** EMA values in `emaPeriods` order; null while warming up. */
  emas: (number | null)[];
  rsi: number | null;
  atr: number | null;
  swingHigh: number | null;
  swingLow: number | null;
}

/**
 * Seconds from a bar's timestamp to its close. Alpaca stamps stock day and week
 * bars at midnight New York, but they close at 16:00 on the last session day.
 */
export function barCloseSeconds(barSeconds: number, stock: boolean): number {
  if (!stock || barSeconds < 86_400) return barSeconds;
  const sessionDays = barSeconds >= 604_800 ? 5 : 1; // a week bar runs Monday to Friday
  return (sessionDays - 1) * 86_400 + 16 * 3600;
}

/** Drop the last bar if it has not closed yet. `barSeconds` is the time from a bar's stamp to its close. */
export function closedBars<T extends { time: number }>(
  candles: T[],
  barSeconds: number,
  nowMs = Date.now(),
): T[] {
  const last = candles[candles.length - 1];
  if (!last || (last.time + barSeconds) * 1000 <= nowMs) return candles;
  return candles.slice(0, -1);
}

const byTime = (points: IndicatorPoint[]) => new Map(points.map((p) => [p.time, p.value]));

export function deskSignal(
  candles: CandleData[],
  params: DeskSignalParams = DEFAULT_DESK_SIGNAL_PARAMS,
): DeskSignalBar[] {
  const emaMaps = params.emaPeriods.map((p) => byTime(ema(candles, p)));
  const rsiMap = byTime(rsi(candles, params.rsiPeriod));
  const atrSeries = atr(candles, params.atrPeriod);
  const atrMap = byTime(atrSeries);
  const atrIndex = new Map(atrSeries.map((p, i) => [p.time, i]));
  const volMap = byTime(volumeSma(candles, params.volumeLookback));
  const swings = swingPoints(candles, params.swingStrength);

  let hi = 0;
  let lo = 0;
  let swingHigh: number | null = null;
  let swingLow: number | null = null;

  return candles.map((c, i) => {
    while (hi < swings.highs.length && swings.highs[hi]!.confirmedAt <= i)
      swingHigh = swings.highs[hi++]!.value;
    while (lo < swings.lows.length && swings.lows[lo]!.confirmedAt <= i)
      swingLow = swings.lows[lo++]!.value;

    const emas = emaMaps.map((m) => m.get(c.time) ?? null);
    const [e1, e2, e3, e4] = emas;
    let trend: Trend = "neutral";
    if (e1 != null && e2 != null && e3 != null && e4 != null) {
      if (e1 > e2 && e2 > e3 && e3 > e4) trend = "bullish";
      else if (e1 < e2 && e2 < e3 && e3 < e4) trend = "bearish";
    }

    const r = rsiMap.get(c.time) ?? null;
    const a = atrMap.get(c.time) ?? null;
    const bar: DeskSignalBar = {
      time: c.time,
      close: c.close,
      trend,
      signal: null,
      filtered: false,
      emas,
      rsi: r,
      atr: a,
      swingHigh,
      swingLow,
    };

    // Breakout and volume compare against the bars *before* this one.
    if (i < params.breakoutLookback || r == null) return bar;
    const prevAvgVol = volMap.get(candles[i - 1]!.time);
    if (prevAvgVol == null || prevAvgVol <= 0) return bar;

    let prevHigh = -Infinity;
    let prevLow = Infinity;
    for (let j = i - params.breakoutLookback; j < i; j++) {
      prevHigh = Math.max(prevHigh, candles[j]!.high);
      prevLow = Math.min(prevLow, candles[j]!.low);
    }
    const volumeOk = (c.volume ?? 0) >= params.volumeMultiple * prevAvgVol;
    let raw: "BUY" | "SELL" | null = null;
    if (c.close > prevHigh && volumeOk && r > params.rsiThreshold) raw = "BUY";
    else if (c.close < prevLow && volumeOk && r < 100 - params.rsiThreshold) raw = "SELL";
    if (!raw) return bar;

    if (atrTooHigh(atrSeries, atrIndex.get(c.time), params)) bar.filtered = true;
    else bar.signal = raw;
    return bar;
  });
}

/** Whether ATR at `index` sits above `atrMaxPercentile` of its last `atrLookback` values. */
function atrTooHigh(
  series: IndicatorPoint[],
  index: number | undefined,
  params: DeskSignalParams,
): boolean {
  if (index == null || index + 1 < params.atrLookback) return false; // not enough history to rank
  const current = series[index]!.value;
  let below = 0;
  for (let j = index - params.atrLookback + 1; j <= index; j++) {
    if (series[j]!.value < current) below++;
  }
  return below / params.atrLookback >= params.atrMaxPercentile;
}

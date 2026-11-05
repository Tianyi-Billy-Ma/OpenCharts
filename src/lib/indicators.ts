/**
 * Technical Indicator Calculations
 * Pure functions for computing chart indicators from OHLCV candle data.
 */

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface IndicatorPoint {
  time: number;
  value: number;
}

/**
 * Coerce a period to a usable positive integer, or null when it is unusable.
 *
 * Without this a zero, negative, fractional or missing period indexed off the
 * front of the candle array (`candles[-1]!.close`) and threw inside render,
 * which the ErrorBoundary turns into a blank terminal. Registry entries are
 * fixed today, but adding an indicator is a documented extension point.
 */
function validPeriod(period: number | undefined | null, min = 1): number | null {
  if (period == null || !Number.isFinite(period)) return null;
  const floored = Math.floor(period);
  return floored >= min ? floored : null;
}

// ── Simple Moving Average ────────────────────────────────────
export function sma(candles: CandleData[], period: number): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  const p = validPeriod(period);
  if (p === null || candles.length < p) return result;
  period = p;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i]!.close;

  result.push({ time: candles[period - 1]!.time, value: sum / period });

  for (let i = period; i < candles.length; i++) {
    sum += candles[i]!.close - candles[i - period]!.close;
    result.push({ time: candles[i]!.time, value: sum / period });
  }
  return result;
}

// ── Exponential Moving Average ───────────────────────────────
export function ema(candles: CandleData[], period: number): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  const p = validPeriod(period);
  if (p === null || candles.length < p) return result;
  period = p;

  const k = 2 / (period + 1);

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i]!.close;
  let prev = sum / period;
  result.push({ time: candles[period - 1]!.time, value: prev });

  for (let i = period; i < candles.length; i++) {
    prev = candles[i]!.close * k + prev * (1 - k);
    result.push({ time: candles[i]!.time, value: prev });
  }
  return result;
}

/**
 * Wilder's RSI from average gain/loss. A flat stretch has no gains *and* no
 * losses — that is neutral (50), not maximally overbought, which is what the
 * bare `avgLoss === 0 → 100` rule used to report.
 */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ── Relative Strength Index ──────────────────────────────────
export function rsi(candles: CandleData[], period = 14): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  const p = validPeriod(period);
  if (p === null || candles.length < p + 1) return result;
  period = p;

  let avgGain = 0;
  let avgLoss = 0;

  // First period
  for (let i = 1; i <= period; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  result.push({ time: candles[period]!.time, value: rsiFrom(avgGain, avgLoss) });

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result.push({ time: candles[i]!.time, value: rsiFrom(avgGain, avgLoss) });
  }
  return result;
}

// ── MACD ─────────────────────────────────────────────────────
export interface MACDResult {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: IndicatorPoint[];
}

export function macd(
  candles: CandleData[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const fast = validPeriod(fastPeriod);
  const slow = validPeriod(slowPeriod);
  const signalLen = validPeriod(signalPeriod);
  if (fast === null || slow === null || signalLen === null) {
    return { macd: [], signal: [], histogram: [] };
  }
  signalPeriod = signalLen;
  const fastEma = ema(candles, fast);
  const slowEma = ema(candles, slow);

  // Align by time
  const slowTimes = new Map(slowEma.map((p) => [p.time, p.value]));
  const macdLine: IndicatorPoint[] = [];
  for (const fp of fastEma) {
    const sv = slowTimes.get(fp.time);
    if (sv !== undefined) {
      macdLine.push({ time: fp.time, value: fp.value - sv });
    }
  }

  // Signal line = EMA of MACD line
  const signalLine: IndicatorPoint[] = [];
  if (macdLine.length >= signalPeriod) {
    const k = 2 / (signalPeriod + 1);
    let sum = 0;
    for (let i = 0; i < signalPeriod; i++) sum += macdLine[i]!.value;
    let prev = sum / signalPeriod;
    signalLine.push({ time: macdLine[signalPeriod - 1]!.time, value: prev });

    for (let i = signalPeriod; i < macdLine.length; i++) {
      prev = macdLine[i]!.value * k + prev * (1 - k);
      signalLine.push({ time: macdLine[i]!.time, value: prev });
    }
  }

  // Histogram = MACD - Signal
  const signalTimes = new Map(signalLine.map((p) => [p.time, p.value]));
  const histogram: IndicatorPoint[] = [];
  for (const mp of macdLine) {
    const sv = signalTimes.get(mp.time);
    if (sv !== undefined) {
      histogram.push({ time: mp.time, value: mp.value - sv });
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

// ── Bollinger Bands ──────────────────────────────────────────
export interface BollingerResult {
  upper: IndicatorPoint[];
  middle: IndicatorPoint[];
  lower: IndicatorPoint[];
}

export function bollingerBands(
  candles: CandleData[],
  period = 20,
  stdDevMultiplier = 2,
): BollingerResult {
  const upper: IndicatorPoint[] = [];
  const middle: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];

  const p = validPeriod(period);
  if (p === null || candles.length < p) return { upper, middle, lower };
  period = p;

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j]!.close;
    const avg = sum / period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (candles[j]!.close - avg) ** 2;
    }
    const stdDev = Math.sqrt(variance / period);

    const t = candles[i]!.time;
    middle.push({ time: t, value: avg });
    upper.push({ time: t, value: avg + stdDevMultiplier * stdDev });
    lower.push({ time: t, value: avg - stdDevMultiplier * stdDev });
  }

  return { upper, middle, lower };
}

// ── Average True Range ───────────────────────────────────────
export function atr(candles: CandleData[], period = 14): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  const p = validPeriod(period);
  if (p === null || candles.length < p + 1) return result;
  period = p;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i]!.high - candles[i]!.low,
      Math.abs(candles[i]!.high - candles[i - 1]!.close),
      Math.abs(candles[i]!.low - candles[i - 1]!.close),
    );
    trs.push(tr);
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i]!;
  let prev = sum / period;
  result.push({ time: candles[period]!.time, value: prev });

  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]!) / period;
    result.push({ time: candles[i + 1]!.time, value: prev });
  }
  return result;
}

// ── Stochastic Oscillator ────────────────────────────────────
export interface StochasticResult {
  k: IndicatorPoint[];
  d: IndicatorPoint[];
}

export function stochastic(candles: CandleData[], kPeriod = 14, dPeriod = 3): StochasticResult {
  const kLine: IndicatorPoint[] = [];
  const kLen = validPeriod(kPeriod);
  const dLen = validPeriod(dPeriod);
  if (kLen === null || dLen === null || candles.length < kLen) return { k: [], d: [] };
  kPeriod = kLen;
  dPeriod = dLen;

  for (let i = kPeriod - 1; i < candles.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j]!.high > highest) highest = candles[j]!.high;
      if (candles[j]!.low < lowest) lowest = candles[j]!.low;
    }
    const range = highest - lowest;
    const kVal = range === 0 ? 50 : ((candles[i]!.close - lowest) / range) * 100;
    kLine.push({ time: candles[i]!.time, value: kVal });
  }

  // %D = SMA of %K
  const dLine: IndicatorPoint[] = [];
  if (kLine.length >= dPeriod) {
    let sum = 0;
    for (let i = 0; i < dPeriod; i++) sum += kLine[i]!.value;
    dLine.push({ time: kLine[dPeriod - 1]!.time, value: sum / dPeriod });
    for (let i = dPeriod; i < kLine.length; i++) {
      sum += kLine[i]!.value - kLine[i - dPeriod]!.value;
      dLine.push({ time: kLine[i]!.time, value: sum / dPeriod });
    }
  }

  return { k: kLine, d: dLine };
}

// ── Volume Weighted Average Price ────────────────────────────
export function vwap(candles: CandleData[]): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  let cumVolPrice = 0;
  let cumVol = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = Number.isFinite(c.volume) && (c.volume ?? 0) > 0 ? c.volume! : 0;
    cumVolPrice += typicalPrice * vol;
    cumVol += vol;
    // Before any volume has traded VWAP is just the typical price — dividing by
    // a zero denominator produced NaN and broke the whole series.
    result.push({ time: c.time, value: cumVol > 0 ? cumVolPrice / cumVol : typicalPrice });
  }
  return result;
}

// ── Volume moving average ────────────────────────────────────
/** Simple average of volume over `period` bars, ending at each bar. Missing volume counts as 0. */
export function volumeSma(candles: CandleData[], period = 20): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  const p = validPeriod(period);
  if (p === null || candles.length < p) return result;
  const vol = (c: CandleData) => (Number.isFinite(c.volume) ? c.volume! : 0);

  let sum = 0;
  for (let i = 0; i < p; i++) sum += vol(candles[i]!);
  result.push({ time: candles[p - 1]!.time, value: sum / p });
  for (let i = p; i < candles.length; i++) {
    sum += vol(candles[i]!) - vol(candles[i - p]!);
    result.push({ time: candles[i]!.time, value: sum / p });
  }
  return result;
}

// ── Swing highs and lows ─────────────────────────────────────
export interface SwingPoint extends IndicatorPoint {
  /** Index of the swing bar in `candles`. */
  index: number;
  /** Index of the bar on which the swing became known (`index + strength`). */
  confirmedAt: number;
}

/**
 * Pivot highs and lows: a bar whose high (low) is strictly above (below) the
 * `strength` bars on each side. A pivot is only known `strength` bars later,
 * which `confirmedAt` records so callers never peek ahead.
 */
export function swingPoints(
  candles: CandleData[],
  strength = 2,
): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  const n = validPeriod(strength);
  if (n === null) return { highs, lows };

  for (let i = n; i < candles.length - n; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= candles[i]!.high) isHigh = false;
      if (candles[j]!.low <= candles[i]!.low) isLow = false;
    }
    const t = candles[i]!.time;
    if (isHigh) highs.push({ time: t, value: candles[i]!.high, index: i, confirmedAt: i + n });
    if (isLow) lows.push({ time: t, value: candles[i]!.low, index: i, confirmedAt: i + n });
  }
  return { highs, lows };
}

// ── Indicator Registry (for UI) ──────────────────────────────
export type IndicatorType = "SMA" | "EMA" | "RSI" | "MACD" | "BOLL" | "ATR" | "STOCH" | "VWAP" | "DESK";

export type IndicatorPane = "overlay" | "below";

export interface IndicatorConfig {
  type: IndicatorType;
  label: string;
  pane: IndicatorPane;
  defaultParams: Record<string, number>;
  color: string;
}

export const INDICATOR_REGISTRY: IndicatorConfig[] = [
  {
    type: "SMA",
    label: "Simple Moving Average",
    pane: "overlay",
    defaultParams: { period: 20 },
    color: "#f0b90b",
  },
  {
    type: "EMA",
    label: "Exponential Moving Average",
    pane: "overlay",
    defaultParams: { period: 20 },
    color: "#e377c2",
  },
  {
    type: "RSI",
    label: "Relative Strength Index",
    pane: "below",
    defaultParams: { period: 14 },
    color: "#8884d8",
  },
  {
    type: "MACD",
    label: "MACD",
    pane: "below",
    defaultParams: { fast: 12, slow: 26, signal: 9 },
    color: "#2196f3",
  },
  {
    type: "BOLL",
    label: "Bollinger Bands",
    pane: "overlay",
    defaultParams: { period: 20, stdDev: 2 },
    color: "#26a69a",
  },
  {
    type: "ATR",
    label: "Average True Range",
    pane: "below",
    defaultParams: { period: 14 },
    color: "#ff7043",
  },
  {
    type: "STOCH",
    label: "Stochastic Oscillator",
    pane: "below",
    defaultParams: { kPeriod: 14, dPeriod: 3 },
    color: "#ab47bc",
  },
  {
    type: "VWAP",
    label: "Volume Weighted Avg Price",
    pane: "overlay",
    defaultParams: {},
    color: "#42a5f5",
  },
  {
    type: "DESK",
    label: "Desk Signal (EMA ribbon, BUY/SELL, swing zones)",
    pane: "overlay",
    defaultParams: {},
    color: "#26a69a",
  },
];

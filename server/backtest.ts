import type { DeskSignalBar } from "../src/lib/desk-signal.ts";
import type { CandleData } from "../src/lib/indicators.ts";

/**
 * A long-only Desk Signal backtest, matching the desk rules: no shorting, one
 * position per ticker, a stop at entry.
 *
 *   Entry  the open of the bar after a BUY (signals are known at the close).
 *   Stop   the last confirmed swing low, or entry minus 2x ATR when that is
 *          missing or above the entry. Hit when a bar trades through it; a gap
 *          below fills at that bar's open.
 *   Exit   the open after a SELL, the stop, or the close of the bar that ends
 *          `maxHoldBars` (10 by default, the desk's longest swing hold).
 */

export interface BacktestOptions {
  maxHoldBars?: number;
  /** Stop distance in ATRs when there is no usable swing low. */
  fallbackStopAtr?: number;
}

export interface Trade {
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  stop: number;
  reason: "sell" | "stop" | "time" | "end";
  returnPct: number;
  bars: number;
}

export interface BacktestResult {
  trades: Trade[];
  winRate: number;
  avgReturnPct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  buyAndHoldPct: number;
  /** Share of bars spent in a position. */
  exposure: number;
}

export function runBacktest(
  candles: CandleData[],
  signals: DeskSignalBar[],
  options: BacktestOptions = {},
): BacktestResult {
  const maxHold = options.maxHoldBars ?? 10;
  const fallbackAtr = options.fallbackStopAtr ?? 2;
  const trades: Trade[] = [];
  let barsInMarket = 0;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  let i = 0;
  while (i < candles.length - 1) {
    const s = signals[i]!;
    if (s.signal !== "BUY") {
      i++;
      continue;
    }

    const entryIndex = i + 1;
    const entry = candles[entryIndex]!.open;
    const atrStop = s.atr != null ? entry - fallbackAtr * s.atr : entry * 0.95;
    const stop =
      s.swingLow != null && s.swingLow < entry ? s.swingLow : atrStop;

    let exitIndex = entryIndex;
    let exit = candles[entryIndex]!.close;
    let reason: Trade["reason"] = "end";
    for (let j = entryIndex; j < candles.length; j++) {
      const bar = candles[j]!;
      exitIndex = j;
      if (bar.low <= stop) {
        exit = Math.min(stop, bar.open);
        reason = "stop";
        break;
      }
      // The deadline close comes before a SELL that would exit at the next open.
      if (j - entryIndex + 1 >= maxHold) {
        exit = bar.close;
        reason = "time";
        break;
      }
      if (signals[j]!.signal === "SELL" && j + 1 < candles.length) {
        exitIndex = j + 1;
        exit = candles[j + 1]!.open;
        reason = "sell";
        break;
      }
      exit = bar.close;
    }

    // Mark the open position at each close so drawdown counts losses between exits.
    for (let k = entryIndex; k <= exitIndex; k++) {
      const marked =
        equity * ((k === exitIndex ? exit : candles[k]!.close) / entry);
      peak = Math.max(peak, marked);
      maxDrawdown = Math.max(maxDrawdown, 1 - marked / peak);
    }
    equity *= exit / entry;

    const bars = exitIndex - entryIndex + 1;
    barsInMarket += bars;
    trades.push({
      entryTime: candles[entryIndex]!.time,
      exitTime: candles[exitIndex]!.time,
      entry,
      exit,
      stop,
      reason,
      returnPct: (exit / entry - 1) * 100,
      bars,
    });
    // Flat after the exit bar, so a BUY at its close can enter at the next open.
    i = exitIndex;
  }

  const first = candles[0];
  const last = candles[candles.length - 1];
  return {
    trades,
    winRate: trades.length
      ? trades.filter((t) => t.returnPct > 0).length / trades.length
      : 0,
    avgReturnPct: trades.length
      ? trades.reduce((sum, t) => sum + t.returnPct, 0) / trades.length
      : 0,
    totalReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    buyAndHoldPct: first && last ? (last.close / first.open - 1) * 100 : 0,
    exposure: candles.length ? barsInMarket / candles.length : 0,
  };
}

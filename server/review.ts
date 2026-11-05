import type { Trade } from "./backtest.ts";

/**
 * The go-live review (M5): paper results next to a backtest of the same
 * symbols, timeframe and window. The numbers inform the owner; going live
 * still needs their written OK.
 */

export const GO_LIVE_TRADING_DAYS = 60;

/** One execution, from Alpaca's FILL account activities. */
export interface Fill {
  /** As Alpaca sends it; "BTC/USD" and "BTCUSD" are the same symbol. */
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  /** Milliseconds. */
  time: number;
}

/** A paper position from flat to flat. Partial fills are averaged. */
export interface PaperTrade {
  symbol: string;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  qty: number;
  returnPct: number;
}

export interface Summary {
  trades: number;
  winRate: number;
  avgReturnPct: number;
  /** Trades compounded one after another, as the backtest does. */
  totalReturnPct: number;
}

// Crypto quantities are fractional; anything this small is flat.
const FLAT = 1e-9;

export const symbolKey = (symbol: string) => symbol.replace("/", "");

/**
 * Long-only round trips. Sells while flat (a position from before the window) are ignored.
 * shortcut: fills are not adjusted for stock splits, so a trade held across a split is
 * mis-scored; read SPLIT account activities if that ever happens.
 */
export function roundTrips(fills: Fill[]): {
  trades: PaperTrade[];
  open: string[];
} {
  const books = new Map<
    string,
    {
      symbol: string;
      qty: number;
      bought: number;
      boughtCost: number;
      sold: number;
      soldValue: number;
      start: number;
    }
  >();
  const trades: PaperTrade[] = [];
  for (const f of [...fills].sort((a, b) => a.time - b.time)) {
    const key = symbolKey(f.symbol);
    let book = books.get(key);
    if (f.side === "buy") {
      if (!book) {
        book = {
          symbol: f.symbol,
          qty: 0,
          bought: 0,
          boughtCost: 0,
          sold: 0,
          soldValue: 0,
          start: f.time,
        };
        books.set(key, book);
      }
      book.qty += f.qty;
      book.bought += f.qty;
      book.boughtCost += f.qty * f.price;
      continue;
    }
    if (!book) continue;
    const qty = Math.min(f.qty, book.qty);
    book.qty -= qty;
    book.sold += qty;
    book.soldValue += qty * f.price;
    if (book.qty > FLAT) continue;
    const entry = book.boughtCost / book.bought;
    const exit = book.soldValue / book.sold;
    trades.push({
      symbol: book.symbol,
      entryTime: book.start,
      exitTime: f.time,
      entry,
      exit,
      qty: book.bought,
      returnPct: (exit / entry - 1) * 100,
    });
    books.delete(key);
  }
  return { trades, open: [...books.values()].map((b) => b.symbol) };
}

export function summarize(trades: Array<Pick<Trade, "returnPct">>): Summary {
  const n = trades.length;
  return {
    trades: n,
    winRate: n ? trades.filter((t) => t.returnPct > 0).length / n : 0,
    avgReturnPct: n ? trades.reduce((s, t) => s + t.returnPct, 0) / n : 0,
    totalReturnPct: (trades.reduce((eq, t) => eq * (1 + t.returnPct / 100), 1) - 1) * 100,
  };
}

/**
 * Where the backtest window starts. When a bar holds the first fill, start at
 * the bar before it, so the BUY that set up that entry (filled at the next
 * bar's open) is in. When the fill falls between bars (a weekend crypto fill
 * against stock bars), start at the last bar, whose BUY enters after the fill.
 * Bars are stamped at their start, in seconds.
 */
export function windowStart(
  candles: Array<{ time: number }>,
  firstFillMs: number,
  barSeconds: number,
): number {
  let last = -1;
  for (let i = 0; i < candles.length && candles[i]!.time * 1000 <= firstFillMs; i++) last = i;
  if (last < 0) return 0;
  const holds = firstFillMs < (candles[last]!.time + barSeconds) * 1000;
  return holds ? Math.max(0, last - 1) : last;
}

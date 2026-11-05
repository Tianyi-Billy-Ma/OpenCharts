import {
  barCloseSeconds,
  closedBars,
  deskSignal,
  type DeskSignalBar,
} from "../src/lib/desk-signal.ts";
import { atr, bollingerBands, macd, rsi, sma, volumeSma } from "../src/lib/indicators.ts";
import { isCrypto, timeframeSeconds, type MarketData } from "./alpaca.ts";
import type { OpenChartsConfig } from "./config.ts";
import { newYorkDate, upcomingEvents } from "./events.ts";
import type { McpTool } from "./mcp.ts";
import type { OrderDesk } from "./orders.ts";
import { addTradingDays, type Store } from "./store.ts";

/**
 * The desk's MCP tools. Read tools are open to every token; the approval
 * tools need the Risk Officer's token (role "risk").
 */

export interface DeskDeps {
  config: OpenChartsConfig;
  marketData: MarketData;
  store: Store;
  /** Our order path. Unset: no order tools (the default; see `orders.enabled`). */
  orders?: OrderDesk;
  now?: () => number;
}

const STOCK = /^[A-Z][A-Z.]{0,9}$/;
const PAIR = /^[A-Z0-9]{2,10}\/[A-Z]{3,4}$/;

/** Bars needed before the first useful Desk Signal value (EMA 200, then the 100-bar ATR rank). */
export const warmUpBars = (config: OpenChartsConfig) =>
  Math.max(...config.deskSignal.params.emaPeriods) + config.deskSignal.params.atrLookback;

/** Desk Signal on closed bars, the last `limit` of them. Shared by the HTTP route and MCP. */
export async function deskSignalBars(
  deps: Pick<DeskDeps, "config" | "marketData">,
  symbol: string,
  timeframe: string,
  limit: number,
  /** Bars count as closed only when they closed by this time. */
  nowMs = Date.now(),
): Promise<{ bars: DeskSignalBar[]; candles: Awaited<ReturnType<MarketData["getBars"]>> }> {
  const seconds = timeframeSeconds(timeframe);
  if (!seconds) throw new Error(`Bad timeframe "${timeframe}"`);
  const raw = await deps.marketData.getBars({
    symbol,
    timeframe,
    limit: warmUpBars(deps.config) + limit + 1,
  });
  const candles = closedBars(raw, barCloseSeconds(seconds, !isCrypto(symbol)), nowMs);
  const bars = deskSignal(candles, deps.config.deskSignal.params);
  return { bars: bars.slice(-limit), candles };
}

// Argument readers: a bad argument throws, and the caller sees the message.
function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v == null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}
function oneOf(args: Record<string, unknown>, key: string, values: string[]): string | undefined {
  const v = str(args, key);
  if (v !== undefined && !values.includes(v))
    throw new Error(`${key} must be one of ${values.join(", ")}`);
  return v;
}
function num(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = args[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new Error(`${key} must be a number from ${min} to ${max}`);
  return v;
}

const round = (n: number | null | undefined, digits = 4) =>
  n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits;
const last = <T>(xs: T[]) => xs[xs.length - 1];

const symbolArg = {
  type: "string",
  description: 'Ticker like "NVDA", or a crypto pair like "BTC/USD"',
};
const timeframeArg = {
  type: "string",
  enum: ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"],
  description: "Bar size. Defaults to the desk's configured timeframe.",
};

export function createDeskTools(deps: DeskDeps): McpTool[] {
  const { config, marketData, store } = deps;
  const now = deps.now ?? Date.now;
  const watchlist = [...config.watchlist.stocks, ...config.watchlist.crypto];
  const byName = new Map(
    watchlist.flatMap(
      (s) =>
        [
          [s, s],
          [s.replace("/", ""), s],
        ] as const,
    ),
  );

  const symbol = (args: Record<string, unknown>, key = "symbol"): string => {
    const raw = str(args, key)?.trim().toUpperCase();
    if (!raw) throw new Error(`${key} is required`);
    const known = byName.get(raw);
    if (known) return known;
    if (STOCK.test(raw) || PAIR.test(raw)) return raw;
    throw new Error(`Bad ${key} "${raw}"`);
  };
  const watchlisted = (args: Record<string, unknown>): string => {
    const s = symbol(args, "ticker");
    if (!watchlist.includes(s))
      throw new Error(`${s} is not on the watchlist (${watchlist.join(", ")})`);
    return s;
  };
  const timeframe = (args: Record<string, unknown>) => {
    const tf = str(args, "timeframe") ?? config.deskSignal.timeframe;
    if (!timeframeSeconds(tf)) throw new Error(`Bad timeframe "${tf}"`);
    return tf;
  };
  const approvalView = (a: { ticker: string; until: number; approvedAt: number }) => ({
    ticker: a.ticker,
    until: new Date(a.until).toISOString(),
    approvedAt: new Date(a.approvedAt).toISOString(),
  });

  /** One screener row: the latest closed bar's numbers. */
  const snapshot = async (s: string, tf: string) => {
    const { bars, candles } = await deskSignalBars(deps, s, tf, 1);
    const bar = last(bars);
    const avgVol = last(volumeSma(candles.slice(0, -1), config.deskSignal.params.volumeLookback));
    const lastCandle = last(candles);
    return {
      symbol: s,
      time: bar ? new Date(bar.time * 1000).toISOString() : null,
      close: bar?.close ?? null,
      trend: bar?.trend ?? "neutral",
      signal: bar?.signal ?? null,
      filtered: bar?.filtered ?? false,
      rsi: round(bar?.rsi, 2),
      volumeRatio: avgVol && lastCandle?.volume ? round(lastCandle.volume / avgVol.value, 2) : null,
      approved: store.isApproved(s, now()),
    };
  };

  return [
    {
      name: "get_bars",
      description:
        "OHLCV bars, oldest first, times in epoch seconds. The last bar may still be forming.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: symbolArg,
          timeframe: timeframeArg,
          limit: { type: "number", description: "1 to 1000, default 100" },
        },
        required: ["symbol"],
      },
      run: async (args) =>
        marketData.getBars({
          symbol: symbol(args),
          timeframe: timeframe(args),
          limit: Math.floor(num(args, "limit", 1, 1000) ?? 100),
        }),
    },
    {
      name: "get_quote",
      description: "Latest bid and ask (stocks: IEX feed).",
      inputSchema: { type: "object", properties: { symbol: symbolArg }, required: ["symbol"] },
      run: async (args) => marketData.getQuote(symbol(args)),
    },
    {
      name: "get_indicators",
      description:
        "Latest values on the last closed bar: EMA 8/21/50/200, SMA 20/50, RSI 14, MACD 12/26/9, ATR 14, Bollinger 20/2, volume vs its 20-bar average, swing high and low.",
      inputSchema: {
        type: "object",
        properties: { symbol: symbolArg, timeframe: timeframeArg },
        required: ["symbol"],
      },
      run: async (args) => {
        const s = symbol(args);
        const tf = timeframe(args);
        const { bars, candles } = await deskSignalBars(deps, s, tf, 1);
        const bar = last(bars);
        if (!bar) return { symbol: s, timeframe: tf, error: "No closed bars" };
        const m = macd(candles);
        const bb = bollingerBands(candles);
        const volAvg = last(volumeSma(candles, 20));
        const ema = Object.fromEntries(
          config.deskSignal.params.emaPeriods.map((p, i) => [`ema${p}`, round(bar.emas[i])]),
        );
        return {
          symbol: s,
          timeframe: tf,
          time: new Date(bar.time * 1000).toISOString(),
          close: bar.close,
          ...ema,
          sma20: round(last(sma(candles, 20))?.value),
          sma50: round(last(sma(candles, 50))?.value),
          rsi14: round(last(rsi(candles, 14))?.value, 2),
          macd: round(last(m.macd)?.value),
          macdSignal: round(last(m.signal)?.value),
          macdHistogram: round(last(m.histogram)?.value),
          atr14: round(last(atr(candles, 14))?.value),
          bollingerUpper: round(last(bb.upper)?.value),
          bollingerMiddle: round(last(bb.middle)?.value),
          bollingerLower: round(last(bb.lower)?.value),
          volume: last(candles)?.volume ?? null,
          volumeAvg20: round(volAvg?.value, 0),
          swingHigh: bar.swingHigh,
          swingLow: bar.swingLow,
          trend: bar.trend,
        };
      },
    },
    {
      name: "desk_signal",
      description:
        "Desk Signal on closed bars, newest last: trend from the EMA ribbon, BUY or SELL (null when none), whether the ATR filter blocked one, and the swing zones.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: symbolArg,
          timeframe: timeframeArg,
          limit: { type: "number", description: "Bars to return, 1 to 500, default 20" },
        },
        required: ["symbol"],
      },
      run: async (args) => {
        const s = symbol(args);
        const tf = timeframe(args);
        const { bars } = await deskSignalBars(
          deps,
          s,
          tf,
          Math.floor(num(args, "limit", 1, 500) ?? 20),
        );
        return {
          symbol: s,
          timeframe: tf,
          approved: store.isApproved(s, now()),
          bars: bars.map((b) => ({ ...b, iso: new Date(b.time * 1000).toISOString() })),
        };
      },
    },
    {
      name: "screen",
      description:
        "Screen the watchlist (or given symbols) on the last closed bar. Every filter is optional; rows that fail any filter are dropped.",
      inputSchema: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: symbolArg,
            description: "Defaults to the watchlist (max 50)",
          },
          timeframe: timeframeArg,
          trend: { type: "string", enum: ["bullish", "bearish", "neutral"] },
          signal: { type: "string", enum: ["BUY", "SELL"] },
          minRsi: { type: "number" },
          maxRsi: { type: "number" },
          minPrice: { type: "number" },
          maxPrice: { type: "number" },
          minVolumeRatio: { type: "number", description: "Volume vs its 20-bar average, e.g. 1.5" },
        },
      },
      run: async (args) => {
        const tf = timeframe(args);
        const list = args.symbols == null ? watchlist : args.symbols;
        if (!Array.isArray(list) || list.length > 50)
          throw new Error("symbols must be a list of up to 50");
        const symbols = list.map((x) => symbol({ symbol: x }));
        const trend = oneOf(args, "trend", ["bullish", "bearish", "neutral"]);
        const signal = oneOf(args, "signal", ["BUY", "SELL"]);
        const minRsi = num(args, "minRsi", 0, 100);
        const maxRsi = num(args, "maxRsi", 0, 100);
        const minPrice = num(args, "minPrice", 0, Infinity);
        const maxPrice = num(args, "maxPrice", 0, Infinity);
        const minVolumeRatio = num(args, "minVolumeRatio", 0, Infinity);
        const rows = await Promise.all(
          symbols.map((s) =>
            snapshot(s, tf).catch((err: unknown) => ({
              symbol: s,
              error: err instanceof Error ? err.message : String(err),
            })),
          ),
        );
        const matches = rows.filter((r) => {
          if ("error" in r) return true; // shown, so a data problem is not mistaken for "no match"
          const below = (v: number | null, min?: number) => min != null && (v == null || v < min);
          const above = (v: number | null, max?: number) => max != null && (v == null || v > max);
          return !(
            (trend && r.trend !== trend) ||
            (signal && r.signal !== signal) ||
            below(r.rsi, minRsi) ||
            above(r.rsi, maxRsi) ||
            below(r.close, minPrice) ||
            above(r.close, maxPrice) ||
            below(r.volumeRatio, minVolumeRatio)
          );
        });
        return { timeframe: tf, matches };
      },
    },
    {
      name: "get_news",
      description: "Recent news headlines from Alpaca, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          symbols: { type: "array", items: symbolArg, description: "Leave out for all news" },
          limit: { type: "number", description: "1 to 50, default 10" },
        },
      },
      run: async (args) => {
        const list = args.symbols ?? [];
        if (!Array.isArray(list) || list.length > 50)
          throw new Error("symbols must be a list of up to 50");
        const news = await marketData.getNews(
          list.map((x) => symbol({ symbol: x })),
          num(args, "limit", 1, 50) ?? 10,
        );
        return news.map((n) => ({ ...n, time: new Date(n.time).toISOString() }));
      },
    },
    {
      name: "get_positions",
      description: "Open positions on the Alpaca account (paper by default).",
      inputSchema: { type: "object", properties: {} },
      run: async () => marketData.getPositions(),
    },
    {
      name: "list_signals",
      description:
        "Desk Signal events the scanner recorded, newest first, with whether the webhook was sent.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: symbolArg,
          limit: { type: "number", description: "1 to 200, default 20" },
        },
      },
      run: async (args) =>
        store
          .listSignals({
            symbol: args.symbol == null ? undefined : symbol(args),
            limit: Math.floor(num(args, "limit", 1, 200) ?? 20),
          })
          .map((s) => ({
            ...s,
            barTime: new Date(s.barTime * 1000).toISOString(),
            createdAt: new Date(s.createdAt).toISOString(),
          })),
    },
    {
      name: "get_events",
      description:
        "Upcoming FOMC rate decisions and CPI releases (New York time), from today through the next `days` days.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "number", description: "1 to 400, default 30" } },
      },
      run: async (args) =>
        upcomingEvents(newYorkDate(now()), Math.floor(num(args, "days", 1, 400) ?? 30)),
    },
    {
      name: "list_approvals",
      description: "Tickers the Risk Officer has approved, with when each approval ends.",
      inputSchema: { type: "object", properties: {} },
      run: async () => store.listApprovals(now()).map(approvalView),
    },
    {
      name: "set_approval",
      description: `Approve a watchlist ticker so its signals reach the desk. Lasts ${config.approvals.tradingDays} trading days unless "until" is given. Calling again renews it. Risk Officer only.`,
      role: "risk",
      inputSchema: {
        type: "object",
        properties: {
          ticker: symbolArg,
          until: {
            type: "string",
            description: "ISO 8601 date or time in the future, e.g. 2026-11-12",
          },
          reason: { type: "string", description: "Why, for the journal" },
        },
        required: ["ticker"],
      },
      run: async (args, { role }) => {
        const ticker = watchlisted(args);
        const at = now();
        const untilArg = str(args, "until");
        const until = untilArg
          ? Date.parse(untilArg)
          : addTradingDays(at, config.approvals.tradingDays, isCrypto(ticker));
        if (!Number.isFinite(until) || until <= at)
          throw new Error(`until must be a future date, got "${untilArg}"`);
        const approval = store.setApproval(ticker, until, at);
        store.addJournal(
          {
            agent: role,
            ticker,
            action: "approve",
            reason: str(args, "reason") ?? "",
            outcome: `until ${new Date(until).toISOString()}`,
          },
          at,
        );
        return approvalView(approval);
      },
    },
    {
      name: "revoke_approval",
      description: "End a ticker's approval now. Risk Officer only.",
      role: "risk",
      inputSchema: {
        type: "object",
        properties: {
          ticker: symbolArg,
          reason: { type: "string", description: "Why, for the journal" },
        },
        required: ["ticker"],
      },
      run: async (args, { role }) => {
        const ticker = watchlisted(args);
        const revoked = store.revokeApproval(ticker, now());
        if (revoked)
          store.addJournal(
            { agent: role, ticker, action: "revoke", reason: str(args, "reason") ?? "" },
            now(),
          );
        return { ticker, revoked };
      },
    },
    {
      name: "add_journal_entry",
      description:
        'Log an idea, rejection, note or outcome in the desk journal (the source of truth for the Trade Journal). After an order placed outside this server, log action "plan" with its stop (Trader token only): the position guard uses it if the stop goes missing.',
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: 'Who is logging, e.g. "Analyst"' },
          ticker: symbolArg,
          action: {
            type: "string",
            description: 'What happened, e.g. "idea", "reject", "plan", "note", "outcome"',
          },
          size: { type: "number" },
          entry: { type: "number" },
          stop: { type: "number" },
          target: { type: "number" },
          reason: { type: "string" },
          evidence: { type: "string" },
          outcome: { type: "string" },
        },
        required: ["agent", "action"],
      },
      run: async (args, { role }) => {
        const text = (key: string) => {
          const v = str(args, key);
          if (v && v.length > 2000) throw new Error(`${key} is over 2000 characters`);
          return v;
        };
        const agent = text("agent");
        const action = text("action");
        if (!agent || !action) throw new Error("agent and action are required");
        // Order and stop rows come from the backend only, so the guard can trust their stops.
        if (["order", "stop", "flatten", "alert", "approve", "revoke"].includes(action))
          throw new Error(`"${action}" rows are written by the backend; use another action`);
        // The guard places stops from "plan" rows, so only the Trader may write them.
        if (action === "plan" && role !== "trader")
          throw new Error('only the Trader\'s token may log "plan" rows');
        return store.addJournal(
          {
            agent,
            action,
            ticker: args.ticker == null ? undefined : symbol(args, "ticker"),
            size: num(args, "size", 0, Infinity) ?? null,
            entry: num(args, "entry", 0, Infinity) ?? null,
            stop: num(args, "stop", 0, Infinity) ?? null,
            target: num(args, "target", 0, Infinity) ?? null,
            reason: text("reason"),
            evidence: text("evidence"),
            outcome: text("outcome"),
          },
          now(),
        );
      },
    },
    {
      name: "list_journal",
      description: "Journal rows, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          ticker: symbolArg,
          action: { type: "string" },
          limit: { type: "number", description: "1 to 500, default 50" },
        },
      },
      run: async (args) =>
        store
          .listJournal({
            ticker: args.ticker == null ? undefined : symbol(args, "ticker"),
            action: str(args, "action"),
            limit: Math.floor(num(args, "limit", 1, 500) ?? 50),
          })
          .map((e) => ({ ...e, time: new Date(e.time).toISOString() })),
    },
    ...(deps.orders ? orderTools(deps.orders, watchlisted) : []),
  ];
}

/** The Trader's order tools (role "trader"), only when `orders.enabled` is on. */
function orderTools(
  orders: OrderDesk,
  watchlisted: (args: Record<string, unknown>) => string,
): McpTool[] {
  return [
    {
      name: "place_order",
      description:
        "Place a long-only order through the backend, which enforces approvals, a stop on every BUY and the hard limits first. BUY stocks: GTC market bracket (or OTO without a target). BUY crypto: market, then a separate stop-limit. SELL closes the whole position. Trader only.",
      role: "trader",
      inputSchema: {
        type: "object",
        properties: {
          ticker: symbolArg,
          side: { type: "string", enum: ["buy", "sell"] },
          qty: { type: "number", description: "Shares (whole for stocks) or coins. BUY only." },
          stop: { type: "number", description: "Stop price, below the market. Required for BUY." },
          target: { type: "number", description: "Take-profit price (stocks only). Optional." },
          reason: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["ticker", "side", "reason"],
      },
      run: async (args, { role }) => {
        const side = oneOf(args, "side", ["buy", "sell"]) as "buy" | "sell" | undefined;
        const reason = str(args, "reason");
        if (!side || !reason) throw new Error("side and reason are required");
        return orders.place(
          {
            ticker: watchlisted(args),
            side,
            qty: num(args, "qty", 0, Infinity),
            stop: num(args, "stop", 0, Infinity),
            target: num(args, "target", 0, Infinity),
            reason,
            evidence: str(args, "evidence"),
          },
          role,
        );
      },
    },
    {
      name: "cancel_order",
      description:
        "Cancel an unfilled entry (BUY) order by its Alpaca id. Stops and targets stay: SELL to close the position. Trader only.",
      role: "trader",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
      run: async (args, { role }) => {
        const id = str(args, "orderId");
        if (!id || !/^[0-9a-f-]{8,64}$/i.test(id))
          throw new Error("orderId must be an Alpaca order id");
        const result = await orders.cancel(id, role);
        if ("error" in result) throw new Error(result.error);
        return result;
      },
    },
  ];
}

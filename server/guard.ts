import { isCrypto, type MarketData, type Order, type Position, type Trading } from "./alpaca.ts";
import type { OpenChartsConfig } from "./config.ts";
import { deskSignalBars } from "./desk-tools.ts";
import { newYorkDate } from "./events.ts";
import { CRYPTO_STOP_LIMIT_GAP, roundPrice, sameSymbol } from "./orders.ts";
import type { Store } from "./store.ts";

/**
 * The position guard. On start and every few minutes (24/7) it checks every
 * open position against Alpaca's open orders, whichever path placed them.
 *
 *   No live stop  place one: the journal's planned stop, else price minus
 *                 `fallbackStopAtr` x ATR (or close it, with missingStop: "flatten").
 *   2 failures    alert the owner and block new entries on our order path
 *                 until that position has a stop or is closed.
 *   Limits        alert (once a day each) when positions break the hard limits;
 *                 on the official-MCP path this is the only enforcement.
 */

export interface GuardDeps {
  config: OpenChartsConfig;
  marketData: MarketData;
  trading: Trading;
  store: Store;
  /** Tell the owner. Gets plain text. */
  alert: (text: string) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface GuardStatus {
  lastRun: number | null;
  blocked: string | null;
  /** Positions the guard could not protect, with failure counts. */
  failing: Record<string, number>;
}

const STOP_TYPES = new Set(["stop", "stop_limit", "trailing_stop"]);

/** Every order, with bracket and OTO legs flattened in. */
const allOrders = (orders: Order[]): Order[] => orders.flatMap((o) => [o, ...allOrders(o.legs)]);

/** "BTCUSD" (positions) back to the watchlist's "BTC/USD". */
function watchName(position: Position, watchlist: string[]): string {
  const known = watchlist.find((s) => sameSymbol(s, position.symbol));
  if (known) return known;
  if (position.assetClass === "crypto" && position.symbol.endsWith("USD"))
    return `${position.symbol.slice(0, -3)}/USD`;
  return position.symbol;
}

export function createGuard(deps: GuardDeps) {
  const { config, trading, store } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[guard] ${m}`));
  const watchlist = [...config.watchlist.stocks, ...config.watchlist.crypto];
  const failures = new Map<string, number>();
  const alerted = new Set<string>();
  const status: GuardStatus = { lastRun: null, blocked: null, failing: {} };

  const alertOnce = async (key: string, text: string) => {
    const dayKey = `${newYorkDate(now())}:${key}`;
    if (alerted.has(dayKey)) return;
    alerted.add(dayKey);
    log(`ALERT ${text}`);
    store.addJournal({ agent: "guard", action: "alert", outcome: text }, now());
    await deps.alert(text).catch((err: unknown) => log(`alert not sent: ${String(err)}`));
  };

  const plannedStop = async (ticker: string, price: number) => {
    // The latest plan: a BUY we placed, or a "plan" row the Trader logged (official-MCP path).
    const planned = store
      .listJournal({ ticker, limit: 50 })
      .find(
        (e) =>
          e.stop != null &&
          ((e.action === "order" && e.reason.startsWith("BUY") && e.outcome.startsWith("placed")) ||
            e.action === "plan"),
      )?.stop;
    if (planned != null && planned < price) return { stop: planned, from: "journal plan" };
    const { bars } = await deskSignalBars(deps, ticker, config.deskSignal.timeframe, 1, now());
    const atr = bars[bars.length - 1]?.atr;
    if (atr == null) throw new Error(`no ATR for ${ticker}`);
    return {
      stop: price - config.guard.fallbackStopAtr * atr,
      from: `${config.guard.fallbackStopAtr}x ATR`,
    };
  };

  const protect = async (position: Position, ticker: string) => {
    if (config.guard.missingStop === "flatten") {
      await trading.closePosition(position.symbol);
      store.addJournal(
        {
          agent: "guard",
          ticker,
          action: "flatten",
          size: position.qty,
          outcome: "closed: no live stop",
        },
        now(),
      );
      return;
    }
    const crypto = isCrypto(ticker);
    const { stop, from } = await plannedStop(ticker, position.currentPrice);
    const stopPrice = roundPrice(stop, crypto);
    const order = await trading.placeOrder({
      symbol: ticker,
      qty: String(position.qty),
      side: "sell",
      time_in_force: "gtc",
      ...(crypto
        ? {
            type: "stop_limit",
            stop_price: stopPrice,
            limit_price: roundPrice(stopPrice * (1 - CRYPTO_STOP_LIMIT_GAP), true),
          }
        : { type: "stop", stop_price: stopPrice }),
    });
    store.addJournal(
      {
        agent: "guard",
        ticker,
        action: "stop",
        size: position.qty,
        stop: stopPrice,
        reason: "open position had no live stop",
        evidence: `stop from ${from}`,
        outcome: `placed ${order.id}`,
      },
      now(),
    );
    log(`${ticker}: placed missing stop at ${stopPrice} (${from})`);
  };

  const runOnce = async (): Promise<GuardStatus> => {
    const [positions, orders, account] = await Promise.all([
      trading.getPositions(),
      trading.getOpenOrders(),
      trading.getAccount(),
    ]);
    const stops = allOrders(orders).filter((o) => o.side === "sell" && STOP_TYPES.has(o.type));

    for (const position of positions) {
      const ticker = watchName(position, watchlist);
      if (position.side !== "long") {
        await alertOnce(
          `short:${ticker}`,
          `${ticker} is a short position; this desk does not short.`,
        );
        continue;
      }
      const covered = stops
        .filter((o) => sameSymbol(o.symbol, position.symbol))
        .reduce((sum, o) => sum + o.qty, 0);
      if (covered >= position.qty) {
        failures.delete(ticker);
        continue;
      }
      try {
        // shortcut: a partly covered position gets a stop for its full size; cancel the old stop first if that matters.
        await protect(position, ticker);
        failures.delete(ticker);
      } catch (err) {
        const count = (failures.get(ticker) ?? 0) + 1;
        failures.set(ticker, count);
        const message = err instanceof Error ? err.message : String(err);
        log(`${ticker}: could not place a stop (try ${count}): ${message}`);
        if (count >= 2)
          await alertOnce(
            `stop:${ticker}`,
            `${ticker} has no stop and the guard failed ${count} times (${message}). New entries are blocked.`,
          );
      }
    }
    // Positions that closed no longer need a stop.
    for (const ticker of failures.keys())
      if (!positions.some((p) => watchName(p, watchlist) === ticker)) failures.delete(ticker);

    const { maxOpenPositions, maxPositionPct, dailyLossPct } = config.limits;
    if (positions.length > maxOpenPositions)
      await alertOnce(
        "count",
        `${positions.length} open positions, over the limit of ${maxOpenPositions}.`,
      );
    for (const p of positions) {
      const pct = account.equity > 0 ? (Math.abs(p.marketValue) / account.equity) * 100 : 0;
      if (pct > maxPositionPct)
        await alertOnce(
          `size:${p.symbol}`,
          `${watchName(p, watchlist)} is ${pct.toFixed(1)}% of equity, over the ${maxPositionPct}% limit.`,
        );
    }
    const dayPct = account.lastEquity > 0 ? (account.equity / account.lastEquity - 1) * 100 : 0;
    if (dayPct <= -dailyLossPct)
      await alertOnce(
        "daily-loss",
        `Down ${(-dayPct).toFixed(2)}% today, past the ${dailyLossPct}% daily loss stop.`,
      );

    const failing = Object.fromEntries([...failures].filter(([, n]) => n >= 2));
    status.lastRun = now();
    status.failing = Object.fromEntries(failures);
    status.blocked = Object.keys(failing).length
      ? `no stop on ${Object.keys(failing).join(", ")}`
      : null;
    return { ...status };
  };

  return {
    runOnce,
    status: () => ({ ...status }),
    blockedReason: () => status.blocked,
    /** Run now and then every `everyMinutes`. Returns a stop function. */
    start() {
      let running = false;
      const tick = () => {
        if (running) return;
        running = true;
        runOnce()
          .catch((err: unknown) =>
            log(`check failed: ${err instanceof Error ? err.message : String(err)}`),
          )
          .finally(() => (running = false));
      };
      tick();
      const id = setInterval(tick, config.guard.everyMinutes * 60_000);
      return () => clearInterval(id);
    },
  };
}

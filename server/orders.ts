import {
  isCrypto,
  type MarketData,
  type Order,
  type OrderRequest,
  type Trading,
} from "./alpaca.ts";
import type { OpenChartsConfig } from "./config.ts";
import type { Store } from "./store.ts";

/**
 * Our own order path, for users who want the backend to enforce the desk's
 * limits before an order reaches Alpaca. Long only.
 *
 *   BUY   needs a live approval, a stop below the price, whole shares for
 *         stocks, and must pass the hard limits. Stocks go in as a GTC market
 *         bracket (or OTO when there is no target), so the stop lives at
 *         Alpaca from the start. Crypto has no brackets: a market buy, then a
 *         separate GTC stop-limit sell once it fills.
 *   SELL  closes the whole position, after cancelling its open orders (the
 *         stop and target legs hold the shares).
 *
 * Every attempt, placed or rejected, goes in the journal.
 */

export interface OrderArgs {
  ticker: string;
  side: "buy" | "sell";
  qty?: number;
  stop?: number;
  target?: number;
  reason: string;
  evidence?: string;
}

export interface OrderResult {
  ok: boolean;
  /** Why the order was refused; empty when it was placed. */
  rejected: string[];
  orders: Order[];
  note?: string;
}

export interface OrderDeskDeps {
  config: OpenChartsConfig;
  marketData: MarketData;
  trading: Trading;
  store: Store;
  /** Why new entries are blocked right now (the position guard sets this), or null. */
  blockedReason: () => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Positions name crypto "BTCUSD"; orders and the watchlist use "BTC/USD". */
export const sameSymbol = (a: string, b: string) =>
  a.replace("/", "") === b.replace("/", "");

/** Stocks trade in cents; crypto keeps 6 significant digits. */
export const roundPrice = (price: number, crypto: boolean) =>
  crypto ? Number(price.toPrecision(6)) : Math.round(price * 100) / 100;

/** A crypto stop-limit needs a limit under the stop so it still fills in a fast drop. */
export const CRYPTO_STOP_LIMIT_GAP = 0.01;

const FILL_POLLS = 10;

export type OrderDesk = ReturnType<typeof createOrderDesk>;

export function createOrderDesk(deps: OrderDeskDeps) {
  const { config, marketData, trading, store } = deps;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const price = async (symbol: string) => {
    const quote = await marketData.getQuote(symbol).catch(() => null);
    if (quote && quote.ask > 0) return quote.ask;
    const bars = await marketData.getBars({
      symbol,
      timeframe: "1m",
      limit: 1,
    });
    const last = bars[bars.length - 1];
    if (!last) throw new Error(`No price for ${symbol}`);
    return last.close;
  };

  const journal = (
    agent: string,
    args: OrderArgs,
    entry: number | null,
    outcome: string,
  ) =>
    store.addJournal(
      {
        agent,
        ticker: args.ticker,
        action: "order",
        size: args.qty ?? null,
        entry,
        stop: args.stop ?? null,
        target: args.target ?? null,
        reason: `${args.side.toUpperCase()}: ${args.reason}`,
        evidence: args.evidence ?? "",
        outcome,
      },
      now(),
    );

  const buy = async (args: OrderArgs, agent: string): Promise<OrderResult> => {
    const crypto = isCrypto(args.ticker);
    const { qty, stop, target } = args;
    const rejected: string[] = [];
    if (qty == null || !(qty > 0)) rejected.push("qty must be above 0");
    else if (!crypto && !Number.isInteger(qty))
      rejected.push(
        "stock qty must be whole shares (bracket orders cannot be fractional)",
      );
    if (stop == null || !(stop > 0)) rejected.push("every BUY needs a stop");

    const [account, positions, openOrders, entry] = await Promise.all([
      trading.getAccount(),
      trading.getPositions(),
      trading.getOpenOrders(),
      price(args.ticker),
    ]);
    // Checked after the awaits, so a revoke or block that lands meanwhile still stops the order.
    if (!store.isApproved(args.ticker, now()))
      rejected.push(`${args.ticker} has no live Risk Officer approval`);
    const blocked = deps.blockedReason();
    if (blocked) rejected.push(`new entries are blocked: ${blocked}`);
    if (stop != null && stop >= entry)
      rejected.push(`stop ${stop} must be below the price ${entry}`);
    if (target != null && target <= entry)
      rejected.push(`target ${target} must be above the price ${entry}`);
    if (account.tradingBlocked)
      rejected.push("Alpaca has blocked trading on this account");
    const { maxPositionPct, maxOpenPositions, dailyLossPct } = config.limits;
    const dayPct =
      account.lastEquity > 0
        ? (account.equity / account.lastEquity - 1) * 100
        : 0;
    if (dayPct <= -dailyLossPct)
      rejected.push(
        `daily loss stop: down ${(-dayPct).toFixed(2)}% today (limit ${dailyLossPct}%)`,
      );
    // Unfilled BUYs count as if filled, so queued orders cannot slip past the limits.
    const pendingBuys = openOrders.filter((o) => o.side === "buy");
    const held = new Set(
      [...positions, ...pendingBuys].map((p) => p.symbol.replace("/", "")),
    );
    if (
      !held.has(args.ticker.replace("/", "")) &&
      held.size >= maxOpenPositions
    )
      rejected.push(
        `already at the limit of ${maxOpenPositions} open positions`,
      );
    if (qty != null && qty > 0 && account.equity > 0) {
      const existing = positions.find((p) => sameSymbol(p.symbol, args.ticker));
      // Unfilled value of queued BUYs; filled shares are already in the position's market value.
      const pending = pendingBuys
        .filter((o) => sameSymbol(o.symbol, args.ticker))
        .reduce(
          (sum, o) =>
            sum +
            (o.notional != null
              ? Math.max(
                  0,
                  o.notional - o.filledQty * (o.filledAvgPrice ?? entry),
                )
              : (o.qty - o.filledQty) * entry),
          0,
        );
      const value = (existing?.marketValue ?? 0) + pending + qty * entry;
      const pct = (value / account.equity) * 100;
      if (pct > maxPositionPct)
        rejected.push(
          `position would be ${pct.toFixed(1)}% of equity (limit ${maxPositionPct}%)`,
        );
    }
    if (rejected.length) {
      journal(agent, args, entry, `rejected: ${rejected.join("; ")}`);
      return { ok: false, rejected, orders: [] };
    }

    // Alpaca can still refuse (e.g. buying power); that attempt is journaled too.
    const submitEntry = (request: OrderRequest) =>
      trading
        .placeOrder(request)
        .catch((err: unknown) =>
          err instanceof Error ? err : new Error(String(err)),
        );
    const brokerRejected = (err: Error): OrderResult => {
      const reason = `Alpaca refused the order: ${err.message}`;
      journal(agent, args, entry, `rejected: ${reason}`);
      return { ok: false, rejected: [reason], orders: [] };
    };
    const stopPrice = roundPrice(stop!, crypto);
    if (!crypto) {
      const request: OrderRequest = {
        symbol: args.ticker,
        qty: String(qty),
        side: "buy",
        type: "market",
        // GTC, not DAY: a DAY bracket drops its stop after the first session.
        time_in_force: "gtc",
        order_class: target != null ? "bracket" : "oto",
        stop_loss: { stop_price: stopPrice },
        ...(target != null && {
          take_profit: { limit_price: roundPrice(target, false) },
        }),
      };
      const order = await submitEntry(request);
      if (order instanceof Error) return brokerRejected(order);
      journal(agent, args, entry, `placed ${order.id}`);
      return { ok: true, rejected: [], orders: [order] };
    }

    const order = await submitEntry({
      symbol: args.ticker,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "gtc",
    });
    if (order instanceof Error) return brokerRejected(order);
    // Journaled before waiting, so a guard run meanwhile already sees this trade's stop.
    journal(agent, args, entry, `placed ${order.id}`);
    const followUp = (outcome: string) =>
      store.addJournal(
        {
          agent,
          ticker: args.ticker,
          action: "stop",
          size: qty,
          stop: stopPrice,
          outcome,
        },
        now(),
      );
    // Wait briefly for the fill, then protect it; the position guard covers anything slower.
    let filled = order;
    let pollError = "";
    try {
      for (let i = 0; i < FILL_POLLS && filled.status !== "filled"; i++) {
        await sleep(1000);
        filled = await trading.getOrder(order.id);
      }
    } catch (err) {
      // The entry is live at Alpaca, so report it as placed; the guard still protects it.
      pollError = ` (fill check failed: ${err instanceof Error ? err.message : String(err)})`;
    }
    if (filled.status !== "filled") {
      const note = `entry not filled yet${pollError}; the position guard will place the stop once it fills`;
      followUp(`waiting: ${note}`);
      return { ok: true, rejected: [], orders: [filled], note };
    }
    const stopOrder = await trading
      .placeOrder({
        symbol: args.ticker,
        qty: String(filled.qty),
        side: "sell",
        type: "stop_limit",
        stop_price: stopPrice,
        limit_price: roundPrice(stopPrice * (1 - CRYPTO_STOP_LIMIT_GAP), true),
        time_in_force: "gtc",
      })
      .catch((err: unknown) => err as Error);
    if (stopOrder instanceof Error) {
      // Also what happens when a guard run placed the stop first: the shares are already held.
      const note = `stop not placed (${stopOrder.message}); the position guard covers the position`;
      followUp(`failed: ${note}`);
      return { ok: true, rejected: [], orders: [filled], note };
    }
    const note =
      target != null
        ? "crypto has no brackets, so the target was not placed"
        : undefined;
    followUp(
      `placed ${stopOrder.id} for ${order.id}${note ? `; ${note}` : ""}`,
    );
    return { ok: true, rejected: [], orders: [filled, stopOrder], note };
  };

  const sell = async (args: OrderArgs, agent: string): Promise<OrderResult> => {
    const position = (await trading.getPositions()).find((p) =>
      sameSymbol(p.symbol, args.ticker),
    );
    if (!position) {
      const rejected = [
        `no open ${args.ticker} position (this desk does not short)`,
      ];
      journal(agent, args, null, `rejected: ${rejected[0]}`);
      return { ok: false, rejected, orders: [] };
    }
    const open = (await trading.getOpenOrders()).filter((o) =>
      sameSymbol(o.symbol, args.ticker),
    );
    for (const o of open) await trading.cancelOrder(o.id);
    await trading.closePosition(args.ticker);
    journal(
      agent,
      { ...args, qty: position.qty },
      position.currentPrice,
      `closed ${position.qty}, cancelled ${open.length} open order(s)`,
    );
    return { ok: true, rejected: [], orders: [] };
  };

  // BUYs run one at a time, so two concurrent requests cannot both spend the same limit.
  let buying: Promise<unknown> = Promise.resolve();
  const queuedBuy = (args: OrderArgs, agent: string) => {
    const run = buying.then(() => buy(args, agent));
    buying = run.catch(() => {});
    return run;
  };

  return {
    place: (args: OrderArgs, agent: string) =>
      args.side === "buy" ? queuedBuy(args, agent) : sell(args, agent),
    async cancel(orderId: string, agent: string) {
      await trading.cancelOrder(orderId);
      store.addJournal(
        { agent, action: "cancel", outcome: `cancelled ${orderId}` },
        now(),
      );
      return { cancelled: orderId };
    },
  };
}

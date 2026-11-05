import { randomUUID } from "node:crypto";
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
 *         stop and target legs hold the shares) and waiting until Alpaca has
 *         really dropped them.
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
  /** The position guard is running. Crypto BUYs need it: a slow fill is protected by the guard. */
  guardActive: boolean;
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
const CANCEL_POLLS = 20;

export const STOP_TYPES = new Set(["stop", "stop_limit", "trailing_stop"]);

/** Every order, with bracket and OTO legs flattened in. */
export const allOrders = (orders: Order[]): Order[] =>
  orders.flatMap((o) => [o, ...allOrders(o.legs)]);

/** Bracket exit legs stay "held" until the entry fully fills, so they protect nothing yet. */
export const isLiveStop = (o: Order) =>
  o.side === "sell" && STOP_TYPES.has(o.type) && o.status !== "held";

/** Shares of `symbol` that live stops (or a queued market SELL, already closing it) still cover. */
export const coveredQty = (symbol: string, orders: Order[]) =>
  allOrders(orders)
    .filter(
      (o) =>
        sameSymbol(o.symbol, symbol) &&
        (isLiveStop(o) ||
          (o.side === "sell" && o.type === "market" && o.status !== "held")),
    )
    // A partly executed stop only protects what it has not sold yet.
    .reduce((sum, o) => sum + o.qty - o.filledQty, 0);

type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cancel orders and wait until Alpaca has dropped them. Its DELETE answers once
 * the cancel is accepted, and a `pending_cancel` order still holds the shares.
 */
export async function cancelAndWait(
  trading: Trading,
  ids: string[],
  sleep: Sleep,
) {
  // A refused cancel (already filled or cancelled) is fine; the wait below is the real check.
  for (const id of ids) await trading.cancelOrder(id).catch(() => {});
  for (let i = 0; ; i++) {
    const open = new Set(
      allOrders(await trading.getOpenOrders()).map((o) => o.id),
    );
    const left = ids.filter((id) => open.has(id));
    if (!left.length) return;
    if (i >= CANCEL_POLLS)
      throw new Error(`orders still open after cancelling: ${left.join(", ")}`);
    await sleep(500);
  }
}

/**
 * Cancel every open order on the symbol (legs included: a filled bracket's
 * parent cannot be cancelled, its legs can), wait, then close what is left.
 * Returns the qty closed and the orders cancelled; 0 when a stop sold it all meanwhile.
 */
export async function cancelAndClose(
  trading: Trading,
  symbol: string,
  sleep: Sleep,
) {
  const ids = allOrders(await trading.getOpenOrders())
    .filter((o) => sameSymbol(o.symbol, symbol))
    .map((o) => o.id);
  await cancelAndWait(trading, ids, sleep);
  const left = (await trading.getPositions()).find((p) =>
    sameSymbol(p.symbol, symbol),
  );
  if (left) await trading.closePosition(symbol);
  return { qty: left?.qty ?? 0, cancelled: ids.length };
}

/** A 4xx is Alpaca saying no. A dropped connection, timeout or 5xx may still have placed it. */
const isRefusal = (err: unknown) => {
  const status = (err as { status?: number }).status;
  return status != null && status >= 400 && status < 500 && status !== 408;
};

export type OrderDesk = ReturnType<typeof createOrderDesk>;

export function createOrderDesk(deps: OrderDeskDeps) {
  const { config, marketData, trading, store } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;

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
    if (crypto && !deps.guardActive)
      rejected.push(
        "crypto BUYs need the position guard (guard.enabled): it places the stop when a fill is slow",
      );

    let lookups;
    try {
      lookups = await Promise.all([
        trading.getAccount(),
        trading.getPositions(),
        trading.getOpenOrders(),
        price(args.ticker),
      ]);
    } catch (err) {
      journal(agent, args, null, `failed: ${errorText(err)}`);
      throw err;
    }
    const [account, positions, openOrders, entry] = lookups;
    // Checked as sent: rounding can move a price onto the other side of the entry.
    const stopPrice = stop != null ? roundPrice(stop, crypto) : null;
    const targetPrice = target != null ? roundPrice(target, crypto) : null;
    // Checked after the awaits, so a revoke or block that lands meanwhile still stops the order.
    if (!store.isApproved(args.ticker, now()))
      rejected.push(`${args.ticker} has no live Risk Officer approval`);
    const blocked = deps.blockedReason();
    if (blocked) rejected.push(`new entries are blocked: ${blocked}`);
    if (stopPrice != null && stopPrice >= entry)
      rejected.push(`stop ${stopPrice} must be below the price ${entry}`);
    if (targetPrice != null && targetPrice <= entry)
      rejected.push(`target ${targetPrice} must be above the price ${entry}`);
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
    // Our client_order_id lets a lost answer be looked up instead of guessed.
    const submitEntry = async (
      request: OrderRequest,
    ): Promise<Order | OrderResult> => {
      const clientOrderId = randomUUID();
      try {
        return await trading.placeOrder({
          ...request,
          client_order_id: clientOrderId,
        });
      } catch (err) {
        if (isRefusal(err)) {
          const reason = `Alpaca refused the order: ${errorText(err)}`;
          journal(agent, args, entry, `rejected: ${reason}`);
          return { ok: false, rejected: [reason], orders: [] };
        }
        const found = await trading
          .getOrderByClientId(clientOrderId)
          .catch(() => undefined);
        if (found) return found;
        const reason =
          found === null
            ? `Alpaca did not take the order: ${errorText(err)}`
            : `unknown whether Alpaca took the order (${errorText(err)}); check client_order_id ${clientOrderId} before retrying`;
        journal(
          agent,
          args,
          entry,
          `${found === null ? "rejected" : "unknown"}: ${reason}`,
        );
        return { ok: false, rejected: [reason], orders: [] };
      }
    };
    const isOrder = (r: Order | OrderResult): r is Order => "id" in r;
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
        ...(targetPrice != null && {
          take_profit: { limit_price: targetPrice },
        }),
      };
      const order = await submitEntry(request);
      if (!isOrder(order)) return order;
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
    if (!isOrder(order)) return order;
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
    // Sized from what is held, not what was ordered: Alpaca takes crypto fees out of the coins.
    let stopQty: number;
    try {
      const [positions, open] = await Promise.all([
        trading.getPositions(),
        trading.getOpenOrders(),
      ]);
      const held =
        positions.find((p) => sameSymbol(p.symbol, args.ticker))?.qty ?? 0;
      stopQty = Number(
        Math.min(filled.qty, held - coveredQty(args.ticker, open)).toFixed(9),
      );
    } catch (err) {
      const note = `stop not placed (${errorText(err)}); the position guard covers the position`;
      followUp(`failed: ${note}`);
      return { ok: true, rejected: [], orders: [filled], note };
    }
    if (!(stopQty > 0)) {
      const note =
        "the position already has a stop (the position guard placed it)";
      followUp(`skipped: ${note}`);
      return { ok: true, rejected: [], orders: [filled], note };
    }
    const stopOrder = await trading
      .placeOrder({
        symbol: args.ticker,
        qty: String(stopQty),
        side: "sell",
        type: "stop_limit",
        stop_price: stopPrice,
        limit_price: roundPrice(stopPrice! * (1 - CRYPTO_STOP_LIMIT_GAP), true),
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
    let position;
    try {
      position = (await trading.getPositions()).find((p) =>
        sameSymbol(p.symbol, args.ticker),
      );
    } catch (err) {
      journal(agent, args, null, `failed: ${errorText(err)}`);
      throw err;
    }
    if (!position) {
      const rejected = [
        `no open ${args.ticker} position (this desk does not short)`,
      ];
      journal(agent, args, null, `rejected: ${rejected[0]}`);
      return { ok: false, rejected, orders: [] };
    }
    try {
      const closed = await cancelAndClose(trading, args.ticker, sleep);
      journal(
        agent,
        { ...args, qty: closed.qty || position.qty },
        position.currentPrice,
        closed.qty
          ? `closed ${closed.qty}, cancelled ${closed.cancelled} open order(s)`
          : `closed already: an order sold it while the ${closed.cancelled} open order(s) were cancelled`,
      );
      return { ok: true, rejected: [], orders: [] };
    } catch (err) {
      journal(
        agent,
        { ...args, qty: position.qty },
        position.currentPrice,
        `failed: ${errorText(err)}`,
      );
      throw err;
    }
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
    /** Entry orders only: stops and targets protect a position, and go when it is closed. */
    async cancel(
      orderId: string,
      agent: string,
    ): Promise<{ cancelled: string } | { error: string; status: 404 | 422 }> {
      const order = allOrders(await trading.getOpenOrders()).find(
        (o) => o.id === orderId,
      );
      if (!order) return { error: `No open order ${orderId}`, status: 404 };
      if (order.side !== "buy")
        return {
          error:
            "Only entry orders can be cancelled. Close the position instead.",
          status: 422,
        };
      // Cancelling a partly filled bracket entry also cancels its stop, leaving the filled shares bare.
      if (order.filledQty > 0)
        return {
          error: "This entry has partly filled. Close the position instead.",
          status: 422,
        };
      await trading.cancelOrder(orderId);
      store.addJournal(
        { agent, action: "cancel", outcome: `cancelled ${orderId}` },
        now(),
      );
      return { cancelled: orderId };
    },
  };
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Trading } from "./alpaca.ts";
import { allOrders, type OrderDesk } from "./orders.ts";

/**
 * The terminal's trading routes. Reads come straight from Alpaca; every write
 * goes through our order desk (orders.ts), so the terminal follows the same
 * rules as the Trader bot: approval, stop, hard limits, journal.
 *
 *   GET  /api/trading/account          {mode, equity, lastEquity, buyingPower, ordersEnabled}
 *   GET  /api/trading/positions
 *   GET  /api/trading/orders           open orders, bracket legs flattened
 *   POST /api/trading/orders           {ticker, side, qty, stop, target?, reason?}
 *   POST /api/trading/orders/:id/cancel
 *   POST /api/trading/positions/:ticker/close
 *
 * Writes need the `x-opencharts: 1` header. A cross-site page cannot send a
 * custom header without a CORS preflight, which this server never approves,
 * so another site cannot trade through the owner's browser session. app.ts
 * also refuses these routes on an unknown Host, which stops DNS rebinding.
 */

export interface TerminalTradingOptions {
  trading: Trading;
  /** Unset when `orders.enabled` is off: the terminal is read-only. */
  orders?: OrderDesk;
  mode: "paper" | "live";
  /** Watchlist symbol in Alpaca form ("BTC/USD") for a terminal name ("BTCUSD"). */
  toAlpaca: (name: string) => string | undefined;
}

const MAX_BODY_BYTES = 10_000;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(
      Buffer.concat(chunks).toString("utf8") || "{}",
    );
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const optionalNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Returns false when the path is not one of ours. */
export async function handleTerminalTrading(
  options: TerminalTradingOptions,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const { trading, orders, mode } = options;
  const reply = (status: number, body: unknown) => {
    send(res, status, body);
    return true;
  };
  const parts = path.split("/").filter(Boolean).slice(2); // drop "api", "trading"
  const [resource, id, action] = parts.map((p) => decodeURIComponent(p));

  if (req.method === "GET") {
    if (parts.length !== 1) return false;
    if (resource === "account") {
      const account = await trading.getAccount();
      return reply(200, { mode, ordersEnabled: Boolean(orders), ...account });
    }
    if (resource === "positions")
      return reply(200, await trading.getPositions());
    if (resource === "orders") {
      const open = await trading.getOpenOrders();
      // Legs (stop, target) are orders too; the terminal lists them flat.
      const flat = allOrders(open).map(({ legs: _, ...o }) => o);
      return reply(200, flat);
    }
    return false;
  }

  if (req.method !== "POST") return false;
  if (req.headers["x-opencharts"] !== "1") {
    return reply(403, { error: "Missing the x-opencharts header" });
  }
  if (!orders) {
    return reply(403, {
      error:
        "Orders from the terminal are off. Set orders.enabled in opencharts.config.ts.",
    });
  }

  if (resource === "orders" && parts.length === 1) {
    const body = await readJson(req);
    if (!body) return reply(400, { error: "Body must be a JSON object" });
    const ticker = options.toAlpaca(String(body.ticker ?? ""));
    if (!ticker)
      return reply(404, { error: `Unknown symbol "${String(body.ticker)}"` });
    if (body.side !== "buy" && body.side !== "sell")
      return reply(400, { error: 'side must be "buy" or "sell"' });
    const result = await orders.place(
      {
        ticker,
        side: body.side,
        qty: optionalNumber(body.qty),
        stop: optionalNumber(body.stop),
        target: optionalNumber(body.target),
        reason:
          typeof body.reason === "string" && body.reason
            ? body.reason
            : "terminal order",
      },
      "terminal",
    );
    return reply(result.ok ? 200 : 422, result);
  }
  if (
    resource === "orders" &&
    action === "cancel" &&
    id &&
    parts.length === 3
  ) {
    // The desk refuses stops, targets and partly filled entries.
    const result = await orders.cancel(id, "terminal");
    return reply("error" in result ? result.status : 200, result);
  }
  if (
    resource === "positions" &&
    action === "close" &&
    id &&
    parts.length === 3
  ) {
    // Any held position can be closed, even one no longer on the watchlist.
    const held = (await trading.getPositions()).find(
      (p) => p.symbol.replace("/", "") === id,
    );
    const ticker = options.toAlpaca(id) ?? held?.symbol;
    if (!ticker || !held)
      return reply(404, { error: `No open position in "${id}"` });
    const result = await orders.place(
      { ticker, side: "sell", reason: "closed from the terminal" },
      "terminal",
    );
    return reply(result.ok ? 200 : 422, result);
  }
  return false;
}

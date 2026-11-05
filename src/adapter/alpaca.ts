import type {
  Account,
  Candle,
  Order,
  Position,
  Symbol,
} from "../services/schemas.ts";
import type {
  CandleRequest,
  TradingGateway,
  ConnectionState,
  MarketDataSource,
  MarketEvent,
  OpenChartsAdapter,
  Quote,
  Unsubscribe,
} from "./types.ts";

/**
 * Market data from Alpaca, through the OpenCharts backend in `server/`.
 *
 * The browser never talks to Alpaca and never sees the keys: it calls the
 * backend's `/api/*` routes, and live prices arrive as Server-Sent Events
 * from `/api/stream`. Trading goes through `/api/trading/*`, where the backend
 * applies the desk's rules (approval, stop, hard limits) to every order.
 */

export interface AlpacaAdapterOptions {
  /** Backend origin. Defaults to the page's own origin. */
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Split an SSE buffer into complete `data:` payloads and the unfinished rest. */
export function parseSseChunk(buffer: string): {
  events: string[];
  rest: string;
} {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data.length > 0);
  return { events, rest };
}

export function createAlpacaMarketData(
  options: AlpacaAdapterOptions = {},
): MarketDataSource {
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const handlers = new Set<(event: MarketEvent) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let state: ConnectionState = "disconnected";
  let abort: AbortController | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) {
      try {
        listener(next);
      } catch (err) {
        console.error("[alpaca] connection listener threw", err);
      }
    }
  };

  const emit = (event: MarketEvent) => {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (err) {
        console.error("[alpaca] subscriber threw", err);
      }
    }
  };

  const getJson = async <T>(path: string): Promise<T> => {
    const response = await doFetch(`${base}${path}`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        body?.error ?? `Backend ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as T;
  };

  const scheduleReconnect = () => {
    setState("reconnecting");
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => void open(), delay);
  };

  const open = async () => {
    if (abort) return;
    const controller = new AbortController();
    abort = controller;
    setState(attempt === 0 ? "connecting" : "reconnecting");
    try {
      const response = await doFetch(`${base}/api/stream`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`stream ${response.status}`);
      attempt = 0;
      setState("connected");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const data of events) {
          try {
            emit(JSON.parse(data) as MarketEvent);
          } catch {
            // A malformed frame is not worth dropping the stream for.
          }
        }
      }
    } catch {
      // Aborted by disconnect(), or the network dropped; handled below.
    }
    if (abort !== controller) return;
    abort = null;
    if (controller.signal.aborted) return;
    scheduleReconnect();
  };

  return {
    getSymbols: () => getJson<Symbol[]>("/api/symbols"),

    getCandles: (request: CandleRequest) => {
      const params = new URLSearchParams({
        symbol: request.symbol,
        timeframe: request.timeframe,
      });
      if (request.limit != null) params.set("limit", String(request.limit));
      if (request.fromMs != null) params.set("fromMs", String(request.fromMs));
      if (request.toMs != null) params.set("toMs", String(request.toMs));
      return getJson<Candle[]>(`/api/candles?${params.toString()}`);
    },

    getQuote: (symbol: string) =>
      getJson<Quote | null>(
        `/api/quote?symbol=${encodeURIComponent(symbol)}`,
      ).catch(() => null),

    subscribe: (handler: (event: MarketEvent) => void): Unsubscribe => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    connect: () => {
      void open();
    },

    disconnect: () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const controller = abort;
      abort = null;
      controller?.abort();
      setState("disconnected");
    },

    getConnectionState: () => state,

    onConnectionChange: (listener) => {
      stateListeners.add(listener);
      listener(state);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}

/** What the backend returns; see server/alpaca.ts. */
interface BackendAccount {
  mode: "paper" | "live";
  ordersEnabled: boolean;
  equity: number;
  lastEquity: number;
  buyingPower: number;
}
interface BackendPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPl: number;
}
interface BackendOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  filledQty: number;
  status: string;
  stopPrice: number | null;
  limitPrice: number | null;
  orderClass: string;
}
interface BackendOrderResult {
  ok: boolean;
  rejected: string[];
  orders: BackendOrder[];
  note?: string;
}

/** One Alpaca account per backend, so a fixed id is enough. */
export const ALPACA_ACCOUNT_ID = "00000000-0000-4000-8000-00000000a1ac";

const terminalName = (symbol: string) => symbol.replace("/", "");

function toOrder(o: BackendOrder): Order {
  const now = new Date().toISOString();
  return {
    id: o.id,
    accountId: ALPACA_ACCOUNT_ID,
    symbolName: terminalName(o.symbol),
    side: o.side === "buy" ? "BUY" : "SELL",
    type:
      o.type === "market" ? "MARKET" : o.type === "limit" ? "LIMIT" : "STOP",
    quantity: o.qty,
    price: o.limitPrice,
    stopPrice: o.stopPrice,
    takeProfit: null,
    stopLoss: null,
    // Everything the backend lists is still working.
    status: "NEW",
    filledQuantity: o.filledQty,
    avgFillPrice: null,
    comment: o.orderClass || null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createAlpacaTrading(
  options: AlpacaAdapterOptions = {},
): TradingGateway {
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${base}/api/trading${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : { "content-type": "application/json", "x-opencharts": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as
      | (T & { error?: string; rejected?: string[] })
      | null;
    if (!response.ok) {
      throw new Error(
        json?.rejected?.join("; ") ||
          json?.error ||
          `Backend ${response.status} ${response.statusText}`,
      );
    }
    return json as T;
  };
  const orders = () => call<BackendOrder[]>("/orders");

  return {
    async getAccounts(): Promise<Account[]> {
      const a = await call<BackendAccount>("/account");
      const now = new Date().toISOString();
      const label = `Alpaca ${a.mode.toUpperCase()}`;
      return [
        {
          id: ALPACA_ACCOUNT_ID,
          userId: "owner",
          templateId: "alpaca",
          label,
          status: "ACTIVE",
          balance: a.equity,
          equity: a.equity,
          margin: 0,
          freeMargin: a.buyingPower,
          phase: a.mode.toUpperCase(),
          startDate: now,
          createdAt: now,
          updatedAt: now,
          isHftMode: false,
          template: {
            name: label,
            startingBalance: a.lastEquity,
            instrumentType: "EQUITIES",
          },
        },
      ];
    },

    async getPositions(): Promise<Position[]> {
      const [positions, open] = await Promise.all([
        call<BackendPosition[]>("/positions"),
        orders(),
      ]);
      return positions.map((p) => {
        const name = terminalName(p.symbol);
        const exits = open.filter(
          (o) => o.side === "sell" && terminalName(o.symbol) === name,
        );
        const stop = exits.find((o) => o.stopPrice != null);
        const target = exits.find((o) => o.type === "limit");
        return {
          id: name,
          accountId: ALPACA_ACCOUNT_ID,
          symbolName: name,
          side: "LONG",
          quantity: p.qty,
          entryPrice: p.avgEntryPrice,
          currentPrice: p.currentPrice,
          unrealizedPnl: p.unrealizedPl,
          margin: 0,
          contractSize: 1,
          // Alpaca's position has no open time.
          openedAt: new Date().toISOString(),
          takeProfit: target?.limitPrice ?? null,
          stopLoss: stop?.stopPrice ?? null,
        };
      });
    },

    getOrders: async () => (await orders()).map(toOrder),

    getClosedPositions: async (_accountId, page = 1) => ({
      data: [],
      total: 0,
      page,
      pageSize: 50,
      totalPages: 0,
    }),

    async placeOrder(input) {
      if (input.side === "SELL")
        throw new Error(
          "This desk is long only. Close a position from the Positions table.",
        );
      if (input.type !== "MARKET")
        throw new Error(
          "Only market orders: stocks go in as a GTC bracket with your stop.",
        );
      const result = await call<BackendOrderResult>("/orders", {
        ticker: input.symbol,
        side: "buy",
        qty: input.quantity,
        stop: input.stopLoss,
        target: input.takeProfit,
      });
      const first = result.orders[0];
      if (!first) throw new Error(result.note ?? "The backend placed no order");
      return toOrder(first);
    },

    modifyOrder: () =>
      Promise.reject(new Error("Changing an order is not supported yet.")),
    modifyPosition: () =>
      Promise.reject(
        new Error("Changing a stop or target is not supported yet."),
      ),

    async cancelOrder(orderId) {
      await call(`/orders/${encodeURIComponent(orderId)}/cancel`, {});
    },
    async cancelAllOrders() {
      for (const o of await orders()) {
        if (o.side === "buy")
          await call(`/orders/${encodeURIComponent(o.id)}/cancel`, {});
      }
    },

    async closePosition(positionId, quantity) {
      if (quantity != null) {
        const held = (await call<BackendPosition[]>("/positions")).find(
          (p) => terminalName(p.symbol) === positionId,
        );
        if (held && quantity < held.qty)
          throw new Error(
            "Partial closes are not supported. Close the whole position.",
          );
      }
      await call(`/positions/${encodeURIComponent(positionId)}/close`, {});
    },
    async closeAllPositions() {
      for (const p of await call<BackendPosition[]>("/positions"))
        await call(
          `/positions/${encodeURIComponent(terminalName(p.symbol))}/close`,
          {},
        );
    },

    // shortcut: no push channel; the terminal re-syncs every 30s and after each action.
    subscribe: () => () => {},
  };
}

export function createAlpacaAdapter(
  options: AlpacaAdapterOptions & { trading?: boolean } = {},
): OpenChartsAdapter {
  return {
    name: "alpaca",
    marketData: createAlpacaMarketData(options),
    ...(options.trading && { trading: createAlpacaTrading(options) }),
  };
}

/** The adapter, with trading only when the backend has an Alpaca account behind it. */
export async function loadAlpacaAdapter(options: AlpacaAdapterOptions = {}) {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const probe = await doFetch(`${base}/api/trading/account`).catch(() => null);
  return createAlpacaAdapter({ ...options, trading: probe?.ok === true });
}

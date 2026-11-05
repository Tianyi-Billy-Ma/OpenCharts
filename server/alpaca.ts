/**
 * A thin Alpaca client: bars, latest quotes, the live quote stream and news,
 * for US stocks (free IEX feed) and crypto, plus read-only account positions.
 *
 * Only this file knows Alpaca's URLs and field names. Everything it returns is
 * already in OpenCharts' shape: candles in seconds, oldest first.
 */

import type { Candle } from "../src/services/schemas.ts";

const DATA_BASE = "https://data.alpaca.markets";
const PAPER_BASE = "https://paper-api.alpaca.markets";

/**
 * Alpaca keys from the environment. Also reads the names Alpaca's own SDKs
 * (APCA_API_*) and official MCP server (ALPACA_API_KEY) use, so one set of
 * secrets serves both.
 */
export function alpacaCredentialsFromEnv(
  env: Record<string, string | undefined>,
): AlpacaCredentials | undefined {
  const keyId = env.ALPACA_KEY_ID || env.ALPACA_API_KEY || env.APCA_API_KEY_ID;
  const secretKey = env.ALPACA_SECRET_KEY || env.APCA_API_SECRET_KEY;
  return keyId && secretKey ? { keyId, secretKey } : undefined;
}
const LIVE_BASE = "https://api.alpaca.markets";
const STOCK_STREAM = "wss://stream.data.alpaca.markets/v2/iex";
const CRYPTO_STREAM = "wss://stream.data.alpaca.markets/v1beta3/crypto/us";

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
}

export interface BarsRequest {
  /** Alpaca symbol: "NVDA" or "BTC/USD". */
  symbol: string;
  /** OpenCharts timeframe: "1m" … "1w". */
  timeframe: string;
  limit?: number;
  fromMs?: number;
  /** Exclusive. */
  toMs?: number;
}

export interface AlpacaQuote {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface NewsItem {
  headline: string;
  summary: string;
  source: string;
  url: string;
  symbols: string[];
  /** Epoch ms. */
  time: number;
}

export interface Position {
  symbol: string;
  qty: number;
  side: string;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  assetClass: string;
}

export interface Account {
  equity: number;
  /** Equity at the previous close, for the daily loss stop. */
  lastEquity: number;
  buyingPower: number;
  tradingBlocked: boolean;
}

export interface Order {
  id: string;
  /** As Alpaca returns it: "NVDA", or "BTC/USD" for crypto. */
  symbol: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  /** Already executed; `qty - filledQty` is what is still working. */
  filledQty: number;
  status: string;
  stopPrice: number | null;
  limitPrice: number | null;
  orderClass: string;
  /** Bracket and OTO child orders (the stop and target legs). */
  legs: Order[];
}

/** An order request in Alpaca's own field names (POST /v2/orders). */
export type OrderRequest = Record<string, unknown>;

/** The account side: orders and positions. Paper unless `live` was set. */
export interface Trading {
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  /** Open orders, with bracket legs nested. */
  getOpenOrders(): Promise<Order[]>;
  getOrder(id: string): Promise<Order>;
  placeOrder(request: OrderRequest): Promise<Order>;
  cancelOrder(id: string): Promise<void>;
  closePosition(symbol: string): Promise<void>;
}

export interface MarketData {
  getBars(request: BarsRequest): Promise<Candle[]>;
  getQuote(symbol: string): Promise<AlpacaQuote | null>;
  /** Stream quotes for these symbols. Returns a stop function. */
  streamQuotes(symbols: string[], onQuote: (quote: AlpacaQuote) => void): () => void;
  /** Newest first. Symbols in Alpaca form; empty means all news. */
  getNews(symbols: string[], limit: number): Promise<NewsItem[]>;
  /** Open positions on the account (paper unless `live` was set). */
  getPositions(): Promise<Position[]>;
}

const TIMEFRAMES: Record<string, { alpaca: string; seconds: number }> = {
  "1m": { alpaca: "1Min", seconds: 60 },
  "5m": { alpaca: "5Min", seconds: 300 },
  "15m": { alpaca: "15Min", seconds: 900 },
  "30m": { alpaca: "30Min", seconds: 1800 },
  "1h": { alpaca: "1Hour", seconds: 3600 },
  "4h": { alpaca: "4Hour", seconds: 14_400 },
  "1d": { alpaca: "1Day", seconds: 86_400 },
  "1w": { alpaca: "1Week", seconds: 604_800 },
};

/** Bar length in seconds, or undefined for an unknown timeframe. */
export const timeframeSeconds = (timeframe: string) => TIMEFRAMES[timeframe]?.seconds;

const DEFAULT_LIMIT = 500;
/** Total bars per request; also Alpaca's per-page maximum. */
export const MAX_LIMIT = 10_000;
/** Stops a misbehaving `next_page_token` loop. */
const MAX_PAGES = 20;
const DAY_MS = 86_400_000;

export const isCrypto = (symbol: string) => symbol.includes("/");

/**
 * Build the bars URL for one request.
 *
 * Alpaca needs a `start`, so "the latest N bars" is asked for newest-first
 * (`sort=desc`) from a start far enough back to hold N bars, then reversed by
 * the caller. Stocks trade ~6.5 of 24 hours, 5 days a week, hence the wider
 * look-back for them.
 */
export function buildBarsUrl(request: BarsRequest, nowMs = Date.now()): URL | null {
  const tf = TIMEFRAMES[request.timeframe];
  if (!tf) return null;

  const crypto = isCrypto(request.symbol);
  const url = crypto
    ? new URL(`${DATA_BASE}/v1beta3/crypto/us/bars`)
    : new URL(`${DATA_BASE}/v2/stocks/${encodeURIComponent(request.symbol)}/bars`);
  if (crypto) url.searchParams.set("symbols", request.symbol);
  else {
    url.searchParams.set("feed", "iex");
    url.searchParams.set("adjustment", "split");
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(request.limit ?? DEFAULT_LIMIT)));
  url.searchParams.set("timeframe", tf.alpaca);
  url.searchParams.set("limit", String(limit));

  // The contract's `toMs` is exclusive; Alpaca's `end` is inclusive.
  const endMs = request.toMs != null ? Math.floor(request.toMs) - 1 : nowMs;
  url.searchParams.set("end", new Date(endMs).toISOString());

  if (request.fromMs != null) {
    url.searchParams.set("start", new Date(Math.floor(request.fromMs)).toISOString());
    url.searchParams.set("sort", "asc");
  } else {
    const stretch = crypto ? 2 : tf.seconds < 86_400 ? 7 : 1.6;
    const lookBackMs = limit * tf.seconds * 1000 * stretch + 5 * DAY_MS;
    url.searchParams.set("start", new Date(endMs - lookBackMs).toISOString());
    url.searchParams.set("sort", "desc");
  }
  return url;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function barToCandle(bar: AlpacaBar): Candle {
  return {
    time: Math.floor(Date.parse(bar.t) / 1000),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  };
}

/** Pull the bar list out of either response shape and return it oldest first. */
export function parseBars(body: unknown, symbol: string): Candle[] {
  const raw = (body as { bars?: AlpacaBar[] | Record<string, AlpacaBar[]> | null }).bars;
  const bars = Array.isArray(raw) ? raw : (raw?.[symbol] ?? []);
  return bars
    .map(barToCandle)
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

export interface AlpacaClientOptions {
  credentials?: AlpacaCredentials;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
  log?: (message: string) => void;
  /** Use the live trading account instead of paper. Default false. */
  live?: boolean;
}

export function createAlpacaClient(options: AlpacaClientOptions = {}): MarketData & Trading {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const SocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
  const log = options.log ?? ((m: string) => console.log(`[alpaca] ${m}`));
  const creds = options.credentials;

  const headers = (): Record<string, string> =>
    creds ? { "APCA-API-KEY-ID": creds.keyId, "APCA-API-SECRET-KEY": creds.secretKey } : {};

  const getJson = async (
    url: URL,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    // Crypto data is public; stock data and the account need keys.
    if (!creds && !url.pathname.includes("/crypto/")) {
      throw new Error("This needs Alpaca keys: set ALPACA_KEY_ID and ALPACA_SECRET_KEY.");
    }
    const response = await doFetch(url, {
      method: init.method ?? "GET",
      headers: {
        ...headers(),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Alpaca ${response.status}: ${detail.slice(0, 200) || response.statusText}`);
    }
    return response.status === 204 ? null : response.json();
  };
  const trading = (path: string) => new URL(`${options.live ? LIVE_BASE : PAPER_BASE}${path}`);
  const toOrder = (o: Record<string, unknown>): Order => ({
    id: String(o.id),
    symbol: String(o.symbol),
    side: o.side as Order["side"],
    type: String(o.type),
    qty: Number(o.qty),
    filledQty: Number(o.filled_qty ?? 0),
    status: String(o.status),
    stopPrice: o.stop_price == null ? null : Number(o.stop_price),
    limitPrice: o.limit_price == null ? null : Number(o.limit_price),
    orderClass: String(o.order_class ?? "simple"),
    legs: ((o.legs as Record<string, unknown>[] | null) ?? []).map(toOrder),
  });

  return {
    async getBars(request) {
      const url = buildBarsUrl(request);
      if (!url) return [];
      const wanted = Number(url.searchParams.get("limit"));
      // A page can hold fewer bars than asked for, so follow next_page_token.
      const candles: Candle[] = [];
      // Query params stay fixed across pages; only page_token changes.
      for (let page = 0; page < MAX_PAGES && candles.length < wanted; page++) {
        const body = (await getJson(url)) as { next_page_token?: string | null };
        candles.push(...parseBars(body, request.symbol));
        if (!body.next_page_token) break;
        url.searchParams.set("page_token", body.next_page_token);
      }
      // Newest-first requests keep the newest `wanted` bars; windowed ones the oldest.
      candles.sort((a, b) => a.time - b.time);
      return url.searchParams.get("sort") === "desc"
        ? candles.slice(-wanted)
        : candles.slice(0, wanted);
    },

    async getQuote(symbol) {
      const url = isCrypto(symbol)
        ? new URL(
            `${DATA_BASE}/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(symbol)}`,
          )
        : new URL(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`);
      const body = (await getJson(url)) as {
        quote?: { bp: number; ap: number; t: string };
        quotes?: Record<string, { bp: number; ap: number; t: string }>;
      };
      const q = body.quote ?? body.quotes?.[symbol];
      if (!q) return null;
      return { symbol, bid: q.bp, ask: q.ap, timestamp: Date.parse(q.t) };
    },

    async getNews(symbols, limit) {
      const url = new URL(`${DATA_BASE}/v1beta1/news`);
      // News lists crypto as "BTCUSD".
      if (symbols.length)
        url.searchParams.set("symbols", symbols.map((s) => s.replace("/", "")).join(","));
      url.searchParams.set("limit", String(Math.min(Math.max(1, Math.floor(limit)), 50)));
      const body = (await getJson(url)) as {
        news?: Array<{
          headline: string;
          summary: string;
          source: string;
          url: string;
          symbols: string[];
          created_at: string;
        }>;
      };
      return (body.news ?? []).map((n) => ({
        headline: n.headline,
        summary: n.summary,
        source: n.source,
        url: n.url,
        symbols: n.symbols,
        time: Date.parse(n.created_at),
      }));
    },

    async getPositions() {
      const body = (await getJson(trading("/v2/positions"))) as Array<Record<string, string>>;
      return body.map((p) => ({
        symbol: p.symbol!,
        qty: Number(p.qty),
        side: p.side!,
        avgEntryPrice: Number(p.avg_entry_price),
        currentPrice: Number(p.current_price),
        marketValue: Number(p.market_value),
        unrealizedPl: Number(p.unrealized_pl),
        unrealizedPlPct: Number(p.unrealized_plpc) * 100,
        assetClass: p.asset_class ?? "us_equity",
      }));
    },

    async getAccount() {
      const a = (await getJson(trading("/v2/account"))) as Record<string, unknown>;
      return {
        equity: Number(a.equity),
        lastEquity: Number(a.last_equity),
        buyingPower: Number(a.buying_power),
        tradingBlocked: Boolean(a.trading_blocked || a.account_blocked),
      };
    },

    async getOpenOrders() {
      const url = trading("/v2/orders");
      url.searchParams.set("status", "open");
      url.searchParams.set("nested", "true");
      url.searchParams.set("limit", "500");
      return ((await getJson(url)) as Record<string, unknown>[]).map(toOrder);
    },

    async getOrder(id) {
      return toOrder(
        (await getJson(trading(`/v2/orders/${encodeURIComponent(id)}?nested=true`))) as Record<
          string,
          unknown
        >,
      );
    },

    async placeOrder(request) {
      return toOrder(
        (await getJson(trading("/v2/orders"), { method: "POST", body: request })) as Record<
          string,
          unknown
        >,
      );
    },

    async cancelOrder(id) {
      await getJson(trading(`/v2/orders/${encodeURIComponent(id)}`), { method: "DELETE" });
    },

    async closePosition(symbol) {
      // Positions use "BTCUSD" for crypto.
      await getJson(trading(`/v2/positions/${encodeURIComponent(symbol.replace("/", ""))}`), {
        method: "DELETE",
      });
    },

    streamQuotes(symbols, onQuote) {
      if (!creds) {
        log("no keys set, so there is no live stream (charts still load)");
        return () => {};
      }
      const streams: Array<[string, string[]]> = [
        [STOCK_STREAM, symbols.filter((s) => !isCrypto(s))],
        [CRYPTO_STREAM, symbols.filter(isCrypto)],
      ];
      const stops = streams
        .filter(([, list]) => list.length > 0)
        .map(([url, list]) => openStream(SocketImpl, url, creds, list, onQuote, log));
      return () => stops.forEach((stop) => stop());
    },
  };
}

/** One upstream socket with auth, subscribe and capped reconnect backoff. */
function openStream(
  SocketImpl: typeof WebSocket,
  url: string,
  creds: AlpacaCredentials,
  symbols: string[],
  onQuote: (quote: AlpacaQuote) => void,
  log: (message: string) => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    socket = new SocketImpl(url);
    socket.onopen = () => {
      socket?.send(JSON.stringify({ action: "auth", key: creds.keyId, secret: creds.secretKey }));
    };
    socket.onmessage = (event: MessageEvent) => {
      let messages: Array<Record<string, unknown>>;
      try {
        messages = JSON.parse(String(event.data));
      } catch {
        return;
      }
      for (const m of messages) {
        if (m.T === "success" && m.msg === "authenticated") {
          attempt = 0;
          socket?.send(JSON.stringify({ action: "subscribe", quotes: symbols }));
        } else if (m.T === "error") {
          log(`stream error ${String(m.code)}: ${String(m.msg)}`);
        } else if (m.T === "q" && typeof m.S === "string") {
          const bid = Number(m.bp);
          const ask = Number(m.ap);
          if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid && bid > 0) {
            onQuote({ symbol: m.S, bid, ask, timestamp: Date.parse(String(m.t)) || Date.now() });
          }
        }
      }
    };
    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
    socket.onerror = () => {
      // onclose follows and handles the reconnect.
    };
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}

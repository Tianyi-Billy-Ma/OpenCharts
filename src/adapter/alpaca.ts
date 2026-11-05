import type { Candle, Symbol } from "../services/schemas.ts";
import type {
  CandleRequest,
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
 * from `/api/stream`. Read-only for now; trading is added in a later step.
 */

export interface AlpacaAdapterOptions {
  /** Backend origin. Defaults to the page's own origin. */
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Split an SSE buffer into complete `data:` payloads and the unfinished rest. */
export function parseSseChunk(buffer: string): { events: string[]; rest: string } {
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

export function createAlpacaMarketData(options: AlpacaAdapterOptions = {}): MarketDataSource {
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
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Backend ${response.status} ${response.statusText}`);
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
      const response = await doFetch(`${base}/api/stream`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
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
      const params = new URLSearchParams({ symbol: request.symbol, timeframe: request.timeframe });
      if (request.limit != null) params.set("limit", String(request.limit));
      if (request.fromMs != null) params.set("fromMs", String(request.fromMs));
      if (request.toMs != null) params.set("toMs", String(request.toMs));
      return getJson<Candle[]>(`/api/candles?${params.toString()}`);
    },

    getQuote: (symbol: string) =>
      getJson<Quote | null>(`/api/quote?symbol=${encodeURIComponent(symbol)}`).catch(() => null),

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

export function createAlpacaAdapter(options: AlpacaAdapterOptions = {}): OpenChartsAdapter {
  return { name: "alpaca", marketData: createAlpacaMarketData(options) };
}

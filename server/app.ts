import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Symbol } from "../src/services/schemas.ts";
import { closedBars, deskSignal } from "../src/lib/desk-signal.ts";
import { isCrypto, timeframeSeconds, type AlpacaQuote, type MarketData } from "./alpaca.ts";
import type { OpenChartsConfig } from "./config.ts";

/**
 * The OpenCharts backend's HTTP surface. The browser talks only to this; the
 * Alpaca keys stay on the server.
 *
 *   GET /api/health                  liveness and whether keys are set
 *   GET /api/symbols                 the configured watchlist as OpenCharts symbols
 *   GET /api/candles?symbol&timeframe[&limit][&fromMs][&toMs]
 *   GET /api/quote?symbol
 *   GET /api/stream                  Server-Sent Events: {"type":"tick",...}
 *   GET /api/desk-signal?symbol[&timeframe][&limit]   Desk Signal on closed bars, newest last
 *
 * Anything else is served from the built frontend in `dist/`.
 */

export interface AppOptions {
  config: OpenChartsConfig;
  marketData: MarketData;
  hasKeys: boolean;
  /** Built frontend to serve. Skipped when the folder is missing. */
  staticDir?: string;
}

const TIMEFRAMES = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]);
const HEARTBEAT_MS = 15_000;
/** A tab that stops reading gets dropped once this much is queued for it. */
const MAX_CLIENT_BUFFER_BYTES = 1_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** "BTC/USD" shows in the terminal as "BTCUSD"; stock tickers are unchanged. */
export const toTerminalName = (alpacaSymbol: string) => alpacaSymbol.replace("/", "");

const STOCK_HOURS = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  openTime: "09:30",
  closeTime: "16:00",
}));

function toSymbol(alpacaSymbol: string): Symbol {
  const crypto = isCrypto(alpacaSymbol);
  const name = toTerminalName(alpacaSymbol);
  return {
    id: name,
    name,
    displayName: alpacaSymbol,
    category: crypto ? "CRYPTO" : "STOCKS",
    contractSize: 1,
    tickSize: 0.01,
    tickValue: 0.01,
    marginPercent: 100,
    maxLeverage: 1,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: crypto ? null : "09:30",
    tradingHoursEnd: crypto ? null : "16:00",
    isActive: true,
    // Read by the market-closed banner; regular US session only.
    ...(crypto ? {} : { tradingHours: STOCK_HOURS, sessionTimezone: "America/New_York" }),
  } as Symbol;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function optionalNumber(value: string | null): number | undefined | null {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : null; // null = present but invalid
}

export function createApp(options: AppOptions): { server: Server; close: () => void } {
  const { config, marketData, hasKeys } = options;
  const alpacaSymbols = [...config.watchlist.stocks, ...config.watchlist.crypto];
  const byTerminalName = new Map(alpacaSymbols.map((s) => [toTerminalName(s), s]));
  const symbols = alpacaSymbols.map(toSymbol);

  // One upstream stream, fanned out to every browser tab.
  const clients = new Set<ServerResponse>();
  const broadcast = (quote: AlpacaQuote) => {
    const frame = `data: ${JSON.stringify({
      type: "tick",
      symbol: toTerminalName(quote.symbol),
      bid: quote.bid,
      ask: quote.ask,
      timestamp: quote.timestamp,
    })}\n\n`;
    for (const res of clients) {
      if (res.writableLength > MAX_CLIENT_BUFFER_BYTES) {
        clients.delete(res);
        res.destroy(); // the adapter reconnects and starts fresh
        continue;
      }
      res.write(frame);
    }
  };
  const stopUpstream = marketData.streamQuotes(alpacaSymbols, broadcast);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  const staticDir =
    options.staticDir && existsSync(options.staticDir) ? resolve(options.staticDir) : null;

  const handleApi = async (url: URL, req: IncomingMessage, res: ServerResponse) => {
    const symbolParam = url.searchParams.get("symbol") ?? "";
    const alpacaSymbol = byTerminalName.get(symbolParam);

    switch (url.pathname) {
      case "/api/health":
        return sendJson(res, 200, { ok: true, keys: hasKeys, symbols: symbols.length });

      case "/api/symbols":
        return sendJson(res, 200, symbols);

      case "/api/candles": {
        const timeframe = url.searchParams.get("timeframe") ?? "";
        if (!alpacaSymbol) return sendJson(res, 404, { error: `Unknown symbol "${symbolParam}"` });
        if (!TIMEFRAMES.has(timeframe))
          return sendJson(res, 400, { error: `Bad timeframe "${timeframe}"` });
        const limit = optionalNumber(url.searchParams.get("limit"));
        const fromMs = optionalNumber(url.searchParams.get("fromMs"));
        const toMs = optionalNumber(url.searchParams.get("toMs"));
        if (limit === null || fromMs === null || toMs === null) {
          return sendJson(res, 400, { error: "limit, fromMs and toMs must be numbers" });
        }
        const candles = await marketData.getBars({
          symbol: alpacaSymbol,
          timeframe,
          limit,
          fromMs,
          toMs,
        });
        return sendJson(res, 200, candles);
      }

      case "/api/quote": {
        if (!alpacaSymbol) return sendJson(res, 404, { error: `Unknown symbol "${symbolParam}"` });
        const quote = await marketData.getQuote(alpacaSymbol);
        return sendJson(res, 200, quote && { ...quote, symbol: symbolParam });
      }

      case "/api/desk-signal": {
        const timeframe = url.searchParams.get("timeframe") ?? config.deskSignal.timeframe;
        const limit = optionalNumber(url.searchParams.get("limit")) ?? 100;
        if (!alpacaSymbol) return sendJson(res, 404, { error: `Unknown symbol "${symbolParam}"` });
        const seconds = timeframeSeconds(timeframe);
        if (!seconds) return sendJson(res, 400, { error: `Bad timeframe "${timeframe}"` });
        if (limit === null || limit < 1)
          return sendJson(res, 400, { error: "limit must be a positive number" });
        // EMA 200 and the 100-bar ATR rank need history before the bars returned.
        const warmUp =
          Math.max(...config.deskSignal.params.emaPeriods) + config.deskSignal.params.atrLookback;
        const bars = await marketData.getBars({
          symbol: alpacaSymbol,
          timeframe,
          limit: warmUp + Math.floor(limit) + 1,
        });
        const result = deskSignal(closedBars(bars, seconds), config.deskSignal.params);
        return sendJson(res, 200, {
          symbol: symbolParam,
          timeframe,
          bars: result.slice(-Math.floor(limit)),
        });
      }

      case "/api/stream": {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          // Stops nginx and similar proxies from buffering the stream.
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      default:
        return sendJson(res, 404, { error: "Not found" });
    }
  };

  const serveStatic = (url: URL, res: ServerResponse) => {
    if (!staticDir)
      return sendJson(res, 404, { error: "Frontend not built. Run `npm run build:desk`." });
    // normalize + prefix check keeps requests inside dist/.
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: "Bad path" });
    }
    let file = normalize(join(staticDir, pathname));
    if (!file.startsWith(staticDir + sep)) return sendJson(res, 403, { error: "Forbidden" });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, "index.html");
    const hashed = file.startsWith(join(staticDir, "assets") + sep);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(res);
  };

  const server = createServer((req, res) => {
    let url: URL;
    try {
      // Only the path matters; a fixed origin stops "//host" targets parsing as hosts.
      url = new URL(`http://localhost${req.url?.startsWith("/") ? req.url : "/"}`);
    } catch {
      return sendJson(res, 400, { error: "Bad request URL" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    if (url.pathname.startsWith("/api/")) {
      handleApi(url, req, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendJson(res, 502, { error: message });
        else res.end();
      });
      return;
    }
    try {
      serveStatic(url, res);
    } catch {
      // Last line of defence: one bad request must never take the server down.
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    }
  });

  return {
    server,
    close: () => {
      clearInterval(heartbeat);
      stopUpstream();
      for (const res of clients) res.end();
      clients.clear();
      server.close();
    },
  };
}

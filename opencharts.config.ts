/**
 * Your OpenCharts settings. Edit freely; anything left out uses the defaults
 * in server/config.ts. API keys go in `.env`, never here.
 */
export default {
  port: 8787,
  // Keep 127.0.0.1 unless the terminal sits behind an auth gate such as
  // Cloudflare Access. Docker sets 0.0.0.0 itself.
  host: "127.0.0.1",
  watchlist: {
    // AI-themed starter list. OpenAI and Anthropic are private, so their
    // biggest listed backers (MSFT, AMZN, GOOGL) stand in for them.
    stocks: ["NVDA", "MSFT", "GOOGL", "AMZN", "META", "AMD", "AVGO", "TSM", "PLTR"],
    crypto: ["BTC/USD", "ETH/USD", "SOL/USD"],
  },
  deskSignal: {
    // Bar size for Desk Signal. It only ever looks at closed bars.
    timeframe: "1d",
    // Uncomment to override any rule; see src/lib/desk-signal.ts for all of them.
    // params: { volumeMultiple: 1.5, rsiThreshold: 50, atrMaxPercentile: 0.9 },
  },
  // Hard limits. Our order tools reject orders that break them, and the
  // position guard alerts when positions do (on any order path).
  limits: { maxPositionPct: 10, maxOpenPositions: 5, dailyLossPct: 2 },
  // Our own MCP order tools for the Trader token. Off: use Alpaca's official MCP.
  orders: { enabled: false },
  // Every 5 minutes, make sure each open position has a live stop.
  // missingStop: "place" puts one in; "flatten" closes the position instead.
  guard: { enabled: true, missingStop: "place" },
};

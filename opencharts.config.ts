import type { OpenChartsConfig } from "./server/config.ts";

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
} satisfies Partial<OpenChartsConfig>;

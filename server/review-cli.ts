import { barCloseSeconds, closedBars, deskSignal } from "../src/lib/desk-signal.ts";
import {
  alpacaCredentialsFromEnv,
  createAlpacaClient,
  isCrypto,
  timeframeSeconds,
} from "./alpaca.ts";
import { runBacktest, type Trade } from "./backtest.ts";
import { loadConfig } from "./config.ts";
import { GO_LIVE_TRADING_DAYS, roundTrips, summarize, symbolKey } from "./review.ts";

/**
 * npm run review [-- --timeframe 1d] [--json]
 *
 * The go-live review: every paper trade on the Alpaca account next to a
 * backtest of the same symbols over the same window, and the trading-day count.
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
};

const config = await loadConfig();
const timeframe = flag("timeframe") ?? config.deskSignal.timeframe;
const seconds = timeframeSeconds(timeframe);
if (!seconds) fail(`Bad --timeframe "${timeframe}"`);

const credentials = alpacaCredentialsFromEnv(process.env);
if (!credentials)
  fail("The review reads the paper account: set ALPACA_KEY_ID and ALPACA_SECRET_KEY.");
const alpaca = createAlpacaClient({ credentials, log: () => {} });

const fills = await alpaca.getFills().catch(fail);
if (!fills.length) {
  console.log("No paper fills yet, so there is nothing to review.");
  process.exit(0);
}
const { trades: paper, open } = roundTrips(fills);
const start = fills[0]!.time;

// SPY's daily bars are the market's trading days.
const tradingDays = (
  await alpaca.getBars({ symbol: "SPY", timeframe: "1d", fromMs: start, limit: 10_000 }).catch(fail)
).length;

// Backtest the watchlist and anything traded, from the first paper fill, with earlier bars as warm-up.
// The whole watchlist, so trades the backtest took and paper missed show up too.
const watchlist = [...config.watchlist.stocks, ...config.watchlist.crypto];
const symbols = [...new Set([...watchlist, ...paper.map((t) => t.symbol), ...open].map(symbolKey))];
const perSymbol = [];
const backtestTrades: Trade[] = [];
for (const key of symbols) {
  const symbol = watchlist.find((s) => symbolKey(s) === key) ?? key;
  // shortcut: the newest 10,000 bars; enough unless the window runs past about a year of 1h crypto.
  const bars = await alpaca.getBars({ symbol, timeframe, limit: 10_000 }).catch(fail);
  const candles = closedBars(bars, barCloseSeconds(seconds!, !isCrypto(symbol)));
  const signals = deskSignal(candles, config.deskSignal.params);
  const from = candles.findIndex((c) => c.time * 1000 >= start);
  const result = from < 0 ? { trades: [] } : runBacktest(candles.slice(from), signals.slice(from));
  backtestTrades.push(...result.trades);
  const traded = paper.some((t) => symbolKey(t.symbol) === key);
  if (!traded && !result.trades.length) continue;
  perSymbol.push({
    symbol,
    paper: summarize(paper.filter((t) => symbolKey(t.symbol) === key)),
    backtest: summarize(result.trades),
  });
}
backtestTrades.sort((a, b) => a.entryTime - b.entryTime);

const report = {
  timeframe,
  since: new Date(start).toISOString().slice(0, 10),
  tradingDays,
  enoughDays: tradingDays >= GO_LIVE_TRADING_DAYS,
  paper: summarize(paper),
  backtest: summarize(backtestTrades),
  perSymbol,
  stillOpen: open,
};

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  const row = (label: string, s: ReturnType<typeof summarize>) =>
    `  ${label.padEnd(10)} ${String(s.trades).padStart(6)} ${`${(s.winRate * 100).toFixed(0)}%`.padStart(8)} ${pct(s.avgReturnPct).padStart(10)} ${pct(s.totalReturnPct).padStart(10)}`;
  console.log(`Go-live review: ${timeframe} bars, since ${report.since}`);
  console.log(
    `  trading days  ${tradingDays} of ${GO_LIVE_TRADING_DAYS}${report.enoughDays ? "" : " (not enough yet)"}`,
  );
  console.log(
    `\n  ${"".padEnd(10)} ${"trades".padStart(6)} ${"win rate".padStart(8)} ${"avg".padStart(10)} ${"total".padStart(10)}`,
  );
  console.log(row("paper", report.paper));
  console.log(row("backtest", report.backtest));
  for (const s of perSymbol) {
    console.log(`\n  ${s.symbol}`);
    console.log(row("paper", s.paper));
    console.log(row("backtest", s.backtest));
  }
  if (open.length) console.log(`\n  Still open, not counted: ${open.join(", ")}`);
  console.log(
    "\nGoing live needs both: enough trading days with paper close to the backtest, and the owner's written OK.",
  );
}

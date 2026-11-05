import { barCloseSeconds, closedBars, deskSignal } from "../src/lib/desk-signal.ts";
import {
  alpacaCredentialsFromEnv,
  createAlpacaClient,
  isCrypto,
  timeframeSeconds,
} from "./alpaca.ts";
import { runBacktest, type Trade } from "./backtest.ts";
import { loadConfig } from "./config.ts";
import { GO_LIVE_TRADING_DAYS, roundTrips, summarize, symbolKey, windowStart } from "./review.ts";

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

// SPY's daily bars are the market's trading days, counted from the first fill's New York date.
const nyDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const tradingDays = (
  await alpaca
    .getBars({ symbol: "SPY", timeframe: "1d", fromMs: start - 86_400_000, limit: 10_000 })
    .catch(fail)
).filter((b) => nyDate(b.time * 1000) >= nyDate(start)).length;

// Pages forward by date: the whole paper window, plus enough earlier bars to warm up the EMAs.
const WARMUP_BARS = 400;
const barsSince = async (symbol: string) => {
  const stretch = isCrypto(symbol) ? 1.2 : seconds! < 86_400 ? 7 : 1.6;
  let cursor = start - WARMUP_BARS * seconds! * 1000 * stretch - 5 * 86_400_000;
  const all = [];
  for (;;) {
    const page = await alpaca.getBars({ symbol, timeframe, fromMs: cursor, limit: 10_000 });
    all.push(...page);
    if (page.length < 10_000) return all;
    cursor = page[page.length - 1]!.time * 1000 + 1;
  }
};

// Backtest the watchlist and anything traded over the paper window.
// The whole watchlist, so trades the backtest took and paper missed show up too.
const watchlist = [...config.watchlist.stocks, ...config.watchlist.crypto];
// The Alpaca form of each traded symbol, preferring "BTC/USD" over "BTCUSD" so crypto stays crypto.
const traded = new Map<string, string>();
for (const f of fills)
  if (f.symbol.includes("/") || !traded.has(symbolKey(f.symbol)))
    traded.set(symbolKey(f.symbol), f.symbol);
const symbols = [...new Set([...watchlist.map(symbolKey), ...traded.keys()])];
const perSymbol = [];
const backtestTrades: Trade[] = [];
let backtestOpen = 0;
for (const key of symbols) {
  const symbol = watchlist.find((s) => symbolKey(s) === key) ?? traded.get(key)!;
  const bars = await barsSince(symbol).catch(fail);
  const candles = closedBars(bars, barCloseSeconds(seconds!, !isCrypto(symbol)));
  const signals = deskSignal(candles, config.deskSignal.params);
  const from = windowStart(candles, start);
  const all = runBacktest(candles.slice(from), signals.slice(from)).trades;
  // Like paper, only closed trades count; one still open at the last bar is listed apart.
  const closed = all.filter((t) => t.reason !== "end");
  backtestOpen += all.length - closed.length;
  backtestTrades.push(...closed);
  const paperHere = paper.filter((t) => symbolKey(t.symbol) === key);
  if (!paperHere.length && !closed.length) continue;
  perSymbol.push({ symbol, paper: summarize(paperHere), backtest: summarize(closed) });
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
  backtestStillOpen: backtestOpen,
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
  if (open.length) console.log(`\n  Still open on paper, not counted: ${open.join(", ")}`);
  if (backtestOpen) console.log(`  Still open in the backtest, not counted: ${backtestOpen}`);
  console.log(
    "\nGoing live needs both: enough trading days with paper close to the backtest, and the owner's written OK.",
  );
}

import { barCloseSeconds, closedBars, deskSignal } from "../src/lib/desk-signal.ts";
import { createAlpacaClient, isCrypto, timeframeSeconds } from "./alpaca.ts";
import { runBacktest } from "./backtest.ts";
import { loadConfig } from "./config.ts";

/**
 * npm run backtest -- NVDA [--timeframe 1d] [--years 3] [--json]
 *
 * Runs Desk Signal over Alpaca history with the rules in opencharts.config.ts.
 * Crypto uses Alpaca pairs: npm run backtest -- BTC/USD
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const symbol = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!symbol) {
  console.error("Usage: npm run backtest -- <SYMBOL> [--timeframe 1d] [--years 3] [--json]");
  process.exit(1);
}

const config = await loadConfig();
const timeframe = flag("timeframe") ?? config.deskSignal.timeframe;
const years = Number(flag("years") ?? 3);
const seconds = timeframeSeconds(timeframe);
if (!seconds || !(years > 0)) {
  console.error(`Bad --timeframe "${timeframe}" or --years "${flag("years")}"`);
  process.exit(1);
}

const keyId = process.env.ALPACA_KEY_ID;
const secretKey = process.env.ALPACA_SECRET_KEY;
const alpaca = createAlpacaClient({
  credentials: keyId && secretKey ? { keyId, secretKey } : undefined,
  log: () => {},
});

// shortcut: one request caps at 10,000 bars (about 3 years of 1h stock bars); page by date for longer runs.
const bars = await alpaca
  .getBars({ symbol, timeframe, fromMs: Date.now() - years * 365.25 * 86_400_000, limit: 10_000 })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
const candles = closedBars(bars, barCloseSeconds(seconds, !isCrypto(symbol)));
const result = runBacktest(candles, deskSignal(candles, config.deskSignal.params));

if (args.includes("--json")) {
  console.log(JSON.stringify({ symbol, timeframe, bars: candles.length, ...result }, null, 2));
} else {
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(`Desk Signal backtest: ${symbol} ${timeframe}, ${candles.length} closed bars`);
  if (candles.length)
    console.log(`  ${day(candles[0]!.time)} to ${day(candles[candles.length - 1]!.time)}`);
  console.log(`  trades        ${result.trades.length}`);
  console.log(`  win rate      ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`  avg trade     ${pct(result.avgReturnPct)}`);
  console.log(`  total         ${pct(result.totalReturnPct)}`);
  console.log(`  max drawdown  ${result.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  buy & hold    ${pct(result.buyAndHoldPct)}`);
  console.log(`  time in market ${(result.exposure * 100).toFixed(1)}%`);
  for (const t of result.trades.slice(-10)) {
    console.log(
      `  ${day(t.entryTime)} ${t.entry.toFixed(2)} -> ${day(t.exitTime)} ${t.exit.toFixed(2)}  ${pct(t.returnPct)} (${t.reason})`,
    );
  }
}

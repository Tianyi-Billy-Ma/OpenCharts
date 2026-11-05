import { volumeSma } from "../src/lib/indicators.ts";
import type { MarketData } from "./alpaca.ts";
import type { OpenChartsConfig } from "./config.ts";
import { deskSignalBars } from "./desk-tools.ts";
import type { SignalRecord, Store } from "./store.ts";
import { deliverWebhook, type DeliverOptions } from "./webhooks.ts";

/**
 * The signal scanner. Every few minutes it checks each watchlist symbol's
 * latest closed bar (on the configured timeframe) for a Desk Signal. A bar
 * counts once it has closed and `settleMinutes` have passed, so the final bar
 * is published: with daily bars that is just after 16:00 New York for stocks
 * and 00:00 UTC for crypto. Each new signal is saved once; approved tickers
 * then go to every webhook.
 */

export interface ScannerDeps {
  config: OpenChartsConfig;
  marketData: MarketData;
  store: Store;
  webhooks: { urls: string[]; secret: string } | null;
  deliver?: DeliverOptions;
  now?: () => number;
  log?: (message: string) => void;
}

const fmt = (n: number | null | undefined, digits = 2) => (n == null ? "n/a" : n.toFixed(digits));

/** The Grok Bot HANDOFF line: TICKER | IDEA | EVIDENCE | NEXT STEP. */
export function handoffText(s: Pick<SignalRecord, "symbol" | "timeframe" | "signal" | "detail">) {
  const d = s.detail as Record<string, number | string | null>;
  const buy = s.signal === "BUY";
  const lookback = d.breakoutLookback;
  const idea = buy
    ? `BUY: ${s.timeframe} close broke the ${lookback}-bar high`
    : `SELL: ${s.timeframe} close broke the ${lookback}-bar low`;
  const evidence = [
    `close ${fmt(d.close as number)} vs ${lookback}-bar ${buy ? "high" : "low"} ${fmt(d.breakoutLevel as number)}`,
    `volume ${fmt(d.volumeRatio as number, 1)}x its average`,
    `RSI ${fmt(d.rsi as number, 1)}`,
    `trend ${d.trend}`,
    `ATR ${fmt(d.atr as number)}`,
  ].join(", ");
  const next = buy
    ? `Trader: if risk allows, GTC bracket order; stop ${fmt(d.stop as number)} (${d.stopFrom})`
    : "Trader: exit or tighten the stop on any long; no shorts";
  return `${s.symbol} | ${idea} | ${evidence} | ${next}`;
}

export function createScanner(deps: ScannerDeps) {
  const { config, store, webhooks } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[scanner] ${m}`));
  const timeframe = config.deskSignal.timeframe;
  const params = config.deskSignal.params;
  const symbols = [...config.watchlist.stocks, ...config.watchlist.crypto];
  // Log a data error once, not on every pass, until it changes or clears.
  const lastError = new Map<string, string>();

  const send = async (signal: SignalRecord) => {
    const body = JSON.stringify({
      text: handoffText(signal),
      ticker: signal.symbol,
      signal: signal.signal,
      timeframe: signal.timeframe,
      barTime: new Date(signal.barTime * 1000).toISOString(),
      ...signal.detail,
    });
    const id = `${signal.symbol}:${signal.timeframe}:${signal.barTime}`;
    const results = await Promise.all(
      webhooks!.urls.map((url) => deliverWebhook(url, body, webhooks!.secret, id, deps.deliver)),
    );
    const ok = results.every((r) => r.ok);
    store.setWebhookResult(signal.id, ok ? "sent" : "failed", results);
    for (const r of results.filter((r) => !r.ok))
      log(`webhook to ${r.host} failed after ${r.attempts} tries: ${r.error}`);
  };

  /** One pass over the watchlist. Returns the signals that are new. */
  const scanOnce = async (): Promise<SignalRecord[]> => {
    const at = now();
    const settled = at - config.scanner.settleMinutes * 60_000;
    const found: SignalRecord[] = [];
    for (const symbol of symbols) {
      try {
        const { bars, candles } = await deskSignalBars(deps, symbol, timeframe, 1, settled);
        lastError.delete(symbol);
        const bar = bars[bars.length - 1];
        if (!bar?.signal) continue;
        const buy = bar.signal === "BUY";
        const prior = candles.slice(-1 - params.breakoutLookback, -1);
        const avgVol = volumeSma(candles.slice(0, -1), params.volumeLookback).at(-1)?.value;
        const swingStop = bar.swingLow != null && bar.swingLow < bar.close;
        const detail = {
          close: bar.close,
          breakoutLookback: params.breakoutLookback,
          breakoutLevel: buy
            ? Math.max(...prior.map((c) => c.high))
            : Math.min(...prior.map((c) => c.low)),
          volumeRatio: avgVol ? (candles.at(-1)?.volume ?? 0) / avgVol : null,
          rsi: bar.rsi,
          atr: bar.atr,
          trend: bar.trend,
          swingHigh: bar.swingHigh,
          swingLow: bar.swingLow,
          // Same stop rule as the backtest.
          stop: swingStop ? bar.swingLow : bar.atr != null ? bar.close - 2 * bar.atr : null,
          stopFrom: swingStop ? "last swing low" : "2x ATR",
        };
        const approved = store.isApproved(symbol, at);
        const webhook = !webhooks ? "no webhooks" : approved ? "pending" : "not approved";
        const saved = store.recordSignal(
          { symbol, timeframe, barTime: bar.time, signal: bar.signal, detail, webhook },
          at,
        );
        if (!saved) continue; // already seen this bar
        log(`${symbol} ${bar.signal} on ${new Date(bar.time * 1000).toISOString()} (${webhook})`);
        found.push(saved);
        // shortcut: a crash mid-send leaves the signal "pending" and it is not resent; resend on start if that matters.
        if (webhook === "pending") await send(saved);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (lastError.get(symbol) !== message) log(`${symbol}: ${message}`);
        lastError.set(symbol, message);
      }
    }
    return found;
  };

  return {
    scanOnce,
    /** Scan now and then every `everyMinutes`. Returns a stop function. */
    start() {
      let running = false;
      const tick = () => {
        if (running) return; // a slow pass (webhook retries) must not overlap the next
        running = true;
        scanOnce().finally(() => (running = false));
      };
      tick();
      const id = setInterval(tick, config.scanner.everyMinutes * 60_000);
      return () => clearInterval(id);
    },
  };
}

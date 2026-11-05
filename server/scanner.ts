import { volumeSma } from "../src/lib/indicators.ts";
import { isCrypto, timeframeSeconds, type MarketData } from "./alpaca.ts";
import type { OpenChartsConfig } from "./config.ts";
import { deskSignalBars } from "./desk-tools.ts";
import type { DeskSignalBar } from "../src/lib/desk-signal.ts";
import type { Candle } from "../src/services/schemas.ts";
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
/** Prices keep 4 significant digits below 1, so sub-cent coins never read as 0.00. */
const price = (n: number | null | undefined) =>
  n == null ? "n/a" : Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(4);

/** The Grok Bot HANDOFF line: TICKER | IDEA | EVIDENCE | NEXT STEP. */
export function handoffText(s: Pick<SignalRecord, "symbol" | "timeframe" | "signal" | "detail">) {
  const d = s.detail as Record<string, number | string | null>;
  const buy = s.signal === "BUY";
  const lookback = d.breakoutLookback;
  const idea = buy
    ? `BUY: ${s.timeframe} close broke the ${lookback}-bar high`
    : `SELL: ${s.timeframe} close broke the ${lookback}-bar low`;
  const evidence = [
    `close ${price(d.close as number)} vs ${lookback}-bar ${buy ? "high" : "low"} ${price(d.breakoutLevel as number)}`,
    `volume ${fmt(d.volumeRatio as number, 1)}x its average`,
    `RSI ${fmt(d.rsi as number, 1)}`,
    `trend ${d.trend}`,
    `ATR ${price(d.atr as number)}`,
  ].join(", ");
  const stop = `${price(d.stop as number)} (${d.stopFrom})`;
  // Alpaca has no bracket orders for crypto: enter, then place a separate stop-limit.
  const next = !buy
    ? "Trader: exit or tighten the stop on any long; no shorts"
    : isCrypto(s.symbol)
      ? `Trader: if risk allows, buy now, then a separate stop-limit sell at ${stop}`
      : `Trader: if risk allows, GTC bracket order; stop ${stop}`;
  return `${s.symbol} | ${idea} | ${evidence} | ${next}`;
}

/** Most bars one pass looks back over after a gap. */
const MAX_CATCH_UP_BARS = 500;

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
    store.addJournal(
      {
        agent: "scanner",
        ticker: signal.symbol,
        action: "webhook",
        outcome: results
          .map((r) => `${r.host}: ${r.ok ? "sent" : `failed (${r.error})`}`)
          .join("; "),
      },
      now(),
    );
    for (const r of results.filter((r) => !r.ok))
      log(`webhook to ${r.host} failed after ${r.attempts} tries: ${r.error}`);
  };

  const barSeconds = timeframeSeconds(timeframe) ?? 86_400;
  const everySeconds = config.scanner.everyMinutes * 60;
  // Newest bar checked per symbol, so a late or skipped pass still checks every bar since.
  // The first pass looks back one interval: older bars are history, not news.
  const lastChecked = new Map<string, number>();
  const barsToCheck = (symbol: string, settledMs: number) => {
    const since = lastChecked.get(symbol);
    if (since == null)
      return barSeconds >= everySeconds
        ? 1
        : Math.min(MAX_CATCH_UP_BARS, Math.ceil(everySeconds / barSeconds) + 1);
    // shortcut: capped so one fetch stays bounded; a scanner down for longer skips the rest.
    return Math.min(MAX_CATCH_UP_BARS, Math.ceil((settledMs / 1000 - since) / barSeconds) + 1);
  };

  /** Save a signal bar once. Returns null when it was already saved. */
  const record = (symbol: string, bar: DeskSignalBar, history: Candle[], at: number) => {
    const buy = bar.signal === "BUY";
    const prior = history.slice(-1 - params.breakoutLookback, -1);
    const avgVol = volumeSma(history.slice(0, -1), params.volumeLookback).at(-1)?.value;
    const swingStop = bar.swingLow != null && bar.swingLow < bar.close;
    const detail = {
      close: bar.close,
      breakoutLookback: params.breakoutLookback,
      breakoutLevel: buy
        ? Math.max(...prior.map((c) => c.high))
        : Math.min(...prior.map((c) => c.low)),
      volumeRatio: avgVol ? (history.at(-1)?.volume ?? 0) / avgVol : null,
      rsi: bar.rsi,
      atr: bar.atr,
      trend: bar.trend,
      swingHigh: bar.swingHigh,
      swingLow: bar.swingLow,
      // Same stop rule as the backtest.
      stop: swingStop ? bar.swingLow : bar.atr != null ? bar.close - 2 * bar.atr : null,
      stopFrom: swingStop ? "last swing low" : "2x ATR",
    };
    // Checked now, not at the pass start: an earlier webhook's retries can take minutes.
    const approved = store.isApproved(symbol, now());
    const webhook = !webhooks ? "no webhooks" : approved ? "pending" : "not approved";
    const saved = store.recordSignal(
      { symbol, timeframe, barTime: bar.time, signal: bar.signal!, detail, webhook },
      at,
    );
    if (saved)
      store.addJournal(
        {
          agent: "scanner",
          ticker: symbol,
          action: "signal",
          entry: bar.close,
          stop: detail.stop,
          reason: `${bar.signal} on ${timeframe}`,
          evidence: handoffText(saved).split(" | ")[2],
          outcome: webhook,
        },
        at,
      );
    if (saved)
      log(`${symbol} ${bar.signal} on ${new Date(bar.time * 1000).toISOString()} (${webhook})`);
    return saved;
  };

  /** One pass over the watchlist. Returns the signals that are new. */
  const scanOnce = async (): Promise<SignalRecord[]> => {
    const at = now();
    const settled = at - config.scanner.settleMinutes * 60_000;
    const found: SignalRecord[] = [];
    // Sent in parallel and awaited at the end, so a slow receiver never delays the next symbol.
    const sending: Promise<void>[] = [];
    for (const symbol of symbols) {
      try {
        const { bars, candles } = await deskSignalBars(
          deps,
          symbol,
          timeframe,
          barsToCheck(symbol, settled),
          settled,
        );
        lastError.delete(symbol);
        const since = lastChecked.get(symbol) ?? -Infinity;
        const newest = bars.at(-1)?.time;
        if (newest != null) lastChecked.set(symbol, Math.max(newest, since));
        for (let k = 0; k < bars.length; k++) {
          const bar = bars[k]!;
          if (!bar.signal || bar.time <= since) continue;
          // This bar and the candles before it, for the evidence.
          const history = candles.slice(0, candles.length - bars.length + k + 1);
          const saved = record(symbol, bar, history, at);
          // shortcut: a crash mid-send leaves the signal "pending" and it is not resent; resend on start if that matters.
          if (saved?.webhook === "pending") sending.push(
              send(saved).catch((err: unknown) =>
                log(`${symbol}: webhook not recorded: ${err instanceof Error ? err.message : String(err)}`),
              ),
            );
          if (saved) found.push(saved);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (lastError.get(symbol) !== message) log(`${symbol}: ${message}`);
        lastError.set(symbol, message);
      }
    }
    await Promise.all(sending);
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

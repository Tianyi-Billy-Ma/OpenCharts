import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_DESK_SIGNAL_PARAMS, type DeskSignalParams } from "../src/lib/desk-signal.ts";

/**
 * Everything user-specific lives in `opencharts.config.ts` at the repo root.
 * Secrets never go here: they come from the environment (`.env`).
 */
export interface OpenChartsConfig {
  /** Port the backend listens on. It binds to 127.0.0.1 unless `host` says otherwise. */
  port: number;
  host: string;
  watchlist: {
    /** US stock and ETF tickers, e.g. "NVDA". */
    stocks: string[];
    /** Alpaca crypto pairs, e.g. "BTC/USD". */
    crypto: string[];
  };
  deskSignal: {
    /** Bar size the signal runs on, e.g. "1d", "4h", "1h". Always evaluated on closed bars. */
    timeframe: string;
    params: DeskSignalParams;
  };
  approvals: {
    /** How long a Risk Officer approval lasts when no end date is given. Stocks skip weekends. */
    tradingDays: number;
  };
  scanner: {
    /** Check the watchlist for new Desk Signals. */
    enabled: boolean;
    /** How often to check, in minutes. */
    everyMinutes: number;
    /** Wait this long after a bar closes, so its final values are published. */
    settleMinutes: number;
  };
  /** SQLite file for approvals, signals and (later) the journal. */
  dataPath: string;
}

export const DEFAULT_CONFIG: OpenChartsConfig = {
  port: 8787,
  host: "127.0.0.1",
  watchlist: {
    stocks: ["NVDA", "MSFT", "GOOGL", "AMZN", "META", "AMD", "AVGO", "TSM", "PLTR"],
    crypto: ["BTC/USD", "ETH/USD", "SOL/USD"],
  },
  deskSignal: { timeframe: "1d", params: DEFAULT_DESK_SIGNAL_PARAMS },
  approvals: { tradingDays: 5 },
  scanner: { enabled: true, everyMinutes: 5, settleMinutes: 10 },
  dataPath: "data/opencharts.db",
};

/** Load `opencharts.config.ts` (or the path in OPENCHARTS_CONFIG) over the defaults. */
export async function loadConfig(path = process.env.OPENCHARTS_CONFIG): Promise<OpenChartsConfig> {
  const file = resolve(path ?? "opencharts.config.ts");
  if (!existsSync(file)) return DEFAULT_CONFIG;
  const mod = (await import(pathToFileURL(file).href)) as { default?: Partial<OpenChartsConfig> };
  const user = (mod.default ?? {}) as Omit<Partial<OpenChartsConfig>, "deskSignal"> & {
    deskSignal?: { timeframe?: string; params?: Partial<DeskSignalParams> };
  };
  return {
    ...DEFAULT_CONFIG,
    ...user,
    watchlist: { ...DEFAULT_CONFIG.watchlist, ...user.watchlist },
    approvals: { ...DEFAULT_CONFIG.approvals, ...user.approvals },
    scanner: { ...DEFAULT_CONFIG.scanner, ...user.scanner },
    deskSignal: {
      timeframe: user.deskSignal?.timeframe ?? DEFAULT_CONFIG.deskSignal.timeframe,
      params: { ...DEFAULT_CONFIG.deskSignal.params, ...user.deskSignal?.params },
    },
  };
}

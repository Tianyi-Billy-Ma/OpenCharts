import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Loaded this way because Vite (tests) cannot resolve "node:sqlite" yet.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/**
 * The backend's SQLite database, the source of truth for approvals and
 * Desk Signal events (and, in later milestones, the journal). One file, `data/opencharts.db`
 * by default; ":memory:" for tests.
 */

export interface Approval {
  ticker: string;
  /** Epoch ms; the approval is live while now < until. */
  until: number;
  approvedAt: number;
}

export interface SignalRecord {
  id: number;
  symbol: string;
  timeframe: string;
  /** Bar open time, epoch seconds. */
  barTime: number;
  signal: "BUY" | "SELL";
  /** The numbers behind the signal, as sent in the webhook. */
  detail: Record<string, unknown>;
  createdAt: number;
  /** "pending", "sent", "failed", "not approved" or "no webhooks". */
  webhook: string;
  /** Per-receiver results, hosts only (webhook URLs can hold secrets). */
  deliveries: Array<{ host: string; ok: boolean; attempts: number; error?: string }>;
}

export interface Store {
  /** Saves a new signal. Returns null when this symbol, timeframe and bar is already saved. */
  recordSignal(
    s: Pick<SignalRecord, "symbol" | "timeframe" | "barTime" | "signal" | "detail" | "webhook">,
    nowMs?: number,
  ): SignalRecord | null;
  setWebhookResult(id: number, webhook: string, deliveries: SignalRecord["deliveries"]): void;
  /** Newest first. */
  listSignals(options?: { symbol?: string; limit?: number }): SignalRecord[];
  setApproval(ticker: string, until: number, nowMs?: number): Approval;
  /** True when there was a live approval to revoke. */
  revokeApproval(ticker: string, nowMs?: number): boolean;
  /** Live approvals, soonest to expire first. */
  listApprovals(nowMs?: number): Approval[];
  isApproved(ticker: string, nowMs?: number): boolean;
  close(): void;
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      ticker TEXT PRIMARY KEY,
      until_ms INTEGER NOT NULL,
      approved_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      bar_time INTEGER NOT NULL,
      signal TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      webhook TEXT NOT NULL,
      deliveries TEXT NOT NULL DEFAULT '[]',
      UNIQUE (symbol, timeframe, bar_time)
    );
  `);
  // The UNIQUE key is the webhook dedupe: one POST per ticker per bar.
  const insertSignal = db.prepare(
    `INSERT INTO signals (symbol, timeframe, bar_time, signal, detail, created_ms, webhook)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const updateWebhook = db.prepare(`UPDATE signals SET webhook = ?, deliveries = ? WHERE id = ?`);
  const recent = db.prepare(
    `SELECT * FROM signals WHERE (? IS NULL OR symbol = ?) ORDER BY bar_time DESC, id DESC LIMIT ?`,
  );
  const toSignal = (r: Record<string, unknown>): SignalRecord => ({
    id: Number(r.id),
    symbol: String(r.symbol),
    timeframe: String(r.timeframe),
    barTime: Number(r.bar_time),
    signal: r.signal as SignalRecord["signal"],
    detail: JSON.parse(String(r.detail)) as Record<string, unknown>,
    createdAt: Number(r.created_ms),
    webhook: String(r.webhook),
    deliveries: JSON.parse(String(r.deliveries)) as SignalRecord["deliveries"],
  });
  const upsert = db.prepare(
    `INSERT INTO approvals (ticker, until_ms, approved_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (ticker) DO UPDATE SET until_ms = excluded.until_ms, approved_at_ms = excluded.approved_at_ms`,
  );
  // Revoking ends the approval now, keeping the row as a record.
  const revoke = db.prepare(`UPDATE approvals SET until_ms = ? WHERE ticker = ? AND until_ms > ?`);
  const live = db.prepare(
    `SELECT ticker, until_ms, approved_at_ms FROM approvals WHERE until_ms > ? ORDER BY until_ms`,
  );
  const one = db.prepare(`SELECT 1 FROM approvals WHERE ticker = ? AND until_ms > ?`);

  return {
    recordSignal(s, nowMs = Date.now()) {
      const result = insertSignal.run(
        s.symbol,
        s.timeframe,
        s.barTime,
        s.signal,
        JSON.stringify(s.detail),
        nowMs,
        s.webhook,
      );
      if (Number(result.changes) === 0) return null;
      return { ...s, id: Number(result.lastInsertRowid), createdAt: nowMs, deliveries: [] };
    },
    setWebhookResult(id, webhook, deliveries) {
      updateWebhook.run(webhook, JSON.stringify(deliveries), id);
    },
    listSignals({ symbol, limit = 50 } = {}) {
      return recent.all(symbol ?? null, symbol ?? null, limit).map(toSignal);
    },
    setApproval(ticker, until, nowMs = Date.now()) {
      upsert.run(ticker, until, nowMs);
      return { ticker, until, approvedAt: nowMs };
    },
    revokeApproval(ticker, nowMs = Date.now()) {
      return Number(revoke.run(nowMs, ticker, nowMs).changes) > 0;
    },
    listApprovals(nowMs = Date.now()) {
      return live.all(nowMs).map((r) => ({
        ticker: String(r.ticker),
        until: Number(r.until_ms),
        approvedAt: Number(r.approved_at_ms),
      }));
    },
    isApproved(ticker, nowMs = Date.now()) {
      return one.get(ticker, nowMs) !== undefined;
    },
    close: () => db.close(),
  };
}

/**
 * `days` trading days after `fromMs`, at the same time of day. Stocks skip
 * weekends; crypto trades every day.
 * shortcut: ignores US market holidays, so a holiday week ends a day late; add a holiday list if that matters.
 */
export function addTradingDays(fromMs: number, days: number, crypto: boolean): number {
  const d = new Date(fromMs);
  for (let left = days; left > 0; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    const weekday = d.getUTCDay();
    if (crypto || (weekday !== 0 && weekday !== 6)) left--;
  }
  return d.getTime();
}

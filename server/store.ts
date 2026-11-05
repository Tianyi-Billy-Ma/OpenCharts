import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Loaded this way because Vite (tests) cannot resolve "node:sqlite" yet.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/**
 * The backend's SQLite database, the source of truth for approvals and
 * Desk Signal events and the journal. One file, `data/opencharts.db`
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

/** One journal row: who did what, to which ticker, and why. */
export interface JournalEntry {
  id: number;
  time: number;
  /** "risk", "trader", "desk", "scanner", "guard" or a bot's own name. */
  agent: string;
  ticker: string;
  /** e.g. "idea", "approve", "reject", "signal", "webhook", "order", "stop", "alert". */
  action: string;
  size: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  reason: string;
  evidence: string;
  outcome: string;
}

export type NewJournalEntry = Partial<Omit<JournalEntry, "id" | "time">> &
  Pick<JournalEntry, "agent" | "action">;

export const JOURNAL_COLUMNS = [
  "id",
  "time",
  "agent",
  "ticker",
  "action",
  "size",
  "entry",
  "stop",
  "target",
  "reason",
  "evidence",
  "outcome",
] as const;

export interface Store {
  addJournal(entry: NewJournalEntry, nowMs?: number): JournalEntry;
  /** Newest first. */
  listJournal(options?: { ticker?: string; action?: string; limit?: number }): JournalEntry[];
  /**
   * The newest planned stop for a ticker: a BUY our desk placed, or a Trader "plan" row.
   * Only plans after the ticker was last closed through the journal (a SELL or a guard
   * flatten) and after `sinceMs` count, so an old trade's stop is never reused.
   */
  plannedStop(ticker: string, sinceMs?: number): number | null;
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
    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY,
      time_ms INTEGER NOT NULL,
      agent TEXT NOT NULL,
      ticker TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      size REAL, entry REAL, stop REAL, target REAL,
      reason TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT ''
    );
  `);
  const insertJournal = db.prepare(
    `INSERT INTO journal (time_ms, agent, ticker, action, size, entry, stop, target, reason, evidence, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const journalRows = db.prepare(
    `SELECT * FROM journal WHERE (? IS NULL OR ticker = ?) AND (? IS NULL OR action = ?)
     ORDER BY time_ms DESC, id DESC LIMIT ?`,
  );
  const plannedStopRow = db.prepare(
    `SELECT stop FROM journal
     WHERE ticker = ? AND stop IS NOT NULL
       AND (action = 'plan' OR (action = 'order' AND reason LIKE 'BUY%' AND outcome LIKE 'placed%'))
       AND time_ms > MAX(?, COALESCE((SELECT MAX(time_ms) FROM journal WHERE ticker = ?
         AND (action = 'flatten' OR (action = 'order' AND reason LIKE 'SELL%' AND outcome LIKE 'closed%'))), 0))
     ORDER BY time_ms DESC, id DESC LIMIT 1`,
  );
  const num = (v: unknown) => (v == null ? null : Number(v));
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
    addJournal(e, nowMs = Date.now()) {
      const row = {
        agent: e.agent,
        ticker: e.ticker ?? "",
        action: e.action,
        size: e.size ?? null,
        entry: e.entry ?? null,
        stop: e.stop ?? null,
        target: e.target ?? null,
        reason: e.reason ?? "",
        evidence: e.evidence ?? "",
        outcome: e.outcome ?? "",
      };
      const result = insertJournal.run(
        nowMs,
        row.agent,
        row.ticker,
        row.action,
        row.size,
        row.entry,
        row.stop,
        row.target,
        row.reason,
        row.evidence,
        row.outcome,
      );
      return { id: Number(result.lastInsertRowid), time: nowMs, ...row };
    },
    plannedStop(ticker, sinceMs = 0) {
      const row = plannedStopRow.get(ticker, sinceMs, ticker);
      return row ? Number(row.stop) : null;
    },
    listJournal({ ticker, action, limit = 100 } = {}) {
      return journalRows
        .all(ticker ?? null, ticker ?? null, action ?? null, action ?? null, limit)
        .map((r) => ({
          id: Number(r.id),
          time: Number(r.time_ms),
          agent: String(r.agent),
          ticker: String(r.ticker),
          action: String(r.action),
          size: num(r.size),
          entry: num(r.entry),
          stop: num(r.stop),
          target: num(r.target),
          reason: String(r.reason),
          evidence: String(r.evidence),
          outcome: String(r.outcome),
        }));
    },
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

/** The journal as CSV, oldest first, with times in ISO 8601. */
export function journalCsv(entries: JournalEntry[]): string {
  const cell = (v: unknown) => {
    const text = v == null ? "" : String(v);
    // Quote when needed, and defuse spreadsheet formulas (=, +, -, @).
    const safe = /^[=+\-@\t\r]/.test(text) && typeof v !== "number" ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = [...entries]
    .reverse()
    .map((e) =>
      JOURNAL_COLUMNS.map((c) => cell(c === "time" ? new Date(e.time).toISOString() : e[c])).join(
        ",",
      ),
    );
  return [JOURNAL_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
